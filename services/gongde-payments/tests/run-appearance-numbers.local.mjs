import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(root, 'tests/.appearance-number-build-'));
// Explicit clean environment. Do not inherit credentials, provider flags or live DB configuration.
const env = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, NODE_ENV: 'test',
  CREATOR_SYSTEM_ENABLED: 'false', CREATOR_PAID_SALES_ENABLED: 'false', CREATOR_SETTLEMENT_ENABLED: 'false',
  GONGDE_NUMBER_TEST_BUILD: pathToFileURL(`${temporary}/`).href };
try {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json',
    '--outDir', temporary, '--incremental', 'false'], { cwd: root, env, stdio: 'inherit', timeout: 60000 });
  execFileSync(process.execPath, ['--test', 'tests/appearance-numbers.local.test.mjs'],
    { cwd: root, env, stdio: 'inherit', timeout: 60000 });
} finally { rmSync(temporary, { recursive: true, force: true }); }
