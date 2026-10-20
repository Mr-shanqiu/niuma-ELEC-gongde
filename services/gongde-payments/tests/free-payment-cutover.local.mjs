// Bounded local-only full-server cutover acceptance. No build, dotenv or live provider.
// Run from the canonical project: node services/gongde-payments/tests/free-payment-cutover.local.mjs
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { register, syncBuiltinESMExports } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';

const receiptUrl = new URL('../../../.local-work/acceptance/free-090-cutover/receipt.json', import.meta.url);
const sourceRoot = new URL('../src/', import.meta.url).href;
const startedAt = new Date().toISOString();
// Replace rather than inherit environment: no provider, storage or credential settings survive.
process.env = {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0',
  GONGDE_PAYMENT_MODE: 'mock', GONGDE_PAYMENT_TEST_TOKEN: 'synthetic-cutover-test-token-0123456789',
  GONGDE_STORE_MODE: 'memory', GONGDE_PACK_DELIVERY_MODE: 'disabled',
  GONGDE_PRIVATE_COS_MODE: 'disabled', GONGDE_CREATOR_PHONE_AUTH_ENABLED: 'false',
  GONGDE_NEW_PAYMENTS_DISABLED: 'true'
};
const report = {
  schemaVersion: 1, owner: 'parallel-local-free-payment-cutover', startedAt,
  evidenceLayer: 'LOCAL_FULL_SERVER_MOCK_HTTP', status: 'RUNNING',
  entrypoint: 'services/gongde-payments/src/server.ts',
  harnessReferences: [
    'services/gongde-payments/tests/free-distribution-http.local.mjs (in-memory source loader)',
    'services/gongde-payments/tests/market-http.local.test.mjs (full-server mock/memory loopback configuration)',
    'services/gongde-payments/tests/free-creator-mysql-fixtures.local.mjs (local-only I/O boundary pattern)'
  ],
  environment: { inherited: false, paymentMode: 'mock', storeMode: 'memory',
    newPaymentsDisabled: true, packDelivery: 'disabled', privateCos: 'disabled', phoneAuth: false,
    adminCredentials: 'absent', providerCredentials: 'absent', mysqlConfiguration: 'absent' },
  scope: { production: false, externalNetwork: false, realProviderCalls: false,
    dotenv: false, git: false, productWrites: false, mysql: false, buildArtifacts: false },
  boundaries: { allowedTcpConnections: 0, blockedIoAttempts: 0 },
  fullServerStarted: false, serverClosed: false, sourceBinding: null,
  cases: [], harnessRepairCount: 2, harnessRepairLimit: 2,
  priorHarnessAttempts: [
    { attempt: 1, status: 'BLOCKED', casesExecuted: 0, reason: 'Local I/O guard denied full-server initialization.' },
    { attempt: 2, status: 'BLOCKED', casesExecuted: 0,
      reason: 'Diagnostic stack identified node:net lookupAndListen using dns.lookup for literal 127.0.0.1; no external connection occurred.' }
  ],
  limitations: [
    'Only GONGDE_NEW_PAYMENTS_DISABLED=true is exercised; the free distribution enabled branch is not covered.',
    'No persisted historical order is seeded: order/access rejection is real, not a fabricated successful retrieval.',
    'Provider instances remain disabled in mock mode: callbacks return route-specific 503, not verified signatures or successful settlement.',
    'No production, deployment, MySQL, COS, SMS, browser or user acceptance claim.'
  ]
};
let stage = 'io-boundary', server, port;
let expired = false;
const originalRequest = http.request;
const originalConnect = net.Socket.prototype.connect;
const originalListen = net.Server.prototype.listen;
const originalLookup = dns.lookup;
const forbidden = () => {
  report.boundaries.blockedIoAttempts++;
  const error = new Error('LOCAL_CUTOVER_FORBIDDEN_IO');
  report.boundaries.deniedOrigin = error.stack.split('\n').slice(1, 7).map(line => line.trim());
  throw error;
};
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0] && typeof normalized[0] === 'object'
    ? normalized[0] : { port: normalized[0], host: normalized[1] };
  if (!port || options.path || options.host !== '127.0.0.1' || Number(options.port) !== port) return forbidden();
  report.boundaries.allowedTcpConnections++;
  return Reflect.apply(originalConnect, this, args);
};
net.Server.prototype.listen = function (...args) {
  if (args[0] !== 0 || args[1] !== '127.0.0.1') return forbidden();
  return Reflect.apply(originalListen, this, args);
};
http.request = http.get = https.request = https.get = tls.connect = forbidden;
globalThis.fetch = forbidden;
dgram.createSocket = dgram.Socket.prototype.send = dgram.Socket.prototype.bind = forbidden;
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  if (typeof dns[name] === 'function') dns[name] = forbidden;
  if (typeof dnsPromises[name] === 'function') dnsPromises[name] = forbidden;
}
// Node listen/connect call lookup even for literal IPs. The real built-in returns
// literal 127.0.0.1 without contacting a resolver; no hostname is permitted.
dns.lookup = function (...args) {
  if (args[0] !== '127.0.0.1') return forbidden();
  report.boundaries.literalLoopbackLookups = (report.boundaries.literalLoopbackLookups ?? 0) + 1;
  return Reflect.apply(originalLookup, this, args);
};
for (const name of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) childProcess[name] = forbidden;
syncBuiltinESMExports();

// Reuse the existing source loader; never read or write dist. Attach the digest of
// the exact server source transpiled by the loader, rather than rereading it later.
const { port1, port2 } = new MessageChannel();
const sourceBinding = new Promise(resolve => port1.once('message', resolve));
port1.unref();
const loader = `import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
let ts,root,receipt;export function initialize(d){ts=createRequire(d.ts)(d.ts);root=d.root;receipt=d.receipt;}
export async function resolve(s,c,next){if(s.startsWith('.')&&c.parentURL?.startsWith(root)&&s.endsWith('.js')){
const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return {url:u.href,shortCircuit:true};}return next(s,c);}
export async function load(u,c,next){if(u.startsWith(root)&&u.endsWith('.ts')){
const source=readFileSync(fileURLToPath(u),'utf8');
if(u===root+'server.ts')receipt.postMessage({sha256:createHash('sha256').update(source).digest('hex'),method:'typescript.transpileModule in memory; unmodified full entrypoint'});
return {format:'module',shortCircuit:true,source:ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};}return next(u,c);}`;

async function saveReceipt() {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('./', receiptUrl), { recursive: true });
  await writeFile(receiptUrl, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
const deadline = setTimeout(() => {
  expired = true;
  report.status = 'BLOCKED'; report.failure = { stage, code: 'LOCAL_CUTOVER_40_SECOND_DEADLINE' };
  server?.closeAllConnections(); server?.close();
  void saveReceipt().finally(() => process.exit(124));
}, 40000);

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  assert.ok(path.startsWith('/api/gongde/'));
  return new Promise((resolve, reject) => {
    const req = originalRequest({ hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { connection: 'close', ...headers } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16384) response.destroy(new Error('LOCAL_RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('LOCAL_HTTP_TIMEOUT')));
    req.on('error', reject); req.end(body);
  });
}
async function check(name, path, options, expectedStatus, expectedBody) {
  stage = name;
  const observed = await request(path, options);
  const row = { name, method: options.method ?? 'GET', path, expectedStatus,
    observedStatus: observed.status, observedBody: observed.body, passed: false };
  report.cases.push(row);
  assert.equal(observed.status, expectedStatus);
  for (const [key, value] of Object.entries(expectedBody)) assert.equal(observed.body[key], value);
  if (expectedStatus !== 410) {
    assert.notEqual(observed.status, 410);
    assert.notEqual(observed.body.error, 'paid_flow_retired');
    assert.ok(observed.status >= 400, 'rejected fixture must not fabricate a successful payment/access');
  }
  row.passed = true;
  process.stdout.write(JSON.stringify({ case: name, status: observed.status, passed: true }) + '\n');
}

try {
  stage = 'register-current-source';
  register('data:text/javascript,' + encodeURIComponent(loader), { data: {
    ts: fileURLToPath(new URL('../node_modules/typescript/lib/typescript.js', import.meta.url)),
    root: sourceRoot, receipt: port2
  }, transferList: [port2] });
  stage = 'import-full-server';
  ({ server } = await import('../src/server.ts'));
  stage = 'listen-loopback';
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.ok(address.port > 0); port = address.port;
  report.fullServerStarted = true;
  report.sourceBinding = await sourceBinding;
  report.listen = { address: address.address, ephemeralPort: port };

  for (const channel of ['wechat', 'alipay']) {
    await check('checkout_410_' + channel, '/api/gongde/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, purchaseKind: 'support', amountFen: 20 })
    }, 410, { error: 'paid_flow_retired' });
  }
  await check('checkout_410_before_body_parsing', '/api/gongde/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
  }, 410, { error: 'paid_flow_retired' });
  await check('legacy_order_missing_not_retired', '/api/gongde/orders/LOCAL_CUTOVER_MISSING', {},
    404, { error: 'order_not_found' });
  await check('legacy_access_invalid_not_retired', '/api/gongde/access', {},
    401, { error: 'access_code_invalid' });
  await check('legacy_access_orders_invalid_not_retired', '/api/gongde/access/orders', {},
    401, { error: 'access_code_invalid' });
  await check('wechat_callback_disabled_not_retired', '/api/gongde/payments/wechat/notify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  }, 503, { code: 'FAIL' });
  await check('alipay_callback_disabled_not_retired', '/api/gongde/payments/alipay/notify', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'sign=LOCAL_INVALID_FIXTURE'
  }, 503, { error: 'alipay_not_enabled' });
  assert.equal(report.cases.length, 8);
  assert.equal(report.boundaries.blockedIoAttempts, 0);
  report.status = 'PASS';
} catch (error) {
  report.status = report.fullServerStarted ? 'FAIL' : 'BLOCKED';
  report.failure = { stage, code: error.code ?? error.name ?? 'Error',
    message: String(error.message ?? error).slice(0, 600),
    deniedOrigin: report.boundaries.deniedOrigin ?? null };
  if (!report.fullServerStarted) report.configurationGap = {
    stage, description: 'Full current server could not start under synthetic mock/memory configuration; do not replace the entrypoint or enable production dependencies.'
  };
  process.exitCode = 1;
} finally {
  stage = 'close-and-receipt';
  port1.close();
  if (server) {
    try {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      report.serverClosed = true;
    } catch (error) {
      report.status = 'FAIL'; report.cleanupFailure = { code: error.code ?? error.name }; process.exitCode = 1;
    }
  }
  if (!expired) {
    await saveReceipt(); clearTimeout(deadline);
    process.stdout.write(JSON.stringify({ status: report.status, passed: report.cases.filter(row => row.passed).length,
      total: report.cases.length, serverClosed: report.serverClosed,
      failure: report.failure ?? null, receipt: fileURLToPath(receiptUrl) }) + '\n');
  }
}
