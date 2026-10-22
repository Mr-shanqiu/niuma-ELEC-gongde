import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const separate = new Set([
  'market-http.local.test.mjs',
  'paid-market-mysql.local.test.mjs',
  'free-creator-mysql.local.test.mjs',
  'free-creator-budgets.local.test.mjs',
  'free-creator-preview.local.test.mjs',
  'appearance-numbers.local.test.mjs',
  'appearance-numbers-mysql.local.test.mjs',
  'download-counting.local.test.mjs',
  // Needs the MySQL server the acceptance launcher starts; the core group has
  // no database. Without it the publication lock would only be tested by the
  // single-process fake, which is exactly the claim it must not make.
  'publication-lock-mysql.local.test.mjs',
  // Mocks the MySQL driver to force `RELEASE_LOCK` failures a real server will
  // not produce on demand, so it needs the module-mocks flag and its own group.
  'publication-lock-release.local.test.mjs',
  // It mocks the COS client, so it needs `--experimental-test-module-mocks` and
  // runs in its own group below. Left out of `separate` it would also be picked
  // up by the core glob, where module mocking is unavailable and it fails to
  // load instead of reporting a product failure.
  'publication-write.local.test.mjs',
]);
const core = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs') && !separate.has(name))
  .sort().map(name => `tests/${name}`);
const groups = [
  ['appearance numbers (isolated compiler and mocked repository; no database)',
    ['--max-old-space-size=64', 'tests/run-appearance-numbers.local.mjs']],
  ['local contracts (HTTP uses loopback; providers and repository are mocks)',
    ['--max-old-space-size=64', '--test', '--test-concurrency=1', ...core]],
  ['paid community HTTP (actual server/signing; catalog, COS and payment are mocks)',
    ['--max-old-space-size=64', '--experimental-test-module-mocks', '--test', 'tests/market-http.local.test.mjs']],
  ['download counting (actual server; COS is an in-memory client, redirects are not followed)',
    ['--max-old-space-size=64', '--experimental-test-module-mocks', '--test', 'tests/download-counting.local.test.mjs']],
  ['appearance publication (actual server; COS is an in-memory client, single-process lock)',
    ['--max-old-space-size=64', '--experimental-test-module-mocks', '--test', 'tests/publication-write.local.test.mjs']],
  ['publication lock cleanup (MySQL driver mocked; the real lock is tested separately)',
    ['--max-old-space-size=64', '--experimental-test-module-mocks', '--test', 'tests/publication-lock-release.local.test.mjs']],
  ['creator budgets (mock persistence)',
    ['--expose-gc', '--max-old-space-size=64', 'tests/free-creator-budgets.local.test.mjs']],
  ['creator preview (DOM stubs; not actual browser)',
    ['--expose-gc', '--max-old-space-size=64', 'tests/free-creator-preview.local.test.mjs']],
];
let failed = false;
for (const [name, args] of groups) {
  console.log(`\nRunning ${name}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: 'inherit', timeout: 60000,
  });
  if (result.error || result.status !== 0) {
    failed = true;
    console.error(`${name}: failed (${result.error?.code ?? result.status ?? result.signal})`);
  }
}
console.log('Real MySQL integration is separate: use the documented approved local launcher.');
process.exitCode = failed ? 1 : 0;
