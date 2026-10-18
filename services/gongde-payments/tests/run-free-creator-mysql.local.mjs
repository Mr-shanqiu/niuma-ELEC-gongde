// Preparation artifact, not an executed database acceptance receipt.
// Run only after direct human approval for a temporary local database and DDL:
// GONGDE_CREATOR_LOCAL_MYSQL_APPROVED=1 node --max-old-space-size=64 tests/run-free-creator-mysql.local.mjs
// A goal-controller caller must obtain its <=60-second operation lease in the
// same shell immediately before execution. Work is bounded to 50 seconds plus
// at most six seconds of ownership-checked cleanup.
// Requires the existing compiled service, test suite, Docker daemon and exact
// cached MySQL image. Never reads .env, installs dependencies or pulls images.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.env.GONGDE_CREATOR_LOCAL_MYSQL_APPROVED, '1',
  'Explicit temporary local database approval is required; nothing was started.');
assert.equal(process.argv.length, 2, 'No alternate hosts, images or databases are accepted.');

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suitePath = path.join(serviceRoot, 'tests/free-creator-mysql.local.test.mjs');
const imageId = 'sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb';
const dockerSocket = 'unix:///var/run/docker.sock';
const suiteInfo = await stat(suitePath);
assert.ok(suiteInfo.isFile(), 'The real MySQL test suite must be prepared first.');

const migrationDirectory = path.join(serviceRoot, 'migrations');
const migrationNames = await readdir(migrationDirectory);
const migrations = [];
for (let index = 1; index <= 5; index += 1) {
  const prefix = String(index).padStart(3, '0') + '_';
  const matches = migrationNames.filter((name) => name.startsWith(prefix) && name.endsWith('.sql'));
  assert.equal(matches.length, 1, 'Exactly one migration is required for ' + prefix);
  const sql = await readFile(path.join(migrationDirectory, matches[0]), 'utf8');
  migrations.push({ name: matches[0], sql, sha256: createHash('sha256').update(sql).digest('hex') });
}

const token = randomBytes(12).toString('hex');
const database = 'gongde_creator_local_' + randomBytes(8).toString('hex');
const container = 'gongde-creator-local-' + token;
const ownerLabel = 'gongde.creator.local.token';
const rootPassword = randomBytes(24).toString('hex');
const testPassword = randomBytes(24).toString('hex');
const temporaryRoot = await mkdtemp('/private/tmp/gongde-creator-mysql-');
await mkdir(path.join(temporaryRoot, 'home'), { mode: 0o700 });
await mkdir(path.join(temporaryRoot, 'docker'), { mode: 0o700 });
const baseEnvironment = {
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  HOME: path.join(temporaryRoot, 'home'),
  TMPDIR: '/private/tmp',
  LANG: 'C',
  TZ: 'UTC',
  DOCKER_CONFIG: path.join(temporaryRoot, 'docker'),
};
const deadline = Date.now() + 50_000;
let databaseUrl;
let startAttempted = false;
let cleanup = 'NOT_CREATED';
let schemaVerified = false;
let suiteExecuted = false;
let suiteExitCode = null;
let failure = null;
let interrupted = false;
let activeChild = null;

function redact(text) {
  let result = String(text).split(rootPassword).join('[temporary-secret]');
  result = result.split(testPassword).join('[temporary-secret]');
  if (databaseUrl) result = result.split(databaseUrl).join('[temporary-local-database-url]');
  return result;
}

function terminateChild(child) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    terminateChild(activeChild);
  });
}

function run(command, args, options = {}) {
  const cleanupOperation = options.cleanup === true;
  const remaining = deadline - Date.now();
  if (!cleanupOperation && (interrupted || remaining <= 0)) {
    throw new Error('Local acceptance was interrupted or reached its fixed work deadline.');
  }
  const timeout = cleanupOperation
    ? Math.min(options.timeout || 3_000, 3_000)
    : Math.min(options.timeout || 5_000, remaining);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: serviceRoot,
      env: { ...baseEnvironment, ...(options.environment || {}) },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let excessiveOutput = false;
    let forceTimer;
    const stop = () => {
      terminateChild(child);
      forceTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }, 500);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const collect = (stream) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) {
        if (!excessiveOutput) { excessiveOutput = true; stop(); }
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') { stderr += error.message; stop(); }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (activeChild === child) activeChild = null;
      resolve({ code, signal, stdout: redact(stdout), stderr: redact(stderr), timedOut, excessiveOutput });
    });
    child.stdin.end(options.input || '');
  });
}

function docker(args, options = {}) {
  return run('docker', ['--host', dockerSocket, '--config', baseEnvironment.DOCKER_CONFIG, ...args], options);
}

function requireSuccess(result, operation) {
  if (result.code !== 0 || result.timedOut || result.excessiveOutput) {
    throw new Error(operation + ' failed; exit=' + result.code +
      ', timeout=' + result.timedOut + ', output-limit=' + result.excessiveOutput +
      (result.stderr ? ': ' + result.stderr : ''));
  }
}

const mysqlArguments = ['exec', '--interactive', '--env', 'MYSQL_PWD', container, 'mysql',
  '--protocol=TCP', '--host=127.0.0.1', '--user=creator_local', '--database=' + database,
  '--batch', '--skip-column-names'];

try {
  const cached = await docker(['image', 'inspect', '--format', '{{.Id}}', imageId]);
  requireSuccess(cached, 'Cached image inspection');
  assert.equal(cached.stdout.trim(), imageId, 'No alternative or downloaded image is permitted.');

  startAttempted = true;
  const started = await docker(['run', '--detach', '--pull=never',
    '--name', container, '--label', ownerLabel + '=' + token,
    '--label', 'gongde.creator.local.thread=019fe783-0713-7e70-8a68-ae2ff3bc0966',
    '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=256',
    '--publish', '127.0.0.1::3306',
    '--env', 'MYSQL_ROOT_PASSWORD', '--env', 'MYSQL_DATABASE',
    '--env', 'MYSQL_USER', '--env', 'MYSQL_PASSWORD',
    imageId, '--innodb-buffer-pool-size=64M', '--performance-schema=OFF',
    '--max-connections=12', '--skip-log-bin'], {
    timeout: 5_000,
    environment: {
      MYSQL_ROOT_PASSWORD: rootPassword, MYSQL_DATABASE: database,
      MYSQL_USER: 'creator_local', MYSQL_PASSWORD: testPassword,
    },
  });
  requireSuccess(started, 'One-time container start');

  const published = await docker(['port', container, '3306/tcp']);
  requireSuccess(published, 'Loopback port inspection');
  const endpoint = /^127\.0\.0\.1:(\d{5})$/.exec(published.stdout.trim());
  assert.ok(endpoint, 'The test endpoint must be exactly one IPv4 loopback high port.');
  const port = Number(endpoint[1]);
  assert.ok(port >= 10000 && port <= 65535, 'The suite requires an explicit local port of at least 10000.');
  databaseUrl = 'mysql://creator_local:' + testPassword + '@127.0.0.1:' + port + '/' + database;

  const readyDeadline = Math.min(deadline, Date.now() + 25_000);
  let ready = false;
  while (!interrupted && Date.now() < readyDeadline) {
    const probe = await docker([...mysqlArguments, '--execute=SELECT 1'], {
      timeout: 2_000, environment: { MYSQL_PWD: testPassword },
    });
    if (probe.code === 0 && !probe.timedOut && probe.stdout.trim() === '1') {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'The dedicated local database did not become ready within its bound.');

  // Only the dedicated test account is used: it cannot write another database.
  // Never retry DDL, an unknown write, or the acceptance suite.
  for (const migration of migrations) {
    const applied = await docker(mysqlArguments, {
      timeout: 5_000, environment: { MYSQL_PWD: testPassword }, input: migration.sql,
    });
    requireSuccess(applied, 'Temporary schema ' + migration.name);
  }

  const schemaProbe = await docker([...mysqlArguments, '--execute=' +
    "SELECT username, recovery_digest FROM gongde_creators LIMIT 0; " +
    "SELECT published_metadata_json FROM gongde_creator_works LIMIT 0; " +
    "SELECT bucket_digest FROM gongde_creator_rate_limits LIMIT 0; " +
    "SELECT 'CREATOR_SCHEMA_READY'"], {
    timeout: 5_000, environment: { MYSQL_PWD: testPassword },
  });
  requireSuccess(schemaProbe, 'Actual post-DDL field verification');
  assert.equal(schemaProbe.stdout.trim(), 'CREATOR_SCHEMA_READY');
  schemaVerified = true;

  suiteExecuted = true;
  const tested = await run(process.execPath, ['--max-old-space-size=96', suitePath], {
    timeout: 25_000,
    environment: {
      GONGDE_CREATOR_LOCAL_MYSQL_APPROVED: '1',
      GONGDE_CREATOR_LOCAL_MYSQL_URL: databaseUrl,
      GONGDE_CREATOR_LOCAL_MYSQL_ARTIFACT_DIR: path.join(temporaryRoot, 'suite'),
    },
  });
  suiteExitCode = tested.code;
  await writeFile(path.join(temporaryRoot, 'test.stdout.log'), tested.stdout, { mode: 0o600 });
  await writeFile(path.join(temporaryRoot, 'test.stderr.log'), tested.stderr, { mode: 0o600 });
  requireSuccess(tested, 'Actual MySQL acceptance suite');
} catch (error) {
  failure = redact(error && error.message ? error.message : error);
} finally {
  if (startAttempted) {
    try {
      const owned = await docker(['inspect', '--format',
        '{{ index .Config.Labels "gongde.creator.local.token" }}', container], { cleanup: true });
      if (owned.code === 0 && !owned.timedOut && owned.stdout.trim() === token) {
        const removed = await docker(['rm', '--force', '--volumes', container], { cleanup: true });
        cleanup = removed.code === 0 && !removed.timedOut ? 'REMOVED' : 'UNCONFIRMED';
      } else if (owned.code !== 0 && !owned.timedOut &&
          /No such (object|container)/i.test(owned.stderr)) {
        cleanup = 'ABSENT';
      } else {
        cleanup = 'OWNERSHIP_OR_REMOVAL_UNCONFIRMED';
      }
    } catch {
      cleanup = 'UNCONFIRMED';
    }
  }
  if (!['NOT_CREATED', 'ABSENT', 'REMOVED'].includes(cleanup) && !failure) {
    failure = 'Owned temporary container cleanup was not confirmed; inspect this exact receipt before retrying.';
  }
  if (interrupted && !failure) failure = 'Local acceptance was interrupted.';
  const receipt = {
    evidence: 'ACTUAL_LOCAL_MYSQL_ONLY_NOT_PRODUCTION_NOT_BROWSER_NOT_NATIVE_IMPORT',
    succeeded: failure === null && suiteExecuted && suiteExitCode === 0,
    completedAt: new Date().toISOString(),
    temporaryRoot, container, imageId, database, cleanup,
    suitePath, schemaVerified, suiteExecuted, suiteExitCode,
    migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    failure,
  };
  await writeFile(path.join(temporaryRoot, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  if (failure) process.exitCode = 1;
}
