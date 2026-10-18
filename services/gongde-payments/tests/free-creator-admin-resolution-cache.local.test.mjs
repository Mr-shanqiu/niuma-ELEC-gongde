import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FreeCreatorRepository } from '../dist/creators/repository.js';

// Mock repository and isolated producer tests only; no production SQL or browser cache claim.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const createdAt = '2026-10-05T03:00:00.000Z';
const decidedAt = '2026-10-05T03:05:00.000Z';
const checked = [];

function repositoryRow(state, detail, time = decidedAt) {
  return { complaint_id: 'synthetic-complaint', work_id: 'synthetic-work', version_id: 'synthetic-version',
    state, category: 'OTHER', description: 'Synthetic complaint', created_at: createdAt,
    decision_detail_json: detail, decided_at: time, actor_reference: 'must-not-be-exposed' };
}

async function readComplaint(state, detail, time = decidedAt) {
  let query;
  const pool = { execute: async (sql, values) => {
    query = { sql, values };
    return [[repositoryRow(state, detail, time)], []];
  } };
  const [record] = await new FreeCreatorRepository({}, pool).complaints(state, 50);
  assert.deepEqual(query.values, [state]);
  assert.match(query.sql, /LEFT JOIN gongde_creator_audit/);
  assert.match(query.sql, /a\.subject_reference = c\.complaint_id AND a\.actor_kind = 'admin'/);
  assert.match(query.sql, /WHEN 'RESOLVED' THEN 'complaint\.suspend'/);
  assert.match(query.sql, /WHEN 'DISMISSED' THEN 'complaint\.dismiss' ELSE NULL END/);
  assert.match(query.sql, /WHERE c\.state = \? ORDER BY c\.created_at ASC LIMIT 50 OFFSET 50/);
  assert.deepEqual(Object.keys(record).sort(), ['category', 'complaintId', 'createdAt', 'decidedAt',
    'description', 'reason', 'state', 'versionId', 'workId'].sort());
  return record;
}

test('closed complaint notes and module cache identities', async t => {
  await t.test('RESOLVED reads the existing JSON audit reason and actual audit time', async () => {
    const reason = '\u5408\u6210\u9a8c\u6536\uff1a\u6682\u505c\u4f5c\u54c1';
    const record = await readComplaint('RESOLVED', JSON.stringify({ workId: 'synthetic-work', reason }));
    assert.equal(record.reason, reason);
    assert.equal(record.decidedAt, decidedAt);
    checked.push('resolved-audit-note');
  });
  await t.test('DISMISSED reads an already decoded audit object without changing the decision', async () => {
    const record = await readComplaint('DISMISSED', { reason: 'Synthetic dismissal basis' });
    assert.equal(record.reason, 'Synthetic dismissal basis');
    assert.equal(record.state, 'DISMISSED');
    checked.push('dismissed-audit-note');
  });
  await t.test('OPEN has no fabricated reason or decision timestamp', async () => {
    const record = await readComplaint('OPEN', null, null);
    assert.equal(record.reason, null);
    assert.equal(record.decidedAt, null);
    checked.push('open-no-fabricated-decision');
  });
  await t.test('historical missing audit stays explicitly unavailable', async () => {
    const record = await readComplaint('RESOLVED', null, null);
    assert.equal(record.reason, null);
    assert.equal(record.decidedAt, null);
    checked.push('missing-audit-truthful');
  });
  await t.test('invalid audit reason is never converted to user-visible text', async () => {
    for (const detail of [{ reason: 42 }, { reason: { secret: 'not-a-note' } }, 'null', []]) {
      assert.equal((await readComplaint('DISMISSED', detail)).reason, null);
    }
    checked.push('nonstring-note-rejected');
  });
  await t.test('public entry, both imports and admin preview use the same new module identity', () => {
    const html = readFileSync(join(root, 'website/community.html'), 'utf8');
    const js = readFileSync(join(root, 'website/community.js'), 'utf8');
    const admin = readFileSync(join(root, 'admin-console/src/creator-community.tsx'), 'utf8');
    const key = html.match(/src="community\.js\?v=([a-z0-9-]+)"/)?.[1];
    assert.ok(key, 'public entry must have an explicit versioned module identity');
    assert.match(key, /^[a-z][a-z0-9-]*-\d{8}$/);
    assert.ok(html.includes(`src="community.js?v=${key}"`));
    assert.ok(js.includes(`from './creator-api.js?v=${key}'`));
    assert.ok(js.includes(`from './community-preview.js?v=${key}'`));
    assert.ok(admin.includes(`/community-preview.js?v=${key}`));
    assert.ok(admin.includes('selected.decidedAt'));
    assert.ok(admin.includes('(view === "complaints" && selected.state === "OPEN")) && <TextField'));
    checked.push('consistent-versioned-module-identities');
  });
  await t.test('cache overlay changes exactly two files and retains every other base file', () => {
    const temp = mkdtempSync(join(tmpdir(), 'gongde-note-cache-overlay-'));
    try {
      const scripts = join(temp, 'scripts'), website = join(temp, 'website');
      const out = join(temp, 'dist/gongde-deploy'), baseTree = join(temp, 'base-tree');
      const extracted = join(temp, 'extracted');
      for (const directory of [scripts, website, out, baseTree, extracted]) mkdirSync(directory, { recursive: true });
      copyFileSync(join(root, 'scripts/package-website-overlay.sh'), join(scripts, 'package-website-overlay.sh'));
      const originals = { 'community.html': 'old-entry', 'community.js': 'old-caller',
        'community-preview.js': 'retained-renderer', 'creator-api.js': 'retained-api',
        'install.html': 'retained-install', 'creator-guide.html': 'retained-guide',
        'retained.txt': 'retained-base' };
      for (const [name, content] of Object.entries(originals)) writeFileSync(join(baseTree, name), content);
      writeFileSync(join(website, 'community.html'), 'new-versioned-entry');
      writeFileSync(join(website, 'community.js'), 'new-versioned-caller');
      const hashLines = Object.keys(originals).sort().map(name => `${digest(originals[name])}  ./${name}\n`).join('');
      const base = join(out, `gongde-site-${digest(hashLines)}.tar.gz`);
      const options = { timeout: 10000, env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' };
      execFileSync('/usr/bin/tar', ['-C', baseTree, '-czf', base, '.'], options);
      writeFileSync(`${base}.sha256`, `${digest(readFileSync(base))}  ${base.split('/').at(-1)}\n`);
      const output = execFileSync('/bin/sh', [join(scripts, 'package-website-overlay.sh'), '--community-cache', base], options);
      assert.match(output, /OVERLAY_PROFILE=community-cache/);
      assert.match(output, /OVERLAY_FILES=community\.html,community\.js/);
      const artifact = output.match(/^SITE_ARCHIVE=(.+)$/m)?.[1];
      assert.ok(artifact);
      execFileSync('/usr/bin/tar', ['-xzf', artifact, '-C', extracted], options);
      const changed = Object.keys(originals).filter(name => readFileSync(join(extracted, name), 'utf8') !== originals[name]).sort();
      assert.deepEqual(changed, ['community.html', 'community.js']);
      assert.equal(readFileSync(join(extracted, 'community.html'), 'utf8'), 'new-versioned-entry');
      assert.equal(readFileSync(join(extracted, 'community.js'), 'utf8'), 'new-versioned-caller');
      checked.push('two-file-overlay-isolation');
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  const receipt = { classification: 'LOCAL_MOCK_AND_ISOLATED_PRODUCER_ONLY', checked, passed: true,
    productionSqlExecuted: false, browserCacheAcceptance: false, productionDeployment: false };
  if (process.env.GONGDE_ADMIN_RESOLUTION_CACHE_RECEIPT) {
    writeFileSync(process.env.GONGDE_ADMIN_RESOLUTION_CACHE_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(receipt));
});
