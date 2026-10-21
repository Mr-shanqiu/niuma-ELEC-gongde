#!/usr/bin/env node

// Prepare the public download materials from an explicit source manifest.
//
// The previous path derived both filenames from VERSION, copied whatever sat
// in dist/, and stamped every entry "unsigned" / "not-notarized". That missed
// the real artifacts and described them wrongly. Here every entry names its
// own source file and declares its own size, digest and trust state; nothing
// is inferred from the version or borrowed from another release.
//
// The trust state is not taken on faith either. It is derived from the file
// that is about to be published and then required to equal what the manifest
// declares, in both directions: a manifest may not call a notarized, Developer
// ID build "unsigned" any more than it may call an ad-hoc build "notarized".
// Checking only the claims that assert a strong state would leave the weaker
// (and equally published) descriptions unchecked.

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

// This script writes both of these itself. An entry named after one of them
// would be copied and then silently replaced by the generated file, publishing
// a URL that serves something other than the artifact that was validated.
const RESERVED_NAMES = new Set(['downloads.json', 'sha256sums.txt']);

// Accepted spellings of each claim, mapped to the state derived from the file.
const MAC_SIGNATURE_CLAIMS = new Map([
  ['developer id application', 'developer id application'],
  ['apple development', 'apple development'],
  ['apple-development', 'apple development'],
  ['ad-hoc', 'ad-hoc'],
  ['adhoc', 'ad-hoc'],
  ['unsigned', 'unsigned']
]);
const MAC_NOTARIZATION_CLAIMS = new Set(['notarized', 'not-notarized']);
const WINDOWS_SIGNATURE_CLAIMS = new Map([
  ['authenticode-sha256', 'authenticode'],
  ['authenticode', 'authenticode'],
  ['unsigned', 'unsigned']
]);
const WINDOWS_NOTARIZATION = 'not-applicable';

// codesign writes its report to stderr, so both streams are read. The
// discriminators are: a non-zero exit means no signature at all; an Authority
// line names the signing identity; an ad-hoc signature has no Authority but
// carries the adhoc code-directory flag. Anything else is not classifiable and
// is reported as such rather than being guessed at.
function macSignatureState(file) {
  const result = spawnSync('codesign', ['-dv', '--verbose=2', file], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') return null;
  const report = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) return 'unsigned';
  if (/Authority=Developer ID Application/.test(report)) return 'developer id application';
  if (/Authority=Apple Development/.test(report)) return 'apple development';
  if (/flags=0x[0-9a-f]+\(adhoc\)/i.test(report)) return 'ad-hoc';
  return 'unknown';
}

function macNotarizationState(file) {
  const result = spawnSync('xcrun', ['stapler', 'validate', file], { encoding: 'utf8' });
  if (result.error && result.error.code === 'ENOENT') return null;
  return result.status === 0 ? 'notarized' : 'not-notarized';
}

// The certificate table is data directory 4 of the PE optional header. Its
// presence is what Windows reads before it can trust a publisher.
function windowsSignatureState(buffer) {
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.length < peOffset + 24 || buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  const optionalOffset = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalOffset);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const securityDirectory = optionalOffset + (magic === 0x20b ? 112 : 96) + 4 * 8;
  if (buffer.length < securityDirectory + 8) return 'unsigned';
  return buffer.readUInt32LE(securityDirectory + 4) > 0 ? 'authenticode' : 'unsigned';
}

// Derive the real state, then require the manifest to have said exactly that.
async function assertClaimsMatch(entry, source, buffer) {
  const platform = String(entry.platform).toLowerCase();
  const signatureClaim = String(entry.signature).trim();
  const notarizationClaim = String(entry.notarization).trim();

  if (platform.includes('mac') || platform.includes('darwin')) {
    const claimedSignature = MAC_SIGNATURE_CLAIMS.get(signatureClaim.toLowerCase());
    if (!claimedSignature) {
      fail(`${entry.name}: unrecognized macOS signature claim "${signatureClaim}". Use one of: ${[...MAC_SIGNATURE_CLAIMS.keys()].join(', ')}`);
    }
    const actualSignature = macSignatureState(source);
    if (actualSignature === null) fail(`${entry.name}: cannot check the macOS signature claim because codesign is unavailable`);
    if (actualSignature === 'unknown') fail(`${entry.name}: codesign reports a signature state this script cannot classify; check the file by hand`);
    if (actualSignature !== claimedSignature) {
      fail(`${entry.name}: manifest claims "${signatureClaim}" but codesign reports "${actualSignature}". Do not carry a trust state over from another release.`);
    }

    if (!MAC_NOTARIZATION_CLAIMS.has(notarizationClaim)) {
      fail(`${entry.name}: unrecognized macOS notarization claim "${notarizationClaim}". Use "notarized" or "not-notarized".`);
    }
    const actualNotarization = macNotarizationState(source);
    if (actualNotarization === null) fail(`${entry.name}: cannot check the notarization claim because xcrun is unavailable`);
    if (actualNotarization !== notarizationClaim) {
      fail(`${entry.name}: manifest claims "${notarizationClaim}" but the stapled ticket says "${actualNotarization}"`);
    }
    return;
  }

  if (platform.includes('windows') || platform.includes('win32')) {
    const claimedSignature = WINDOWS_SIGNATURE_CLAIMS.get(signatureClaim.toLowerCase());
    if (!claimedSignature) {
      fail(`${entry.name}: unrecognized Windows signature claim "${signatureClaim}". Use one of: ${[...WINDOWS_SIGNATURE_CLAIMS.keys()].join(', ')}`);
    }
    const actualSignature = windowsSignatureState(buffer);
    if (actualSignature === null) fail(`${entry.name}: not a readable PE file, so its signature claim cannot be checked`);
    if (actualSignature !== claimedSignature) {
      fail(`${entry.name}: manifest claims "${signatureClaim}" but the PE certificate table says "${actualSignature}"`);
    }
    if (notarizationClaim !== WINDOWS_NOTARIZATION) {
      fail(`${entry.name}: Windows entries must use notarization "${WINDOWS_NOTARIZATION}", not "${notarizationClaim}"`);
    }
    return;
  }

  fail(`${entry.name}: unsupported platform "${entry.platform}"; expected macOS or Windows`);
}

const manifest = JSON.parse(await readFile(manifestArg, 'utf8'));
const entries = Array.isArray(manifest.files) ? manifest.files : null;
if (!entries || !entries.length) fail('manifest has no files[] entries');

const problems = [];
const seenNames = new Set();
for (const [index, entry] of entries.entries()) {
  const label = entry.name || `files[${index}]`;
  for (const field of ['name', 'source', 'platform', 'version', 'bytes', 'sha256', 'signature', 'notarization']) {
    if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
      problems.push(`${label}: missing required field "${field}"`);
    }
  }
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) problems.push(`${label}: "bytes" must be a positive integer`);
  if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) problems.push(`${label}: "sha256" must be 64 hex characters`);
  if (entry.name) {
    const name = String(entry.name);
    if (basename(name) !== name) {
      problems.push(`${label}: "name" must be a bare filename`);
    } else if (RESERVED_NAMES.has(name.toLowerCase())) {
      problems.push(`${entry.name}: this script writes "${name}" itself; choose a different output name`);
    } else if (seenNames.has(name)) {
      problems.push(`${entry.name}: duplicate output name; two entries would overwrite each other`);
    } else {
      seenNames.add(name);
    }
  }
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
  prepared.push({ entry, source, digest, bytes });
}

// Bind the declared trust state to the bytes that are about to be published.
for (const { entry, source, bytes } of prepared) {
  await assertClaimsMatch(entry, source, bytes);
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

  // Carry every declared field through, so build and provenance metadata the
  // manifest lists (publisher, certificateThumbprint, sourceCommit, ...) is not
  // silently dropped. "source" is a local path and never published.
  const item = {};
  for (const key of Object.keys(entry)) {
    if (key === 'source' || key.startsWith('_')) continue;
    item[key] = entry[key];
  }
  item.sha256 = digest;
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
