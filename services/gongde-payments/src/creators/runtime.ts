import type { IncomingMessage, ServerResponse } from "node:http";
import { loadCreatorPhoneAuthConfiguration, loadFreeCreatorConfiguration } from "./configuration.js";
import { FreeCreatorService } from "./free-service.js";
import { CreatorSourceStore } from "./object-store.js";
import { FreeCreatorRepository, type CreatorPublicationObserver } from "./repository.js";
import { createFreeCreatorRouter, creatorSessionToken } from "./router.js";
import { CreatorError } from "./types.js";
import type { AppearancePackSigner } from "../delivery/pack-signer.js";
import type { GongdeEntitlement, MarketOrderItem } from "../domain/types.js";
import { CreatorPhoneAuth, disabledCreatorPhoneAuthStatus } from "./phone-auth.js";
import { FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_AI_TERMS_VERSION } from "./consent.js";
import type { FreeBatchSelection } from "./free-batch-delivery.js";

export function createFreeCreatorRuntime(requireAdmin: (request: IncomingMessage) => string, deliveryAvailable = false) {
  let service: FreeCreatorService | null = null;
  let phoneAuth: CreatorPhoneAuth | null = null;
  let configurationError = false;
  let paidDownloadsEnabled = false;
  let route: ReturnType<typeof createFreeCreatorRouter> | null = null;
  const distributionEnabled = process.env.GONGDE_FREE_DISTRIBUTION_ENABLED === "true";
  let distributionReadiness: (() => Promise<boolean>) | null = null;
  let closing = false;
  try {
    const configuration = loadFreeCreatorConfiguration();
    if (configuration) {
      paidDownloadsEnabled = configuration.paidDownloadsEnabled;
      service = new FreeCreatorService(new FreeCreatorRepository(configuration.database), new CreatorSourceStore(configuration.storage));
      phoneAuth = new CreatorPhoneAuth(loadCreatorPhoneAuthConfiguration(), service.repository);
      if (!distributionEnabled) service.enableAutomaticReview();
      route = createFreeCreatorRouter(configuration, service, request => {
        try { return requireAdmin(request); }
        catch (error) {
          const message = error instanceof Error ? error.message : "";
          throw new CreatorError(message === "admin_auth_required" ? "creator_admin_auth_required" : "creator_admin_unavailable",
            message === "admin_auth_required" ? 401 : 503);
        }
      }, phoneAuth);
    }
  } catch {
    // A community configuration error must not take down official purchases.
    configurationError = true;
    process.stderr.write(JSON.stringify({ scope: "gongde-creators", event: "configuration_unavailable" }) + "\n");
  }
  let readyUntil = 0;
  let readyCheck: Promise<boolean> | null = null;
  const ready = async () => {
    if (!service || closing) return false;
    if (distributionEnabled && (!distributionReadiness || !await distributionReadiness())) return false;
    if (!readyCheck || Date.now() >= readyUntil) {
      readyUntil = Date.now() + 5000;
      readyCheck = service.repository.ready();
    }
    const available = await readyCheck;
    if (closing) return false;
    if (available && distributionEnabled) service.enableAutomaticReview();
    return available;
  };
  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff" });
    response.end(JSON.stringify(value));
  };
  return {
    get service() { return service; },
    setFreeDistributionReadiness(check: () => Promise<boolean>) {
      distributionReadiness = check;
      readyUntil = 0;
      void ready().catch(() => {});
    },
    async requireAccount(request: IncomingMessage | string) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.requireAccount(typeof request === "string" ? request : creatorSessionToken(request));
    },
    async publicWorks(offset = 0) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.publicWorks(offset);
    },
    async publicWork(workId: string) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.publicWork(workId);
    },
    async preview(versionId: string, access: { audience: "public" | "admin" | "creator"; creatorId?: string }) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.preview(versionId, access);
    },
    async image(versionId: string, name: string, access: { audience: "public" | "admin" | "creator"; creatorId?: string }) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.image(versionId, name, access);
    },
    async getIntegration() {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return { service, repository: service.repository, objects: service.objects };
    },
    setPublicationObserver(observer: CreatorPublicationObserver) {
      if (!service) throw new CreatorError("creator_service_unavailable", 503);
      service.repository.setPublicationObserver(observer);
    },
    async resolveFreeWorks(ids: readonly string[], previewRevisions?: Record<string, unknown>) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.resolveFreeWorks(ids, previewRevisions);
    },
    async loadFrozenSource(selection: FreeBatchSelection) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.loadFrozenSource(selection);
    },
    async numberWork(workId: string, admin: boolean) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      if (admin) {
        const work = await service.repository.adminNumberWork(workId);
        return { appearanceNumber: work.appearanceNumber, titleZh: work.metadata.titleZh, state: work.state };
      }
      const work = await service.publicWork(workId);
      return { appearanceNumber: work.appearanceNumber, titleZh: work.metadata!.titleZh, state: "PUBLISHED" };
    },
    async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
      if (!/^\/api\/gongde\/(?:creators|community|admin\/creators)(?:\/|$)/u.test(url.pathname)) return false;
      if (request.method === "GET" && url.pathname === "/api/gongde/community/status") {
        const isReady = await ready();
        respond(response, configurationError ? 503 : 200, {
          enabled: service !== null, ready: isReady, freeBatchDelivery: false,
          paidBatchDelivery: deliveryAvailable && paidDownloadsEnabled && isReady,
          reviewMode: service?.reviewMode ?? "disabled",
          phoneAuth: phoneAuth ? await phoneAuth.status() : disabledCreatorPhoneAuthStatus(
            configurationError ? "configuration_unavailable" : "disabled"),
          termsVersion: FREE_CREATOR_TERMS_VERSION, aiTermsVersion: FREE_CREATOR_AI_TERMS_VERSION,
          maxItems: 10, maxBatchBytes: 16 * 1024 * 1024
        });
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/gongde/creators/phone/status") {
        respond(response, 200, phoneAuth ? await phoneAuth.status() : disabledCreatorPhoneAuthStatus(
          configurationError ? "configuration_unavailable" : "disabled"));
        return true;
      }
      if (!route || !await ready()) {
        respond(response, 503, { error: configurationError ? "creator_configuration_unavailable" :
          service ? "creator_service_unavailable" : "creator_disabled" });
        return true;
      }
      return route(request, response, url);
    },
    async resolvePaidWorks(ids: readonly string[], previewRevisions: Record<string, unknown>) {
      if (!service || !deliveryAvailable || !paidDownloadsEnabled || !await ready()) {
        throw new CreatorError("creator_paid_sales_not_ready", 503);
      }
      return service.resolvePaidWorks(ids, previewRevisions);
    },
    async authorizePaidItems(items: readonly MarketOrderItem[]): Promise<void> {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      await service.authorizePaidItems(items);
    },
    async buildPaidPack(item: MarketOrderItem, delivery: GongdeEntitlement, signer: AppearancePackSigner) {
      if (!service || !await ready()) throw new CreatorError("creator_service_unavailable", 503);
      return service.buildPaidPack(item, delivery, signer);
    },
    async close(): Promise<void> {
      closing = true;
      try { await phoneAuth?.close(); } finally { if (service) await service.close(); }
    }
  };
}
