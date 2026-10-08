// Import-safe local fixtures. No pool, environment load, provider client, or I/O on import.
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
const require = createRequire(import.meta.url);
const { zipSync, zlibSync, unzipSync } = require('fflate');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const jsonValue = value => typeof value === 'string' ? JSON.parse(value) : value;
export const unzip = body => unzipSync(body);

export function approvedLocalMysqlTarget(source) {
  const deny = code => { const error = new Error(code); error.code = code; throw error; };
  if (source.GONGDE_CREATOR_LOCAL_MYSQL_APPROVED !== '1') deny('LOCAL_MYSQL_HUMAN_APPROVAL_REQUIRED');
  const text = source.GONGDE_CREATOR_LOCAL_MYSQL_URL;
  if (typeof text !== 'string' || !text.startsWith('mysql://')) deny('LOCAL_MYSQL_TARGET_UNSAFE');
  let url;
  try { url = new URL(text); } catch { deny('LOCAL_MYSQL_TARGET_UNSAFE'); }
  const authority = text.slice(8).split(/[/?#]/u)[0];
  const literalHost = authority.slice(authority.lastIndexOf('@') + 1);
  const port = Number(url.port), database = url.pathname.slice(1);
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) || port < 10000 || port > 65535 ||
      literalHost !== '127.0.0.1:' + String(port) || url.search || url.hash ||
      !/^gongde_creator_local_[a-f0-9]{8,32}$/u.test(database) || !url.username) {
    deny('LOCAL_MYSQL_TARGET_UNSAFE');
  }
  let user, password;
  try { user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { deny('LOCAL_MYSQL_TARGET_UNSAFE'); }
  if (!user || user.length > 64 || password.length > 256 || /[\x00-\x1f\x7f]/u.test(user + password)) deny('LOCAL_MYSQL_TARGET_UNSAFE');
  return Object.freeze({ host: '127.0.0.1', port, database, user, password });
}

export function installLocalOnlyIoBoundary(target) {
  const metrics = { localTcpConnectAttempts: 0, forbiddenIoAttempts: 0 };
  const forbidden = () => { metrics.forbiddenIoAttempts += 1; throw new Error('NONLOCAL_IO_FORBIDDEN'); };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const options = normalized[0] && typeof normalized[0] === 'object' ? normalized[0] :
      { port: normalized[0], host: normalized[1] };
    if (options.path || options.host !== target.host || Number(options.port) !== target.port) return forbidden();
    metrics.localTcpConnectAttempts += 1;
    return Reflect.apply(originalConnect, this, args);
  };
  net.Server.prototype.listen = forbidden;
  tls.connect = http.request = http.get = https.request = https.get = forbidden;
  dgram.createSocket = dgram.Socket.prototype.send = dgram.Socket.prototype.bind = forbidden;
  globalThis.fetch = forbidden;
  for (const method of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync']) childProcess[method] = forbidden;
  syncBuiltinESMExports();
  return metrics;
}

export class MemoryCos {
  bodies = new Map();
  writes = 0;
  reads = [];
  getBucketAcl(_input, callback) {
    callback(null, { ACL: 'private', Owner: { ID: 'fictional-local-owner' },
      Grants: [{ Grantee: { ID: 'fictional-local-owner' }, Permission: 'FULL_CONTROL' }] });
  }
  getBucketPolicy(_input, callback) { callback({ code: 'NoSuchBucketPolicy' }); }
  putObject(input, callback) {
    if (input.ACL !== 'private' || input.ContentLength !== input.Body.length) {
      callback(new Error('LOCAL_COS_FIXTURE_CONTRACT_INVALID')); return;
    }
    this.bodies.set(input.Key, Buffer.from(input.Body)); this.writes += 1;
    callback(null, {});
  }
  getObject(input, callback) {
    const body = this.bodies.get(input.Key);
    this.reads.push(input.Key);
    if (!body) { callback(new Error('LOCAL_COS_FIXTURE_MISSING')); return; }
    input.Output.on('error', () => {});
    void (async () => {
      for (let offset = 0; offset < body.length; offset += 65536) {
        await new Promise((resolve, reject) => input.Output.write(body.subarray(offset, offset + 65536), error => error ? reject(error) : resolve()));
      }
      await new Promise(resolve => input.Output.end(resolve)); callback(null, {});
    })().catch(callback);
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, input) => {
  let value = input;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length); output.write(type, 4, 4, 'ascii'); bytes.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, output.length - 4)), output.length - 4);
  return output;
}
export function sourceFixture(owned, { version = '1.0.0', pixel = 90 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(18, pixel); pixels[0] = 0; pixels[9] = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', Buffer.from(zlibSync(pixels))), chunk('IEND', Buffer.alloc(0))]);
  const manifest = { id: 'creator.' + owned.creatorId + '.' + owned.slug,
    version, name_zh: 'Fictional local MySQL source', name_en: 'Fictional local MySQL source',
    author: 'fictional-local-creator', publisher: 'community', review_id: 'pending',
    canvas_width: 240, canvas_height: 250, preview: 'sprite.png', plus_y: 174, schema_version: 1,
    layers: [{ image: 'sprite.png', frame: [0, 0, 16, 16], anchor: [0.5, 0.5],
      keyframes: [{ t: 0, x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 }] }] };
  const bytes = zipSync({ 'manifest.json': Buffer.from(JSON.stringify(manifest)), 'sprite.png': png },
    { level: 6, mtime: new Date('2020-01-01T00:00:00Z') });
  return { archive: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), png, manifest };
}
