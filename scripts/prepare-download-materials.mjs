#!/usr/bin/env node

// Prepare the public download materials from an explicit source manifest.
//
// The previous path derived both filenames from VERSION, copied whatever sat
// in dist/, and stamped every entry "unsigned" / "not-notarized". That missed
// the real artifacts and described them wrongly. Here every entry names its
// own source file and declares its own size, digest and trust state; nothing
// is inferred from the version or borrowed from another release.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

const [manifestArg, outArg, baseUrlArg, generatedAtArg] = process.argv.slice(2);
if (!manifestArg || !outArg) {
  console.error('Usage: prepare-download-materials.mjs <manifest.json> <output-dir> [base-url] [generated-at]');
  process.exit(64);
}

const outDir = resolve(outArg);
const baseUrl = (baseUrlArg || 'https://download.gongde.zqscreen.cn/').replace(/\/?$/, '/');
const generatedAt = generatedAtArg || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function fail(message) {
  console.error(`DOWNLOAD_MATERIALS_ERROR ${message}`);
  process.exit(1);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Trust claims are checked against the bytes actually being published. A claim
// we cannot check is reported, never silently upgraded to "verified".
async function verifyClaim(file, entry) {
  const signature = entry.signature || '';
  const notarization = entry.notarization || '';

  if (/^developer id/i.test(signature)) {
    // codesign writes its report to stderr, so both streams are read here.
    const result = spawnSync('codesign', ['-dv', '--verbose=2', file], { encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
      return { verified: false, reason: 'codesign unavailable' };
    }
    const report = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 || !/Developer ID Application/.test(report)) {
      fail(`${entry.name}: manifest claims a Developer ID signature but codesign does not report one`);
    }
  }

  if (notarization === 'notarized') {
    const result = spawnSync('xcrun', ['stapler', 'validate', file], { encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
      return { verified: false, reason: 'xcrun unavailable' };
    }
    if (result.status !== 0) {
      fail(`${entry.name}: manifest claims notarization but no valid ticket is stapled`);
    }
  }

  if (/authenticode/i.test(signature)) {
    if (!(await hasAuthenticode(file))) {
      fail(`${entry.name}: manifest claims an Authenticode signature but the PE has no certificate table`);
    }
  }

  return { verified: true };
}

// The certificate table is data directory 4 of the PE optional header. Its
// presence is what Windows reads before it can trust a publisher.
async function hasAuthenticode(file) {
  const buffer = await readFile(file);
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') return false;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.length < peOffset + 24 || buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return false;
  const optionalOffset = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalOffset);
  if (magic !== 0x10b && magic !== 0x20b) return false;
  const securityDirectory = optionalOffset + (magic === 0x20b ? 112 : 96) + 4 * 8;
  return buffer.length >= securityDirectory + 8 && buffer.readUInt32LE(securityDirectory + 4) > 0;
}

const manifest = JSON.parse(await readFile(manifestArg, 'utf8'));
const entries = Array.isArray(manifest.files) ? manifest.files : null;
if (!entries || !entries.length) fail('manifest has no files[] entries');

const problems = [];
for (const [index, entry] of entries.entries()) {
  const label = entry.name || `files[${index}]`;
  for (const field of ['name', 'source', 'platform', 'version', 'bytes', 'sha256', 'signature', 'notarization']) {
    if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
      problems.push(`${label}: missing required field "${field}"`);
    }
  }
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) problems.push(`${label}: "bytes" must be a positive integer`);
  if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) problems.push(`${label}: "sha256" must be 64 hex characters`);
  if (entry.name && basename(String(entry.name)) !== entry.name) problems.push(`${label}: "name" must be a bare filename`);
}
if (problems.length) fail(`invalid manifest:\n  ${problems.join('\n  ')}`);

// Validate every input before touching the output directory.
const prepared = [];
for (const entry of entries) {
  const source = resolve(entry.source);
  let bytes;
  try {
    bytes = await readFile(source);
  } catch {
    fail(`${entry.name}: source file is missing (${source}). Provide the published artifact; do not rebuild or re-sign a client to satisfy an old filename.`);
  }
  if (bytes.length !== entry.bytes) {
    fail(`${entry.name}: source is ${bytes.length} bytes but the manifest declares ${entry.bytes}`);
  }
  const digest = sha256(bytes);
  if (digest !== String(entry.sha256).toLowerCase()) {
    fail(`${entry.name}: source digest ${digest} does not match the manifest ${entry.sha256}`);
  }
  prepared.push({ entry, source, digest });
}

for (const { entry, source } of prepared) {
  const claim = await verifyClaim(source, entry);
  if (!claim.verified) {
    console.error(`DOWNLOAD_MATERIALS_WARNING ${entry.name}: trust claim not checked (${claim.reason})`);
  }
  entry.claimVerified = claim.verified;
}

await mkdir(outDir, { recursive: true });

// Write only after every input passed validation. A failed run leaves the
// previous output untouched rather than half-replaced.
//
// Cleanup is limited to what the previous manifest produced. The output
// directory also holds hand-placed artifacts and receipts, and deleting those
// because a later run listed fewer files would be data loss, not tidying.
const previousManifest = join(outDir, 'DOWNLOADS.json');
const generated = new Set(['DOWNLOADS.json', 'SHA256SUMS.txt']);
try {
  const previous = JSON.parse(await readFile(previousManifest, 'utf8'));
  for (const item of previous.files || []) {
    if (item && typeof item.name === 'string' && basename(item.name) === item.name) {
      generated.add(item.name);
    }
  }
} catch {
  // No readable previous manifest: nothing is known to be ours, so nothing
  // is removed. Stale files can be cleaned by hand or by naming them here.
}
for (const existing of await readdir(outDir)) {
  if (generated.has(existing)) await unlink(join(outDir, existing));
}

const files = [];
const checksumLines = [];
for (const { entry, source, digest } of prepared) {
  const target = join(outDir, entry.name);
  await copyFile(source, target);
  const copied = await readFile(target);
  if (copied.length !== entry.bytes || sha256(copied) !== digest) {
    fail(`${entry.name}: copy does not match the validated source`);
  }
  checksumLines.push(`${digest}  ${entry.name}`);
  const item = {
    name: entry.name,
    bytes: entry.bytes,
    sha256: digest,
    platform: entry.platform,
    architecture: entry.architecture,
    signature: entry.signature,
    notarization: entry.notarization,
    version: entry.version
  };
  if (entry.build) item.build = entry.build;
  if (entry.releaseId) item.releaseId = entry.releaseId;
  if (entry.perpetualCompatible !== undefined) item.perpetualCompatible = entry.perpetualCompatible;
  if (entry.historical !== undefined) item.historical = entry.historical;
  item.url = `${baseUrl}${entry.name}`;
  files.push(item);
}

await writeFile(join(outDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`);
await writeFile(join(outDir, 'DOWNLOADS.json'), `${JSON.stringify({
  baseUrl,
  generatedAt,
  sourceManifest: basename(manifestArg),
  files
}, null, 2)}\n`);

console.log(`DOWNLOAD_MATERIALS_OK files=${files.length} dir=${outDir}`);
