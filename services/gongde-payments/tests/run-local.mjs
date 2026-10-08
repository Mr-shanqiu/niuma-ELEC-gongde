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
