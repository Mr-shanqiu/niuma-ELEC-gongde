#!/usr/bin/env node
/**
 * PREPARATION ARTIFACT, not an executed end-to-end test.
 *
 * After Main has initialized its approved LOCAL MySQL 8.4 schema:
 *   GONGDE_CREATOR_LOCAL_MYSQL_APPROVED=1 \
 *   GONGDE_CREATOR_LOCAL_MYSQL_URL='mysql://LOCAL_USER:FICTIONAL_PASSWORD@127.0.0.1:HIGH_PORT/gongde_creator_local_deadbeef' \
 *   node --max-old-space-size=192 services/gongde-payments/tests/free-creator-browser.local.mjs
 *
 * No Docker, installation, build, DDL, migration, dotenv, server.ts, payment runtime,
 * real admin secrets or real COS are used. Main owns DB lifecycle and browser testing.
 * One bootstrap account is registered THROUGH the real compiled HTTP router. Its
 * real SQL rows/hash/agreement/session/audit are not inserted or state-faked here.
 * Bootstrap consumes one actual per-IP registration quota. Further signups obey it.
 *
 * Startup stdout: one JSON record containing loopback URLs, this PID and fictional
 * creator/admin credentials only. DB URL/password and creator session/recovery tokens
 * are never printed. /__local/source-pack requires a real creator session and ownership.
 *
 * Source pack API:
 *   GET /__local/source-pack?work=<actual workId>&variant=approve|reject|batch&format=json
 * Returns a private /private/tmp/gongde-creator-browser-* archivePath suitable for
 * Ego setInputFiles(), pngPath, SHA256 and exact 2x2 RGBA pixel expectations.
 * Omit format=json for a binary .nmgpack. It NEVER uploads, submits or moderates.
 *
 * Actual site entrypoints: /creator.html, /community.html and
 * /admin/#/creatorCommunity; admin iframe /creator-preview.html is served unchanged
 * except the disclosed self-only navigation-fence script in every HTML head.
 * CSP blocks nonself resources; the fence blocks nonself links/forms/window.open.
 * It is NOT a browser-wide navigation firewall: Main must navigate only loopback URLs.
 *
 * Admin /login,/logout,/session are SYNTHETIC adapters, using a separate memory-only
 * HttpOnly cookie. The exact production compiled creator-admin router uses this
 * principal callback and REAL SQL/service moderation/authorization. This does NOT
 * validate production admin credential/session cryptography or real COS durability.
 * Other admin/payment endpoints return 404, rather than fake financial/business data.
 *
 * Shutdown: SIGINT/SIGTERM, or same-origin POST /__local/shutdown with the local
 * synthetic admin cookie, closes only this HTTP server and this injected pool.
 * No database/container teardown, file deletion, production deployment, browser
 * launch or business-state cleanup. Artifacts are kept in the approved temp prefix.
 */
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedLocalMysqlTarget, MemoryCos, sourceFixture, sha256 } from './free-creator-mysql-fixtures.local.mjs';
import { installLocalBrowserIoBoundary, fixtureError, localHeaders, json, jsonBody,
  cookie, sameOriginWrite, requestJson, requestPath, navigationFence, serveWebsite
} from './free-creator-browser-fixtures.local.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const variants = Object.freeze({
  approve: Object.freeze({ version: '1.0.0', pixel: 90 }),
  reject: Object.freeze({ version: '1.1.0', pixel: 160 }),
  batch: Object.freeze({ version: '2.0.0', pixel: 220 })
});

export async function startFreeCreatorBrowserLocal(environment = process.env) {
  // This guard precedes mysql2/application imports and all pool/server construction.
  const target = approvedLocalMysqlTarget(environment);
  const io = installLocalBrowserIoBoundary(target);
  let pool = null, server = null, stopPromise = null, route = null, origin = null;
  const adminSessions = new Map();
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      adminSessions.clear();
      if (server?.listening) {
        const force = setTimeout(() => server.closeAllConnections(), 3000);
        force.unref();
        try {
          server.closeIdleConnections();
          await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
        } finally { clearTimeout(force); }
      }
      if (pool) await pool.end();
    })();
    return stopPromise;
  };
  try {
    const { createPool } = await import('mysql2/promise');
    const { FreeCreatorRepository } = await import('../dist/creators/repository.js');
    const { FreeCreatorService, FREE_CREATOR_TERMS_VERSION } = await import('../dist/creators/free-service.js');
    const { CreatorSourceStore } = await import('../dist/creators/object-store.js');
    const { createFreeCreatorRouter } = await import('../dist/creators/router.js');
    const { CreatorError } = await import('../dist/creators/types.js');

    pool = createPool({ ...target, connectionLimit: 2, waitForConnections: true,
      queueLimit: 16, connectTimeout: 5000, timezone: 'Z', charset: 'utf8mb4',
      multipleStatements: false, debug: false });
    const repository = new FreeCreatorRepository({}, pool);
    const cos = new MemoryCos();
    const objects = new CreatorSourceStore({ bucket: 'fictional-local-browser', region: 'offline',
      secretId: 'FICTIONAL-NOT-A-CREDENTIAL', secretKey: 'FICTIONAL-NOT-A-CREDENTIAL' }, cos);
    const service = new FreeCreatorService(repository, objects);
    const [identity] = await pool.execute({ sql: 'SELECT DATABASE() AS name, VERSION() AS version', timeout: 5000 });
    if (identity[0]?.name !== target.database || !/^8\.4\./u.test(String(identity[0]?.version ?? ''))) {
      throw fixtureError('LOCAL_BROWSER_MYSQL_IDENTITY_MISMATCH', 503);
    }
    if (!await repository.ready()) throw fixtureError('LOCAL_BROWSER_SCHEMA_NOT_READY', 503);
    const websiteRoot = await realpath(resolve(HERE, '../../../website'));
    const artifacts = await mkdtemp('/private/tmp/gongde-creator-browser-');
    const namespace = randomBytes(6).toString('hex');
    const creator = { username: 'browser_' + namespace, password: 'Fictional-creator-' + namespace };
    const admin = { username: 'browser_admin_' + namespace, password: 'Fictional-admin-' + namespace };
    const actor = 'fictional-local-browser-admin-' + namespace;
    const adminCookie = 'gongde_local_browser_admin';
    const digest = value => createHash('sha256').update(value).digest();
    const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
    const requireAdmin = request => {
      const token = cookie(request, adminCookie);
      const entry = adminSessions.get(token);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) adminSessions.delete(token);
        throw new CreatorError('creator_admin_auth_required', 401);
      }
      return actor;
    };
    const adminCookieValue = (token, clear = false) => adminCookie + '=' + token +
      '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (clear ? 0 : 3600);

    let readyUntil = 0, readyPromise = null;
    const ready = () => {
      if (!readyPromise || Date.now() >= readyUntil) {
        readyUntil = Date.now() + 5000;
        readyPromise = repository.ready().catch(() => false);
      }
      return readyPromise;
    };

    const handle = async (request, response) => {
      localHeaders(response);
      if (!origin || request.headers.host !== new URL(origin).host ||
          request.socket.remoteAddress !== '127.0.0.1') throw fixtureError('LOCAL_BROWSER_HOST_REQUIRED', 403);
      const path = requestPath(request.url);
      const url = new URL(request.url, origin);
      const adminAuth = /^\/api\/gongde\/admin\/(login|logout|session)$/u.exec(path);
      if (adminAuth) {
        response.setHeader('x-gongde-local-admin-auth', 'synthetic-memory-principal-not-production-auth');
        const action = adminAuth[1];
        if (action === 'session' && request.method === 'GET') {
          requireAdmin(request); json(response, 200, { username: admin.username, localSyntheticAuth: true }); return;
        }
        if (request.method !== 'POST' || action === 'session') throw fixtureError('LOCAL_BROWSER_METHOD_NOT_ALLOWED', 405);
        sameOriginWrite(request, origin);
        const input = await jsonBody(request);
        if (action === 'login') {
          if (Object.keys(input).some(key => !['username', 'password'].includes(key)) ||
              typeof input.username !== 'string' || typeof input.password !== 'string' ||
              input.username.length > 128 || input.password.length > 128 ||
              !equal(input.username, admin.username) || !equal(input.password, admin.password)) {
            throw fixtureError('LOCAL_BROWSER_ADMIN_LOGIN_FAILED', 401);
          }
          const token = randomBytes(32).toString('hex');
          adminSessions.set(token, { expiresAt: Date.now() + 3600000 });
          if (adminSessions.size > 8) adminSessions.delete(adminSessions.keys().next().value);
          json(response, 200, { username: admin.username, localSyntheticAuth: true },
            { 'set-cookie': adminCookieValue(token) }); return;
        }
        adminSessions.delete(cookie(request, adminCookie));
        json(response, 200, { ok: true }, { 'set-cookie': adminCookieValue('', true) }); return;
      }

      if (path === '/__local/navigation-fence.js' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(navigationFence); return;
      }
      if (path === '/__local/source-pack' && request.method === 'GET') {
        if (request.headers['sec-fetch-site'] === 'cross-site' ||
            (request.headers.origin && request.headers.origin !== origin)) {
          throw fixtureError('LOCAL_BROWSER_ORIGIN_REQUIRED', 403);
        }
        const account = await service.requireAccount(cookie(request, 'gongde_creator_session'));
        const workId = url.searchParams.get('work') ?? '';
        if (!/^creator\.[a-f0-9]{32}\.[a-z0-9][a-z0-9-]{0,31}$/u.test(workId)) {
          throw fixtureError('LOCAL_BROWSER_WORK_REQUIRED');
        }
        const work = await repository.ownedWork(account.creatorId, workId);
        const variant = url.searchParams.get('variant') ?? 'approve';
        if (!Object.hasOwn(variants, variant)) throw fixtureError('LOCAL_BROWSER_VARIANT_INVALID');
        const specification = variants[variant];
        const pack = sourceFixture({ creatorId: account.creatorId, slug: work.slug }, specification);
        const stem = account.creatorId + '-' + work.slug + '-' + variant;
        const archivePath = join(artifacts, stem + '.nmgpack');
        const pngPath = join(artifacts, stem + '.png');
        await writeFile(archivePath, pack.archive, { mode: 0o600 });
        await writeFile(pngPath, pack.png, { mode: 0o600 });
        if (url.searchParams.get('format') === 'json') {
          json(response, 200, { workId, archivePath, pngPath, version: specification.version,
            sha256: sha256(pack.archive), expectedPixels: { width: 2, height: 2,
              rgba: Array(4).fill(specification.pixel) } }); return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="local-source-' + variant + '.nmgpack"',
          'content-length': pack.archive.length }); response.end(pack.archive); return;
      }
      if (path === '/__local/shutdown' && request.method === 'POST') {
        sameOriginWrite(request, origin); requireAdmin(request); await jsonBody(request);
        json(response, 200, { closing: true });
        setImmediate(() => { void stop().catch(() => { process.exitCode = 1; }); }); return;
      }

      if (/^\/api\/gongde\/(?:creators|community|admin\/creators)(?:\/|$)/u.test(path)) {
        const isReady = await ready();
        if (request.method === 'GET' && path === '/api/gongde/community/status') {
          // Matches the actual runtime envelope, backed by actual repository.ready().
          json(response, 200, { enabled: true, ready: isReady, freeBatchDelivery: isReady,
            termsVersion: FREE_CREATOR_TERMS_VERSION, maxItems: 10, maxBatchBytes: 16 * 1024 * 1024 }); return;
        }
        if (!isReady) { json(response, 503, { error: 'creator_service_unavailable' }); return; }
        if (await route(request, response, url)) return;
      }
      if (await serveWebsite(request, response, path, websiteRoot)) return;
      json(response, 404, { error: 'LOCAL_BROWSER_ROUTE_OUT_OF_SCOPE' });
    };
    server = createServer((request, response) => {
      void handle(request, response).catch(error => {
        if (response.headersSent) { response.destroy(); return; }
        const compiled = error instanceof CreatorError;
        const local = typeof error.code === 'string' && error.code.startsWith('LOCAL_BROWSER_');
        json(response, compiled || local ? error.status ?? 400 : 503,
          { error: compiled || local ? error.code : 'LOCAL_BROWSER_REQUEST_FAILED' });
      });
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 1000;
    io.approveServer(server);
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
    });
    const port = server.address().port;
    io.setHttpPort(port);
    origin = 'http://127.0.0.1:' + port;
    route = createFreeCreatorRouter({ publicOrigin: origin, secureCookie: false,
      trustedProxyAddresses: [], freeDownloadsEnabled: true }, service, requireAdmin);
    // Genuine HTTP registration -> real account/session cookie issuance, no fake SQL seed.
    await requestJson(origin, '/api/gongde/creators/register', {
      ...creator, displayName: 'Fictional local browser creator', termsVersion: FREE_CREATOR_TERMS_VERSION, acceptTerms: true
    });
    return {
      startup: { pid: process.pid, loopbackUrl: origin, creatorUrl: origin + '/creator.html',
        communityUrl: origin + '/community.html', adminUrl: origin + '/admin/#/creatorCommunity',
        creatorLogin: creator, adminLogin: { ...admin, syntheticLocalPrincipal: true } },
      stop
    };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let fixture;
  const forceExit = () => { process.exitCode = 1; process.exit(1); };
  const shutdown = () => {
    const deadline = setTimeout(forceExit, 5000);
    deadline.unref();
    void (fixture ? fixture.stop() : Promise.resolve())
      .then(() => { clearTimeout(deadline); })
      .catch(() => { clearTimeout(deadline); process.exitCode = 1; });
  };
  try {
    fixture = await startFreeCreatorBrowserLocal();
    process.stdout.write(JSON.stringify(fixture.startup) + '\n');
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    const code = String(error?.code ?? '');
    const safe = /^(?:LOCAL_MYSQL_|LOCAL_BROWSER_)[A-Z0-9_]+$/u.test(code);
    process.stderr.write(JSON.stringify({ error: safe ? code : 'LOCAL_BROWSER_START_FAILED' }) + '\n');
    process.exitCode = 1;
  }
}
