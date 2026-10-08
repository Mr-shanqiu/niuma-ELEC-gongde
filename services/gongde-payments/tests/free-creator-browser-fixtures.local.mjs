/**
 * Import-safe, process-scoped browser fixture helpers.
 * No environment/credential loading, listeners, pools, provider clients or I/O on import.
 * The website remains real; only a disclosed navigation-fence script is injected.
 */
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve, relative, sep, extname } from 'node:path';

export const LOCAL_BROWSER_CSP = [
  "default-src 'none'", "connect-src 'self'", "img-src 'self'",
  "font-src 'self'", "script-src 'self'", "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'", "frame-src 'self'",
  "frame-ancestors 'self'", "form-action 'self'", "base-uri 'none'",
  "object-src 'none'", "worker-src 'none'", "media-src 'none'"
].join('; ');

export function localHeaders(response) {
  response.setHeader('content-security-policy', LOCAL_BROWSER_CSP);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-gongde-local-fixture', 'real-repository-memory-cos-synthetic-admin');
}

export function json(response, status, value, extra = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  response.end(JSON.stringify(value));
}

export function fixtureError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export async function jsonBody(request) {
  if (String(request.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
    throw fixtureError('LOCAL_BROWSER_JSON_REQUIRED', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const input of request) {
    const chunk = Buffer.from(input);
    size += chunk.length;
    if (size > 16384) throw fixtureError('LOCAL_BROWSER_REQUEST_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw fixtureError('LOCAL_BROWSER_INVALID_JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fixtureError('LOCAL_BROWSER_INVALID_JSON');
  return result;
}

export function cookie(request, name) {
  return String(request.headers.cookie ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith(name + '='))?.slice(name.length + 1) ?? '';
}

export function sameOriginWrite(request, origin) {
  if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
    throw fixtureError('LOCAL_BROWSER_ORIGIN_REQUIRED', 403);
  }
}

let installed = false;
export function installLocalBrowserIoBoundary(target) {
  if (installed) throw fixtureError('LOCAL_BROWSER_ONE_SERVER_PER_PROCESS');
  installed = true;
  const metrics = { mysqlConnectAttempts: 0, loopbackHttpConnectAttempts: 0, forbiddenIoAttempts: 0 };
  const servers = new WeakSet();
  let httpPort = null;
  const forbidden = () => {
    metrics.forbiddenIoAttempts += 1;
    throw fixtureError('LOCAL_BROWSER_NONLOCAL_IO_FORBIDDEN', 503);
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options = normalized[0] && typeof normalized[0] === 'object' ? normalized[0] :
      { port: normalized[0], host: normalized[1] };
    if (options.path || options.host !== '127.0.0.1') return forbidden();
    const port = Number(options.port);
    if (port === target.port) metrics.mysqlConnectAttempts += 1;
    else if (httpPort !== null && port === httpPort) metrics.loopbackHttpConnectAttempts += 1;
    else return forbidden();
    return Reflect.apply(originalConnect, this, args);
  };
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = args[0];
    if (!servers.has(this) || !options || typeof options !== 'object' ||
        options.host !== '127.0.0.1' || options.port !== 0 || options.path) return forbidden();
    return Reflect.apply(originalListen, this, args);
  };
  tls.connect = https.request = https.get = forbidden;
  dgram.createSocket = dgram.Socket.prototype.send = dgram.Socket.prototype.bind = forbidden;
  globalThis.fetch = forbidden;
  for (const method of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) childProcess[method] = forbidden;
  for (const object of [dns, dns.promises]) {
    const originalLookup = object.lookup;
    for (const method of Object.keys(object)) {
      if (method === 'lookupService' || method.startsWith('resolve')) object[method] = forbidden;
    }
    // Node uses lookup even for a numeric server.listen host. Literal IPv4
    // lookup is resolved locally; all names and other addresses stay blocked.
    object.lookup = function (hostname, ...args) {
      if (hostname !== '127.0.0.1') return forbidden();
      return Reflect.apply(originalLookup, this, [hostname, ...args]);
    };
  }
  syncBuiltinESMExports();
  return {
    metrics,
    approveServer(server) { servers.add(server); },
    setHttpPort(port) {
      if (httpPort !== null || !Number.isInteger(port) || port < 10000 || port > 65535 || port === target.port) {
        throw fixtureError('LOCAL_BROWSER_HTTP_PORT_UNSAFE');
      }
      httpPort = port;
    }
  };
}

export function requestJson(origin, path, payload) {
  const url = new URL(origin + path);
  const bytes = Buffer.from(JSON.stringify(payload));
  return new Promise((resolvePromise, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: Number(url.port), path: url.pathname + url.search, method: 'POST',
      headers: { host: url.host, origin, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', 'content-length': bytes.length }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) response.destroy(fixtureError('LOCAL_BROWSER_BOOTSTRAP_RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(fixtureError('LOCAL_BROWSER_BOOTSTRAP_INVALID_JSON')); return; }
        if (response.statusCode !== 201) {
          reject(fixtureError('LOCAL_BROWSER_CREATOR_BOOTSTRAP_FAILED', response.statusCode)); return;
        }
        if (!String(response.headers['set-cookie']?.[0] ?? '').startsWith('gongde_creator_session=') ||
            !data.account?.creatorId) {
          reject(fixtureError('LOCAL_BROWSER_CREATOR_COOKIE_NOT_ISSUED')); return;
        }
        resolvePromise(data);
      });
    });
    request.setTimeout(10000, () => request.destroy(fixtureError('LOCAL_BROWSER_BOOTSTRAP_TIMEOUT')));
    request.once('error', reject);
    request.end(bytes);
  });
}

export function requestPath(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096 || !rawUrl.startsWith('/') ||
      rawUrl.startsWith('//') || rawUrl.includes('#')) throw fixtureError('LOCAL_BROWSER_PATH_INVALID');
  let decoded;
  try { decoded = decodeURIComponent(rawUrl.split('?')[0]); }
  catch { throw fixtureError('LOCAL_BROWSER_PATH_INVALID'); }
  if (/[\\\x00-\x1f\x7f%]/u.test(decoded) ||
      decoded.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) {
    throw fixtureError('LOCAL_BROWSER_PATH_TRAVERSAL', 403);
  }
  return decoded;
}

export const navigationFence = String.raw`
(() => {
  const allowed = value => {
    try { return new URL(value, location.href).origin === location.origin; }
    catch { return false; }
  };
  const blocked = () => console.warn('LOCAL_BROWSER_NONLOCAL_NAVIGATION_BLOCKED');
  document.addEventListener('click', event => {
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (anchor && !allowed(anchor.href)) {
      event.preventDefault(); event.stopImmediatePropagation(); blocked();
    }
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target;
    const action = event.submitter?.getAttribute('formaction') || form.action;
    if (!allowed(action)) { event.preventDefault(); event.stopImmediatePropagation(); blocked(); }
  }, true);
  const open = window.open.bind(window);
  window.open = (url, ...args) => {
    if (!allowed(url ?? 'about:blank')) { blocked(); return null; }
    return open(url, ...args);
  };
})();
`;

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'], ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf']
]);

export async function serveWebsite(request, response, path, websiteRoot) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  if (path === '/') path = '/creator.html';
  if (path === '/admin' || path === '/admin/') path = '/admin/index.html';
  if (path.startsWith('/api/') || path.startsWith('/__local/')) return false;
  const type = TYPES.get(extname(path).toLowerCase());
  if (!type) return false;
  const candidate = resolve(websiteRoot, '.' + path);
  const within = value => {
    const result = relative(websiteRoot, value);
    return result !== '' && result !== '..' && !result.startsWith('..' + sep) && !result.startsWith(sep);
  };
  if (!within(candidate)) throw fixtureError('LOCAL_BROWSER_PATH_TRAVERSAL', 403);
  let actual;
  try { actual = await realpath(candidate); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
  if (!within(actual)) throw fixtureError('LOCAL_BROWSER_SYMLINK_ESCAPE', 403);
  const info = await stat(actual);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) return false;
  let bytes = await readFile(actual);
  if (extname(path).toLowerCase() === '.html') {
    const html = bytes.toString('utf8');
    if (!/<head(?:\s[^>]*)?>/iu.test(html)) throw fixtureError('LOCAL_BROWSER_HTML_HEAD_REQUIRED');
    bytes = Buffer.from(html.replace(/<head(?:\s[^>]*)?>/iu, match =>
      match + '\n<script src="/__local/navigation-fence.js"></script>'));
  }
  response.writeHead(200, { 'content-type': type, 'content-length': bytes.length });
  response.end(request.method === 'HEAD' ? undefined : bytes);
  return true;
}
