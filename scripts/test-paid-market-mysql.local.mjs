// Human-authorized isolated local MySQL 8.4 only. Never pull or touch existing containers.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedPaidMysqlTarget } from '../services/gongde-payments/tests/paid-market-mysql.local.test.mjs';

const root = '/Users/yue/Desktop/牛马电子功德';
assert.equal(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), root);
assert.equal(process.argv.length, 2, 'No alternate hosts, images or workspaces accepted.');
assert.equal(process.env.GONGDE_PAID_LOCAL_MYSQL_APPROVED, '1', 'Direct local MySQL approval required.');
const acceptance = path.join(root, '.local-work/acceptance/paid-community-20261007');
await mkdir(acceptance, { recursive: true, mode: 0o700 });
assert.equal(await realpath(acceptance), acceptance);
const token = randomBytes(12).toString('hex');
const artifacts = path.join(acceptance, 'mysql-run-' + token);
await mkdir(artifacts, { mode: 0o700 });
const home = await mkdtemp(path.join(artifacts, 'mysql-scratch-'));
await mkdir(path.join(home, 'docker'), { mode: 0o700 });
const base = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: home,
  TZ: 'UTC', LANG: 'C', DOCKER_CONFIG: path.join(home, 'docker') };
const rootPassword = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
const label = 'gongde.paid.local.owner';
const container = 'gongde-paid-local-' + token, volume = 'gongde-paid-data-' + token;
const database = 'gongde_paid_local_' + token;
const receipt = { evidence: 'ACTUAL_LOCAL_MYSQL_ONLY_MEMORY_FAKE_COS', artifacts, container, volume, database,
  context: null, socket: null, imageId: null, migrations: [], phases: [], suiteExit: null,
  initialVolumeEmpty: false, dataVolumeConfirmed: false, cleanup: {}, failure: null };
let socket, phaseDeadline = 0, interrupted = false, activeChild;
const redact = value => String(value).split(rootPassword).join('[temporary-secret]').split(password).join('[temporary-secret]');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  if (activeChild) { try { process.kill(-activeChild.pid, 'SIGTERM'); } catch {} }
});
const persist = () => writeFile(path.join(artifacts, 'mysql-run.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
async function phase(name, seconds, operation) {
  assert.ok(seconds <= 60);
  const entry = { name, openedAt: new Date().toISOString(), leaseSeconds: seconds, status: 'OPEN' };
  receipt.phases.push(entry); phaseDeadline = Date.now() + (seconds - 1) * 1000;
  await appendFile(path.join(root, 'WORK_PLAN.md'), `\n本地收费 MySQL 侧任务租约 OPEN：${entry.openedAt}，${name}，上限 ${seconds} 秒；仅随机隔离本机资源，回执 ${path.relative(root, artifacts)}。\n`);
  await persist();
  try { await operation(); entry.status = 'PASS'; }
  catch (error) { entry.status = 'FAIL'; entry.failure = redact(error.message).slice(0, 2000); throw error; }
  finally {
    entry.closedAt = new Date().toISOString();
    await appendFile(path.join(root, 'WORK_PLAN.md'), `\n本地收费 MySQL 侧任务租约 CLOSED：${entry.closedAt}，${name}=${entry.status}；检查点回执 ${path.relative(root, artifacts)}/mysql-run.json，无生产、SSH、镜像拉取或真实 COS。\n`);
    await persist();
  }
}
function run(command, args, { input = '', environment = {}, timeout = 4000, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error('LOCAL_RUN_INTERRUPTED');
  const remaining = phaseDeadline - Date.now();
  if (remaining <= 500) throw new Error('LOCAL_PHASE_LEASE_EXPIRED');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...base, ...environment },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChild = child;
    let stdout = '', stderr = '', bytes = 0, timedOut = false, force;
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      force ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 300);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.min(timeout, remaining - 500));
    for (const [stream, name] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { timedOut = true; stop(); return; }
      if (name === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(); });
    child.on('error', error => { clearTimeout(timer); clearTimeout(force); activeChild = null; reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(force); activeChild = null;
      resolve({ code, signal, timedOut, stdout: redact(stdout), stderr: redact(stderr) });
    });
    child.stdin.end(input);
  });
}
const docker = (args, options) => run('docker', ['--host', socket, '--config', base.DOCKER_CONFIG, ...args], options);
function success(result, operation) {
  assert.ok(result.code === 0 && !result.timedOut, `${operation}: exit=${result.code} timeout=${result.timedOut} ${result.stderr.slice(0, 1500)}`);
  return result.stdout.trim();
}
const absent = result => result.code !== 0 && !result.timedOut && /No such (object|container|volume)|not found/iu.test(result.stderr);
const ownedVolume = async cleanup => {
  const result = await docker(['volume', 'inspect', '--format', '{{ index .Labels "' + label + '" }}', volume], { cleanup });
  if (absent(result)) return false;
  assert.equal(success(result, 'own volume label'), token, 'VOLUME_OWNERSHIP_MISMATCH');
  return true;
};
const ownedContainer = async cleanup => {
  const result = await docker(['inspect', '--type=container', '--format', '{{ index .Config.Labels "' + label + '" }}', container], { cleanup });
  if (absent(result)) return false;
  assert.equal(success(result, 'own container label'), token, 'CONTAINER_OWNERSHIP_MISMATCH');
  return true;
};
try {
  await phase('cached Docker/local scope/startup', 55, async () => {
    // Initial human-task preflight confirmed desktop-linux at this exact Unix socket.
    // Sanitized HOME/DOCKER_CONFIG must never select an implicit default context.
    socket = 'unix:///Users/yue/.docker/run/docker.sock';
    receipt.context = 'desktop-linux (initial preflight reference; explicit host only)';
    receipt.contextMode = 'EXPLICIT_PREFLIGHT_UNIX_SOCKET_NO_DEFAULT_CONTEXT';
    assert.match(socket, /^unix:\/\//u, 'NONLOCAL_DOCKER_FORBIDDEN'); receipt.socket = socket;
    receipt.imageId = success(await docker(['image', 'inspect', 'mysql:8.4', '--format', '{{.Id}}']), 'cached mysql:8.4 image');
    assert.match(receipt.imageId, /^sha256:[a-f0-9]{64}$/u);
    success(await docker(['info', '--format', '{{.ServerVersion}}']), 'local Docker daemon');
    assert.ok(absent(await docker(['inspect', '--type=container', container])), 'RANDOM_CONTAINER_NAME_ALREADY_EXISTS');
    assert.ok(absent(await docker(['volume', 'inspect', volume])), 'RANDOM_VOLUME_NAME_ALREADY_EXISTS');
    success(await docker(['volume', 'create', '--label', `${label}=${token}`, volume]), 'create owned volume');
    assert.equal(await ownedVolume(), true);
    success(await docker(['run', '--detach', '--pull=never', '--name', container,
      '--label', `${label}=${token}`, '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=256',
      '--publish', '127.0.0.1::3306', '--mount', `type=volume,src=${volume},dst=/var/lib/mysql`,
      '--env', 'MYSQL_ROOT_PASSWORD', '--entrypoint', 'sh', receipt.imageId, '-c',
      'test -z "$(find /var/lib/mysql -mindepth 1 -maxdepth 1 -print -quit)" || exit 91; touch /tmp/gongde-paid-empty-volume; exec docker-entrypoint.sh mysqld --innodb-buffer-pool-size=64M --performance-schema=OFF --max-connections=12 --skip-log-bin'],
    { environment: { MYSQL_ROOT_PASSWORD: rootPassword }, timeout: 6000 }), 'create isolated MySQL');
    assert.equal(await ownedContainer(), true);
    const inspect = JSON.parse(success(await docker(['inspect', '--format',
      '{"memory":{{.HostConfig.Memory}},"cpu":{{.HostConfig.NanoCpus}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}', container]), 'own scope inspection'));
    assert.equal(inspect.memory, 512 * 1024 * 1024); assert.equal(inspect.cpu, 1000000000);
    const ports = inspect.ports['3306/tcp']; assert.equal(ports.length, 1); assert.equal(ports[0].HostIp, '127.0.0.1');
    receipt.port = Number(ports[0].HostPort);
    assert.ok(receipt.port >= 10000 && receipt.port <= 65535);
    assert.equal(inspect.mounts.length, 1); assert.equal(inspect.mounts[0].Name, volume);
    const readyUntil = Math.min(Date.now() + 38000, phaseDeadline - 3000);
    let ready = false;
    while (Date.now() < readyUntil && !interrupted) {
      const probe = await docker(['exec', '-i', '--env', 'MYSQL_PWD', container, 'mysql', '--user=root',
        '--batch', '--skip-column-names', '--execute=SELECT VERSION()'], { environment: { MYSQL_PWD: rootPassword }, timeout: 1800 });
      if (probe.code === 0 && /^8\.4\./u.test(probe.stdout.trim())) { ready = true; receipt.mysqlVersion = probe.stdout.trim(); break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'ISOLATED_MYSQL_8_4_NOT_READY');
    success(await docker(['exec', container, 'sh', '-c',
      'test -f /tmp/gongde-paid-empty-volume && test -d /var/lib/mysql/mysql']), 'initial empty and initialized owned data volume');
    receipt.initialVolumeEmpty = true; receipt.dataVolumeConfirmed = true;
  });
  await phase('local root setup/migrations 001-006', 40, async () => {
    assert.equal(await ownedContainer(), true); assert.equal(await ownedVolume(), true);
    const setupUrl = `mysql://root:${rootPassword}@127.0.0.1:${receipt.port}/${database}`;
    approvedPaidMysqlTarget({ GONGDE_PAID_LOCAL_MYSQL_APPROVED: '1', GONGDE_PAID_LOCAL_MYSQL_URL: setupUrl }, { allowSetupRoot: true });
    const mysqlArgs = ['exec', '-i', '--env', 'MYSQL_PWD', container, 'mysql', '--user=root', '--batch'];
    success(await docker(mysqlArgs, { environment: { MYSQL_PWD: rootPassword }, input:
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\n` }), 'create own isolated database');
    const directory = path.join(root, 'services/gongde-payments/migrations');
    const names = await readdir(directory);
    for (let index = 1; index <= 6; index++) {
      const matches = names.filter(name => name.startsWith(String(index).padStart(3, '0') + '_') && name.endsWith('.sql'));
      assert.equal(matches.length, 1);
      const sql = await readFile(path.join(directory, matches[0]), 'utf8');
      success(await docker([...mysqlArgs, '--database=' + database], { environment: { MYSQL_PWD: rootPassword }, input: sql }), 'local migration ' + matches[0]);
      receipt.migrations.push({ name: matches[0], sha256: createHash('sha256').update(sql).digest('hex'), status: 'APPLIED' });
    }
    success(await docker(mysqlArgs, { environment: { MYSQL_PWD: rootPassword }, input:
      `CREATE USER 'paid_local'@'%' IDENTIFIED BY '${password}';\nGRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO 'paid_local'@'%';\n` }), 'independent local product user');
  });
  await phase('compiled paid market MySQL suite', 50, async () => {
    assert.equal(await ownedContainer(), true);
    const url = `mysql://paid_local:${password}@127.0.0.1:${receipt.port}/${database}`;
    approvedPaidMysqlTarget({ GONGDE_PAID_LOCAL_MYSQL_APPROVED: '1', GONGDE_PAID_LOCAL_MYSQL_URL: url });
    const tested = await run(process.execPath, ['--max-old-space-size=128', '--experimental-test-module-mocks',
      path.join(root, 'services/gongde-payments/tests/paid-market-mysql.local.test.mjs')], {
      timeout: 43000, environment: { GONGDE_PAID_LOCAL_MYSQL_APPROVED: '1',
        GONGDE_PAID_LOCAL_MYSQL_URL: url, GONGDE_PAID_LOCAL_MYSQL_ARTIFACT_DIR: artifacts } });
    receipt.suiteExit = tested.code;
    await writeFile(path.join(artifacts, 'mysql-suite.stdout.log'), tested.stdout, { mode: 0o600 });
    await writeFile(path.join(artifacts, 'mysql-suite.stderr.log'), tested.stderr, { mode: 0o600 });
    process.stdout.write(tested.stdout);
    success(tested, 'actual paid-market MySQL suite');
  });
} catch (error) {
  receipt.failure = redact(error.message).slice(0, 2000);
} finally {
  if (socket) {
    try {
      await phase('ownership-checked container/data-volume teardown', 35, async () => {
        if (await ownedContainer(true)) {
          success(await docker(['rm', '--force', '--volumes', container], { cleanup: true, timeout: 6000 }), 'remove own container');
        }
        assert.ok(absent(await docker(['inspect', '--type=container', container], { cleanup: true })), 'OWN_CONTAINER_REMOVAL_UNCONFIRMED');
        receipt.cleanup.container = 'ABSENT_CONFIRMED';
        if (await ownedVolume(true)) success(await docker(['volume', 'rm', volume], { cleanup: true }), 'remove own data volume');
        assert.ok(absent(await docker(['volume', 'inspect', volume], { cleanup: true })), 'OWN_VOLUME_REMOVAL_UNCONFIRMED');
        receipt.cleanup.volume = 'ABSENT_CONFIRMED';
      });
    } catch (error) {
      receipt.cleanup.failure = redact(error.message).slice(0, 1600);
      receipt.failure ??= 'OWN_RESOURCE_CLEANUP_UNCONFIRMED';
    }
  }
  receipt.succeeded = receipt.failure === null && receipt.suiteExit === 0 &&
    receipt.cleanup.container === 'ABSENT_CONFIRMED' && receipt.cleanup.volume === 'ABSENT_CONFIRMED';
  receipt.completedAt = new Date().toISOString();
  await persist();
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  if (!receipt.succeeded) process.exitCode = 1;
}
