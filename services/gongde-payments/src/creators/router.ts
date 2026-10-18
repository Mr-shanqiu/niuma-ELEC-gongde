import type { IncomingMessage, ServerResponse } from "node:http";
import type { FreeCreatorConfiguration } from "./configuration.js";
import { FreeCreatorService, FREE_CREATOR_TERMS, FREE_CREATOR_TERMS_VERSION, FREE_CREATOR_AI_TERMS,
  FREE_CREATOR_AI_TERMS_VERSION, FREE_CREATOR_TERMS_SHA256, FREE_CREATOR_AI_TERMS_SHA256 } from "./free-service.js";
import { CREATOR_UPLOAD_LIMITS } from "./policy.js";
import { CreatorError } from "./types.js";
import { creatorClientKey } from "./client-key.js";
import { CREATOR_REMEMBER_SESSION_SECONDS, creatorRememberMe, creatorSessionExpiry, creatorTokenDigest } from "./auth.js";
import { disabledCreatorPhoneAuthStatus, type CreatorPhoneAuth } from "./phone-auth.js";

const cookieName = "gongde_creator_session";
const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];
  return typeof value === "string" ? value : "";
};
const sessionToken = (request: IncomingMessage) =>
  header(request, "cookie").split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
export { sessionToken as creatorSessionToken };

async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = header(request, "content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new CreatorError("creator_request_too_large", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > maximum) throw new CreatorError("creator_request_too_large", 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (header(request, "content-type").split(";")[0].trim() !== "application/json") {
    throw new CreatorError("creator_json_required", 415);
  }
  try {
    const parsed: unknown = JSON.parse((await body(request, 16384)).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CreatorError("creator_request_invalid");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CreatorError) throw error;
    throw new CreatorError("creator_request_invalid");
  }
}

function json(response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", ...extra });
  response.end(JSON.stringify(value));
}

export function createFreeCreatorRouter(configuration: FreeCreatorConfiguration, service: FreeCreatorService,
  requireAdmin: (request: IncomingMessage) => string, phoneAuth?: CreatorPhoneAuth) {
  const sessionCookie = (token: string, clear = false, rememberMe = true) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${clear ? "; Max-Age=0" :
      rememberMe ? `; Max-Age=${CREATOR_REMEMBER_SESSION_SECONDS}` : ""}${configuration.secureCookie ? "; Secure" : ""}`;
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    const creatorPrefix = "/api/gongde/creators";
    const adminPrefix = "/api/gongde/admin/creators";
    const communityPrefix = "/api/gongde/community";
    const owned = path === creatorPrefix || path.startsWith(`${creatorPrefix}/`);
    const admin = path === adminPrefix || path.startsWith(`${adminPrefix}/`);
    const community = path === communityPrefix || path.startsWith(`${communityPrefix}/`);
    if (!owned && !admin && !community) return false;
    try {
      const method = request.method ?? "";
      if (!["GET", "POST", "PATCH"].includes(method)) throw new CreatorError("creator_method_not_allowed", 405);
      if (method !== "GET" && (header(request, "origin") !== configuration.publicOrigin ||
          header(request, "sec-fetch-site") === "cross-site")) throw new CreatorError("creator_origin_required", 403);
      const clientKey = creatorClientKey(request, configuration.trustedProxyAddresses);
      await service.repository.consumeLimit("http", clientKey, 600, 60);
      const respond = (value: unknown, status = 200, extra: Record<string, string> = {}) => {
        json(response, status, value, extra); return true;
      };
      const offset = () => {
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,4}$/u.test(raw)) throw new CreatorError("creator_page_invalid");
        return Number(raw);
      };
      if (path === `${creatorPrefix}/terms` && method === "GET") {
        return respond({ version: FREE_CREATOR_TERMS_VERSION, text: FREE_CREATOR_TERMS,
          sha256: FREE_CREATOR_TERMS_SHA256, aiVersion: FREE_CREATOR_AI_TERMS_VERSION,
          aiText: FREE_CREATOR_AI_TERMS, aiSha256: FREE_CREATOR_AI_TERMS_SHA256 });
      }
      if (path === `${creatorPrefix}/phone/status` && method === "GET") {
        return respond(phoneAuth ? await phoneAuth.status() : disabledCreatorPhoneAuthStatus());
      }
      if (path === `${creatorPrefix}/phone/code` && method === "POST") {
        if (!phoneAuth) throw new CreatorError("creator_phone_auth_unavailable", 503);
        return respond(await phoneAuth.requestCode(await jsonBody(request), clientKey));
      }
      if (path === `${creatorPrefix}/phone/login` && method === "POST") {
        if (!phoneAuth) throw new CreatorError("creator_phone_auth_unavailable", 503);
        const result = await phoneAuth.login(await jsonBody(request), clientKey);
        return respond({ account: { ...service.account(result.account), phoneBound: true }, expiresAt: result.expiresAt,
          rememberMe: result.rememberMe, created: result.created }, result.created ? 201 : 200,
        { "set-cookie": sessionCookie(result.sessionToken, false, result.rememberMe) });
      }
      if (path === `${creatorPrefix}/phone/bind` && method === "POST") {
        if (!phoneAuth) throw new CreatorError("creator_phone_auth_unavailable", 503);
        const token = sessionToken(request), account = await service.requireAccount(token);
        return respond(await phoneAuth.bind(account.creatorId, creatorTokenDigest(token), await jsonBody(request), clientKey));
      }
      if (path === `${creatorPrefix}/register` && method === "POST") {
        const raw = await jsonBody(request), rememberMe = creatorRememberMe(raw.rememberMe);
        const { rememberMe: _remember, ...credentials } = raw;
        const { sessionToken: token, ...result } = await service.register(credentials, clientKey);
        const expiresAt = creatorSessionExpiry(rememberMe);
        await service.repository.setSessionExpiry(creatorTokenDigest(token), expiresAt);
        return respond({ ...result, expiresAt: expiresAt.toISOString(), rememberMe }, 201,
          { "set-cookie": sessionCookie(token, false, rememberMe) });
      }
      if (path === `${creatorPrefix}/login` && method === "POST") {
        const raw = await jsonBody(request), rememberMe = creatorRememberMe(raw.rememberMe);
        const { rememberMe: _remember, ...credentials } = raw;
        const { sessionToken: token, ...result } = await service.login(credentials, clientKey);
        const expiresAt = creatorSessionExpiry(rememberMe);
        await service.repository.setSessionExpiry(creatorTokenDigest(token), expiresAt);
        return respond({ ...result, expiresAt: expiresAt.toISOString(), rememberMe }, 200,
          { "set-cookie": sessionCookie(token, false, rememberMe) });
      }
      if (path === `${creatorPrefix}/recover` && method === "POST") {
        return respond(await service.recover(await jsonBody(request), clientKey), 200, { "set-cookie": sessionCookie("", true) });
      }
      if (path === `${creatorPrefix}/logout` && method === "POST") {
        await service.logout(sessionToken(request));
        return respond({ ok: true }, 200, { "set-cookie": sessionCookie("", true) });
      }
      const imageMatch = path.match(/^\/api\/gongde\/(creators|community|admin\/creators)\/versions\/([a-f0-9]{32})\/images\/([a-z0-9][a-z0-9_-]{0,59}\.png)$/u);
      if (imageMatch && method === "GET") {
        let creatorId: string | undefined;
        if (admin) requireAdmin(request);
        else if (owned) creatorId = (await service.requireAccount(sessionToken(request))).creatorId;
        const bytes = await service.image(imageMatch[2], imageMatch[3], {
          audience: admin ? "admin" : owned ? "creator" : "public", creatorId
        });
        response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length,
          "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
        response.end(bytes); return true;
      }
      if (community) {
        if (path === `${communityPrefix}/batches` && method === "POST") {
          // New claims belong to the code-authorized v2 distribution service.
          throw new CreatorError("creator_free_delivery_retired", 410);
        }
        if (path === `${communityPrefix}/works` && method === "GET") return respond({ works: await service.publicWorks(offset()) });
        const match = path.match(/^\/api\/gongde\/community\/works\/(creator\.[a-f0-9]{32}\.[a-z0-9][a-z0-9-]{0,31})(\/report)?$/u);
        if (match && !match[2] && method === "GET") return respond(await service.publicWork(match[1]));
        if (match?.[2] && method === "POST") return respond(await service.report(match[1], await jsonBody(request), clientKey), 201);
      } else if (admin) {
        const actor = requireAdmin(request);
        if (path === `${adminPrefix}/reviews` && method === "GET") {
          const state = url.searchParams.get("state") ?? "PENDING";
          if (!["PENDING", "APPROVED", "REJECTED"].includes(state)) throw new CreatorError("creator_review_state_invalid");
          return respond({ reviews: await service.repository.reviews(state, offset()) });
        }
        if (path === `${adminPrefix}/works` && method === "GET") {
          const state = url.searchParams.get("state") ?? "PUBLISHED";
          if (!["DRAFT", "PUBLISHED", "UNPUBLISHED", "SUSPENDED"].includes(state)) throw new CreatorError("creator_work_state_invalid");
          return respond({ works: await service.repository.adminWorks(state, offset()) });
        }
        if (path === `${adminPrefix}/complaints` && method === "GET") {
          const state = url.searchParams.get("state") ?? "OPEN";
          if (!["OPEN", "RESOLVED", "DISMISSED"].includes(state)) throw new CreatorError("creator_complaint_state_invalid");
          return respond({ complaints: await service.repository.complaints(state, offset()) });
        }
        const complaintMatch = path.match(/^\/api\/gongde\/admin\/creators\/complaints\/([a-f0-9]{32})\/decision$/u);
        if (complaintMatch && method === "POST") {
          const raw = await jsonBody(request);
          if ((raw.outcome !== "SUSPEND" && raw.outcome !== "DISMISS") || typeof raw.reason !== "string" ||
              raw.reason.trim().length < 5 || raw.reason.length > 1000) throw new CreatorError("creator_complaint_decision_invalid");
          await service.repository.decideComplaint(actor, complaintMatch[1], raw.outcome, raw.reason.trim());
          return respond({ ok: true });
        }
        const versionMatch = path.match(/^\/api\/gongde\/admin\/creators\/versions\/([a-f0-9]{32})$/u);
        if (versionMatch && method === "GET") return respond(await service.reviewPreview(versionMatch[1]));
        const reviewMatch = path.match(/^\/api\/gongde\/admin\/creators\/reviews\/([a-f0-9]{32})\/decision$/u);
        if (reviewMatch && method === "POST") {
          await service.decide(actor, reviewMatch[1], await jsonBody(request)); return respond({ ok: true });
        }
        const workMatch = path.match(/^\/api\/gongde\/admin\/creators\/works\/(creator\.[a-f0-9]{32}\.[a-z0-9][a-z0-9-]{0,31})\/(unpublish|suspend)$/u);
        if (workMatch && method === "POST") {
          const raw = await jsonBody(request);
          if (typeof raw.reason !== "string" || raw.reason.trim().length < 5 || raw.reason.length > 1000) throw new CreatorError("creator_review_reason_required");
          await service.repository.unpublish(workMatch[1], "admin", actor, workMatch[2] === "suspend", raw.reason.trim());
          return respond({ ok: true });
        }
      } else {
        const account = await service.requireAccount(sessionToken(request));
        await service.repository.consumeLimit("account-http", account.creatorId, 200, 60);
        if (path === `${creatorPrefix}/session` && method === "GET") return respond({ account: {
          ...service.account(account), phoneBound: await service.repository.phoneBound(account.creatorId) } });
        if (path === `${creatorPrefix}/works` && method === "GET") return respond({ works: await service.repository.ownedWorks(account.creatorId) });
        if (path === `${creatorPrefix}/works` && method === "POST") return respond(await service.createWork(account, await jsonBody(request)), 201);
        const match = path.match(/^\/api\/gongde\/creators\/works\/(creator\.[a-f0-9]{32}\.[a-z0-9][a-z0-9-]{0,31})(?:\/(versions|upload|unpublish|republish|submit|withdraw|free-consent))?$/u);
        if (match) {
          const workId = match[1], action = match[2];
          if (!action && method === "GET") return respond(await service.repository.ownedWork(account.creatorId, workId));
          if (!action && method === "PATCH") return respond(await service.updateWork(account, workId, await jsonBody(request)));
          if (action === "versions" && method === "GET") return respond({ versions: await service.versions(account, workId) });
          if (action === "upload" && method === "POST") {
            if (header(request, "content-type").split(";")[0].trim() !== "application/octet-stream") throw new CreatorError("creator_binary_required", 415);
            return respond(await service.upload(account, workId, await body(request, CREATOR_UPLOAD_LIMITS.archiveBytes)), 201);
          }
          if (action === "submit" && method === "POST") {
            const raw = await jsonBody(request);
            if (typeof raw.versionId !== "string") throw new CreatorError("creator_version_invalid");
            return respond(await service.submit(account, workId, raw.versionId, raw));
          }
          if (action === "unpublish" && method === "POST") {
            await service.repository.unpublish(workId, "creator", account.creatorId); return respond({ ok: true });
          }
          if (action === "withdraw" && method === "POST") {
            await service.withdraw(account, workId); return respond({ ok: true });
          }
          if (action === "free-consent" && method === "POST") {
            return respond(await service.grantFreeConsent(account, workId, await jsonBody(request)));
          }
          if (action === "republish" && method === "POST") {
            await service.republish(account, workId); return respond({ ok: true });
          }
        }
      }
      return respond({ error: "creator_route_not_found" }, 404);
    } catch (error) {
      // Database, SDK and credential error messages must not leak to browsers.
      if (error instanceof CreatorError) json(response, error.status, { error: error.code,
        ...((error.field && /^[a-zA-Z0-9_.\[\]-]{1,120}$/u.test(error.field)) ? { field: error.field } : {}) },
        error.status === 429 ? { "retry-after": "60" } : {});
      else if ((error as { code?: string })?.code === "ER_DUP_ENTRY") json(response, 409, { error: "creator_record_exists" });
      else json(response, 503, { error: "creator_service_unavailable" });
      return true;
    }
  };
}
