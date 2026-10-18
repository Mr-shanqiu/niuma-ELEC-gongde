// Authorized isolated MySQL only. No source changes, pull, install, remote access,
// existing-resource enumeration or production configuration loading.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, realpath, symlink } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

assert.equal(process.env.GONGDE_NUMBERING_LOCAL_MYSQL_APPROVED, '1');
const receiptRoot = process.argv[2];
assert.match(receiptRoot ?? '', /^\/private\/tmp\/gongde-numbering-local-[A-Za-z0-9]+$/u);
const preflight = JSON.parse(await readFile(path.join(receiptRoot, 'preflight.json'), 'utf8'));
assert.equal(preflight.approved, true);
assert.equal(preflight.root, receiptRoot);
assert.ok(Date.now() - Date.parse(preflight.checkedAt) < 15 * 60 * 1000);
assert.equal(process.env.DOCKER_HOST ?? '', preflight.dockerHostOverride);
assert.equal(process.env.DOCKER_CONTEXT ?? '', preflight.dockerContextOverride);
assert.ok(!['DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].some(key => process.env[key]));
assert.match(preflight.endpoint, /^unix:\/\/\/[^\0\r\n?#]+$/u);
assert.equal(await realpath(preflight.endpoint.slice(7)), preflight.resolvedSocket);
assert.equal((await stat(preflight.resolvedSocket)).isSocket(), true);
assert.match(preflight.imageId, /^sha256:b3b90af2a655[a-f0-9]{52}$/u);

const serviceRoot = fileURLToPath(new URL('../', import.meta.url));
const token = randomBytes(12).toString('hex');
const container = 'gongde-numbering-local-' + token;
const ownerLabel = 'gongde.numbering.local.owner';
const database = 'gongde_numbering_local_' + randomBytes(8).toString('hex');
const rootPassword = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
const build = path.join(receiptRoot, 'build');
await mkdir(build, { mode: 0o700 });
await writeFile(path.join(receiptRoot, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
await symlink(path.join(serviceRoot, 'node_modules'), path.join(receiptRoot, 'node_modules'));
const environment = { PATH: process.env.PATH, HOME: receiptRoot, TMPDIR: receiptRoot,
  DOCKER_CONFIG: path.join(receiptRoot, 'docker'), NODE_ENV: 'test', TZ: 'UTC', LANG: 'C',
  CREATOR_SYSTEM_ENABLED: 'false', CREATOR_PAID_SALES_ENABLED: 'false', CREATOR_SETTLEMENT_ENABLED: 'false' };
const deadline = Date.now() + 48000;
const commands = [];
let startAttempted = false, containerId = null, mounts = [], cleanup = 'NOT_CREATED';
let failure = null, activeChild = null, interrupted = false;
const redact = value => String(value).split(password).join('[temporary-secret]').split(rootPassword).join('[temporary-secret]');
function kill(child, signal = 'SIGTERM') { if (child?.pid) { try { process.kill(-child.pid, signal); } catch {} } }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; kill(activeChild); });

function run(command, args, options = {}) {
  const remaining = options.cleanup ? (options.timeout ?? 3000) : deadline - Date.now();
  if ((!options.cleanup && interrupted) || remaining <= 0) throw new Error('local_work_deadline_or_interruption');
  const timeout = Math.min(options.timeout ?? 10000, remaining, 30000);
  commands.push({ command: [command === process.execPath ? 'node' : command, ...args].map(redact).join(' '), timeoutMs: timeout });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: serviceRoot, env: { ...environment, ...options.environment },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChild = child;
    let stdout = '', stderr = '', bytes = 0, timedOut = false, excessiveOutput = false, force;
    const stop = () => { kill(child); force = setTimeout(() => kill(child, 'SIGKILL'), 250); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { if (!excessiveOutput) { excessiveOutput = true; stop(); } return; }
      if (label === 'stdout') stdout += chunk; else stderr += chunk;
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') { stderr += error.message; stop(); } });
    child.on('error', error => { clearTimeout(timer); clearTimeout(force); activeChild = null; reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(force); activeChild = null;
      resolve({ code, signal, stdout: redact(stdout), stderr: redact(stderr), timedOut, excessiveOutput });
    });
    child.stdin.end(options.input ?? '');
  });
}
const docker = (args, options) => run('docker', ['--host', preflight.endpoint, '--config', environment.DOCKER_CONFIG, ...args], options);
const success = (result, step) => {
  if (result.code !== 0 || result.timedOut || result.excessiveOutput) {
    throw new Error(`${step}: exit=${result.code} timeout=${result.timedOut} ${result.stderr.slice(0, 1500)}`);
  }
  return result.stdout.trim();
};

try {
  success(await run(process.execPath, [path.join(serviceRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json',
    '--outDir', build, '--incremental', 'false'], { timeout: 10000 }), 'isolated_current_source_compile');
  startAttempted = true;
  const started = await docker(['run', '--detach', '--pull=never', '--name', container,
    '--label', ownerLabel + '=' + token, '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=256',
    '--publish', '127.0.0.1::3306', '--env', 'MYSQL_ROOT_PASSWORD', '--env', 'MYSQL_DATABASE',
    '--env', 'MYSQL_USER', '--env', 'MYSQL_PASSWORD', preflight.imageId,
    '--innodb-buffer-pool-size=64M', '--performance-schema=OFF', '--max-connections=24', '--skip-log-bin'], {
    timeout: 10000, environment: { MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_DATABASE: database,
      MYSQL_USER: 'numbering_local', MYSQL_PASSWORD: password }
  });
  containerId = success(started, 'one_time_container_start');
  assert.match(containerId, /^[a-f0-9]{64}$/u);
  console.log(JSON.stringify({ event: 'OWNED_CONTAINER_LIVE', container, containerId, receiptRoot,
    workDeadline: new Date(deadline).toISOString(), maxCleanupMs: 8000 }));
  const inspected = JSON.parse(success(await docker(['inspect', '--format', '{{json .}}', containerId]), 'own_container_configuration'));
  assert.equal(inspected.Config.Labels[ownerLabel], token);
  assert.equal(inspected.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(inspected.HostConfig.NanoCpus, 1000000000);
  assert.equal(inspected.Config.Image, preflight.imageId);
  mounts = inspected.Mounts.map(mount => ({ type: mount.Type, name: mount.Name ?? null, destination: mount.Destination }));
  assert.ok(mounts.every(mount => mount.type === 'volume' && mount.destination === '/var/lib/mysql'));
  const published = success(await docker(['port', containerId, '3306/tcp']), 'own_loopback_port');
  const match = /^127\.0\.0\.1:(\d{4,5})$/u.exec(published);
  assert.ok(match); const port = Number(match[1]); assert.ok(port >= 10000 && port <= 65535);
  const readyDeadline = Math.min(deadline, Date.now() + 25000);
  let ready = false;
  while (Date.now() < readyDeadline && !interrupted) {
    const result = await docker(['exec', '--env', 'MYSQL_PWD', containerId, 'mysql', '--protocol=TCP',
      '--host=127.0.0.1', '--user=numbering_local', '--database=' + database, '--batch', '--skip-column-names', '--execute=SELECT 1'],
    { timeout: 2000, environment: { MYSQL_PWD: password } });
    if (result.code === 0 && !result.timedOut && result.stdout.trim() === '1') { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(ready, 'dedicated_local_mysql_not_ready_within_bound');
  const tested = await run(process.execPath, ['--max-old-space-size=96', 'tests/appearance-numbers-mysql.local.test.mjs'], {
    timeout: 15000, environment: { GONGDE_NUMBERING_LOCAL_MYSQL_APPROVED: '1',
      GONGDE_NUMBER_TEST_BUILD: pathToFileURL(build + '/').href, GONGDE_NUMBER_TEST_RECEIPT_ROOT: receiptRoot,
      GONGDE_NUMBER_TEST_DATABASE: database, GONGDE_NUMBER_TEST_PORT: String(port), GONGDE_NUMBER_TEST_PASSWORD: password }
  });
  await writeFile(path.join(receiptRoot, 'test.stdout.log'), tested.stdout, { mode: 0o600 });
  await writeFile(path.join(receiptRoot, 'test.stderr.log'), tested.stderr, { mode: 0o600 });
  success(tested, 'real_mysql_numbering_suite');
} catch (error) {
  failure = redact(error.message ?? error);
} finally {
  if (startAttempted) {
    try {
      const target = containerId ?? container;
      const owned = await docker(['inspect', '--format', '{{ index .Config.Labels "gongde.numbering.local.owner" }}', target],
        { cleanup: true, timeout: 3000 });
      if (owned.code === 0 && !owned.timedOut && owned.stdout.trim() === token) {
        const removed = await docker(['rm', '--force', '--volumes', target], { cleanup: true, timeout: 5000 });
        cleanup = removed.code === 0 && !removed.timedOut ? 'OWN_CONTAINER_AND_ANONYMOUS_VOLUME_REMOVED' : 'UNCONFIRMED';
      } else if (owned.code !== 0 && !owned.timedOut && /No such (object|container)/i.test(owned.stderr)) cleanup = 'ABSENT';
      else cleanup = 'OWNERSHIP_OR_CLEANUP_UNCONFIRMED';
    } catch { cleanup = 'UNCONFIRMED'; }
  }
  if (!['NOT_CREATED', 'ABSENT', 'OWN_CONTAINER_AND_ANONYMOUS_VOLUME_REMOVED'].includes(cleanup) && !failure) failure = 'cleanup_unconfirmed_stop';
  let suite = null;
  try { suite = JSON.parse(await readFile(path.join(receiptRoot, 'mysql-test-receipt.json'), 'utf8')); }
  catch { if (!failure) failure = 'suite_receipt_missing'; }
  const receipt = { evidence: 'ACTUAL_ISOLATED_LOCAL_MYSQL_NOT_PRODUCTION', succeeded: !failure && suite?.succeeded === true,
    completedAt: new Date().toISOString(), receiptRoot, endpoint: preflight.endpoint, imageId: preflight.imageId,
    engineVersion: preflight.engineVersion, container, containerId, database, mounts, cleanup, commands, suite, failure,
    noPull: true, noInstall: true, noProductionAccess: true, businessSourceModified: false };
  await writeFile(path.join(receiptRoot, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ receipt: path.join(receiptRoot, 'receipt.json'), succeeded: receipt.succeeded,
    container, containerId, cleanup, failure, suite }));
  if (!receipt.succeeded) process.exitCode = 1;
}
