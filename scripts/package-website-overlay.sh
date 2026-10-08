#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist/gongde-deploy"
PROFILE=website
if test "$#" -eq 1; then
  BASE=$1
elif test "$#" -eq 2 && { test "$1" = "--community-preview" || test "$1" = "--community-ui" || test "$1" = "--community-cache" || test "$1" = "--appearance-numbering" || test "$1" = "--creator-guide"; }; then
  PROFILE=${1#--}
  BASE=$2
else
  echo "usage: package-website-overlay.sh [--community-preview|--community-ui|--community-cache|--appearance-numbering|--creator-guide] BASE_ARCHIVE" >&2
  exit 64
fi
case "$PROFILE" in
  community-preview) FILES="community-preview.js creator-community.css" ;;
  community-ui) FILES="community-preview.js community.js install.html creator-guide.html" ;;
  community-cache) FILES="community.html community.js" ;;
  creator-guide) FILES="creator-guide.html assets/creator-guide.zip" ;;
  website) FILES="index.html app.js styles.css install.html checkout.html checkout.js support.html support.js" ;;
esac
if test "$PROFILE" = appearance-numbering; then
  exec node --input-type=module - "$ROOT" "$BASE" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const root = process.argv[2], base = process.argv[3];
const out = path.join(root, 'dist/gongde-deploy');
const limit = 20 * 1024 * 1024, expandedLimit = 256 * 1024 * 1024;
const fixed = ['index.html', 'app.js', 'community.html', 'community.js', 'install.html', 'admin/index.html'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const compareNames = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
let stage, pending, published = false, publishedArchive = false, archive;

function safeName(raw, directory = false) {
  if (!raw || /[\x00-\x1f\x7f\\]/u.test(raw) || raw.startsWith('/') || /^[A-Za-z]:/u.test(raw)) fail('unsafe archive path');
  let name = raw.startsWith('./') ? raw.slice(2) : raw;
  if (directory && name.endsWith('/')) name = name.slice(0, -1);
  if (directory && (name === '' || name === '.')) return '';
  if (name.split('/').some(part => !part || part === '.' || part === '..')) fail('archive path escape or noncanonical path');
  return name;
}

function regular(rootDirectory, relative) {
  const parts = relative.split('/');
  let current = rootDirectory;
  const rootStat = fs.lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('source/base root must be a regular directory');
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index] || parts[index] === '.' || parts[index] === '..') fail('source/base path escape');
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      fail('source/base must be regular files with no symbolic-link parents: ' + relative);
    }
  }
  const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > expandedLimit) fail('source/base regular file exceeds size bound');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function textField(buffer) {
  const nul = buffer.indexOf(0), bytes = nul < 0 ? buffer : buffer.subarray(0, nul);
  const value = bytes.toString('utf8');
  if (!Buffer.from(value).equals(bytes)) fail('invalid UTF-8 archive name');
  return value;
}
function octal(buffer) {
  const text = textField(buffer).trim();
  if (!/^[0-7]+$/u.test(text)) fail('unsupported or invalid tar numeric field');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('tar numeric field outside bounds');
  return value;
}
function paxAttributes(body) {
  const result = {};
  let cursor = 0;
  while (cursor < body.length) {
    const space = body.indexOf(32, cursor);
    if (space < 0 || !/^[1-9][0-9]*$/u.test(body.subarray(cursor, space).toString('ascii'))) fail('invalid PAX record');
    const length = Number(body.subarray(cursor, space).toString('ascii'));
    const end = cursor + length;
    if (!Number.isSafeInteger(length) || end > body.length || end <= space + 2 || body[end - 1] !== 10) fail('invalid PAX length');
    const bytes = body.subarray(space + 1, end - 1), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail('invalid PAX UTF-8');
    const equals = text.indexOf('=');
    if (equals < 1) fail('invalid PAX attribute');
    const key = text.slice(0, equals);
    if (key === 'linkpath' || /sparse/i.test(key)) fail('tar links/sparse entries are forbidden');
    if (Object.hasOwn(result, key)) fail('duplicate PAX attribute');
    result[key] = text.slice(equals + 1);
    cursor = end;
  }
  return result;
}

// Validate tar headers before any extraction. Materialize only regular files
// ourselves, never delegate untrusted archive paths/links to tar extraction.
function readTree(compressed) {
  const bytes = gunzipSync(compressed, { maxOutputLength: expandedLimit });
  if (bytes.length % 512 !== 0) fail('truncated tar');
  const files = new Map(), directories = new Set();
  let position = 0, localPax = {}, globalPax = {}, longName = null, terminated = false;
  while (position + 512 <= bytes.length) {
    const header = bytes.subarray(position, position + 512); position += 512;
    if (header.every(byte => byte === 0)) {
      if (position + 512 > bytes.length || !bytes.subarray(position).every(byte => byte === 0)) fail('invalid tar terminator');
      if (Object.keys(localPax).length || longName !== null) fail('dangling tar metadata');
      terminated = true; break;
    }
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== octal(header.subarray(148, 156))) fail('tar header checksum mismatch');
    const size = octal(header.subarray(124, 136)), next = position + Math.ceil(size / 512) * 512;
    if (next > bytes.length || size > expandedLimit) fail('tar entry outside size bounds');
    const body = bytes.subarray(position, position + size); position = next;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const prefix = textField(header.subarray(345, 500));
    const raw = (prefix ? prefix + '/' : '') + textField(header.subarray(0, 100));
    if (type === 'x' || type === 'g') {
      safeName(raw);
      const attributes = paxAttributes(body);
      if (type === 'g') {
        if (attributes.path !== undefined || attributes.size !== undefined) fail('global PAX path/size forbidden');
        globalPax = { ...globalPax, ...attributes };
      } else localPax = { ...localPax, ...attributes };
      continue;
    }
    if (type === 'L') {
      if (longName !== null) fail('duplicate GNU long name');
      longName = textField(body); safeName(longName); continue;
    }
    if (type !== '0' && type !== '5') fail('base contains a symbolic link, hard link or non-regular tar entry');
    safeName(raw, type === '5');
    const attributes = { ...globalPax, ...localPax };
    if (attributes.size !== undefined && attributes.size !== String(size)) fail('ambiguous PAX size');
    if (longName !== null && attributes.path !== undefined && longName !== attributes.path) fail('ambiguous tar path');
    const name = safeName(attributes.path ?? longName ?? raw, type === '5');
    localPax = {}; longName = null;
    if (!name) continue;
    if (files.has(name) || directories.has(name)) fail('duplicate archive path');
    if (type === '5') { if (size !== 0) fail('nonempty directory entry'); directories.add(name); }
    else files.set(name, body);
  }
  if (!terminated || !files.size) fail('empty or unterminated base archive');
  for (const name of [...files.keys(), ...directories]) {
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); if (files.has(parts.join('/'))) fail('archive file/directory collision'); }
  }
  return { files, directories };
}

function treeDigest(files) {
  const lines = [...files.keys()].sort(compareNames).map(name => `${digest(files.get(name))}  ./${name}\n`).join('');
  return digest(lines);
}

function adminReferences(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/gu, '');
  const tags = /<\/?([A-Za-z][A-Za-z0-9:-]*)\b/gu;
  const references = new Set();
  let match;
  while ((match = tags.exec(clean))) {
    let end = tags.lastIndex, quote = null;
    for (; end < clean.length; end += 1) {
      const char = clean[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === clean.length) fail('unterminated admin HTML tag');
    const closing = clean[match.index + 1] === '/', tag = match[1].toLowerCase();
    const contents = clean.slice(tags.lastIndex, end);
    tags.lastIndex = end + 1;
    if (closing) continue;
    const attributes = {};
    const attribute = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
    let found;
    while ((found = attribute.exec(contents))) {
      const key = found[1].toLowerCase();
      if (Object.hasOwn(attributes, key)) fail('duplicate admin HTML attribute');
      attributes[key] = found[2] ?? found[3] ?? found[4] ?? '';
    }
    let url, extension;
    if (tag === 'script' && Object.hasOwn(attributes, 'src')) { url = attributes.src; extension = 'js'; }
    if (tag === 'link' && Object.hasOwn(attributes, 'href')) {
      const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/u);
      if (rel.includes('stylesheet')) { url = attributes.href; extension = 'css'; }
      else if (rel.includes('modulepreload')) { url = attributes.href; extension = 'js'; }
      else if (/\.(?:js|css)(?:[?#]|$)/iu.test(attributes.href) || /assets\//iu.test(attributes.href)) {
        url = attributes.href;
      }
    }
    if (url !== undefined) {
      const asset = /^(?:\/admin\/assets\/|\.\/assets\/)([A-Za-z0-9][A-Za-z0-9._-]{0,119}-[A-Za-z0-9_-]{6,64}\.(js|css))$/u.exec(url);
      if (!asset || (extension && asset[2] !== extension)) fail('illegal admin asset reference: ' + url);
      references.add('admin/assets/' + asset[1]);
    }
    if (['script', 'style', 'textarea', 'title'].includes(tag)) {
      const close = new RegExp('</' + tag + '\\s*>', 'igu'); close.lastIndex = tags.lastIndex;
      const ending = close.exec(clean);
      if (!ending) fail('unterminated admin raw-text element');
      tags.lastIndex = close.lastIndex;
    }
  }
  if (![...references].some(name => name.endsWith('.js'))) fail('built admin entry has no hashed JS reference');
  return [...references].sort(compareNames);
}

try {
  if (fs.realpathSync(root) !== path.resolve(root)) fail('project root contains a symbolic link');
  const basename = path.basename(base), identity = /^gongde-site-([a-f0-9]{64})\.tar\.gz$/u.exec(basename);
  if (!identity || base !== path.join(out, basename)) fail('base must be a direct immutable local gongde-site archive');
  const compressed = regular(root, 'dist/gongde-deploy/' + basename);
  if (compressed.length > limit) fail('base archive exceeds the 20MiB limit');
  const checksum = regular(root, 'dist/gongde-deploy/' + basename + '.sha256').toString('utf8');
  const expected = /^([a-f0-9]{64})[ \t]+\*?([^\r\n]+)\r?\n?$/u.exec(checksum);
  const actual = digest(compressed);
  if (!expected || expected[2] !== basename || expected[1] !== actual) fail('base archive SHA256 mismatch or invalid checksum identity');
  const { files: baseFiles, directories } = readTree(compressed);
  const baseTree = treeDigest(baseFiles);
  if (baseTree !== identity[1]) fail('base tree does not match its immutable release name');
  const files = new Map(baseFiles), source = new Map();
  for (const name of fixed) {
    if (!baseFiles.has(name)) fail('overlay file missing from base: ' + name);
    source.set(name, regular(root, 'website/' + name));
  }
  const assets = adminReferences(source.get('admin/index.html').toString('utf8'));
  for (const name of assets) source.set(name, regular(root, 'website/' + name));
  const whitelist = [...fixed, ...assets];
  const replacements = [], additions = [], details = [];
  let totalBytes = 0;
  for (const name of whitelist) {
    const bytes = source.get(name), previous = baseFiles.get(name);
    if (directories.has(name)) fail('overlay asset collides with a base directory');
    files.set(name, bytes);
    (previous ? replacements : additions).push(name);
    details.push({ path: name, operation: previous ? 'replace' : 'add',
      changed: !previous || !previous.equals(bytes), beforeSha256: previous ? digest(previous) : null, afterSha256: digest(bytes) });
  }
  for (const [name, bytes] of files) {
    totalBytes += bytes.length;
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); if (files.has(parts.join('/'))) fail('overlay file/directory collision'); }
  }
  if (totalBytes > expandedLimit) fail('overlay expanded tree exceeds bound');
  const tree = treeDigest(files);
  archive = path.join(out, `gongde-site-${tree}.tar.gz`);
  for (const target of [archive, archive + '.sha256']) {
    try { fs.lstatSync(target); fail('archive or checksum already exists; refusing immutable overwrite'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gongde-numbering-overlay-stage-'));
  const treeDirectory = path.join(stage, 'tree'); fs.mkdirSync(treeDirectory, { mode: 0o700 });
  for (const name of directories) fs.mkdirSync(path.join(treeDirectory, name), { recursive: true, mode: 0o755 });
  for (const [name, bytes] of files) {
    const destination = path.join(treeDirectory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 });
  }
  pending = fs.mkdtempSync(path.join(out, '.appearance-numbering-pending-'));
  const temporaryArchive = path.join(pending, 'site.tar.gz');
  const packed = spawnSync('/usr/bin/tar', ['-C', treeDirectory, '-czf', temporaryArchive, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8', timeout: 30000, maxBuffer: 262144
  });
  if (packed.error || packed.status !== 0) fail('offline tar packaging failed');
  const archiveBytes = fs.readFileSync(temporaryArchive);
  if (archiveBytes.length > limit) fail('archive exceeds the 20MiB static deployment limit');
  const archiveSha = digest(archiveBytes);
  const temporaryChecksum = path.join(pending, 'site.sha256');
  fs.writeFileSync(temporaryChecksum, `${archiveSha}  ${path.basename(archive)}\n`, { flag: 'wx', mode: 0o644 });
  // Both links are exclusive creations on the output filesystem. No overwrite
  // window, even if another producer publishes the same tree concurrently.
  fs.linkSync(temporaryArchive, archive); publishedArchive = true;
  fs.linkSync(temporaryChecksum, archive + '.sha256'); published = true;
  const receipt = { profile: 'appearance-numbering', baseArchive: base, baseTreeSha256: baseTree,
    baseArchiveSha256: actual, replaced: replacements, added: additions, files: details,
    archive, treeSha256: tree, archiveSha256: archiveSha, bytes: archiveBytes.length };
  const values = { BASE_ARCHIVE: base, OVERLAY_PROFILE: 'appearance-numbering', BASE_TREE_SHA256: baseTree,
    BASE_ARCHIVE_SHA256: actual, OVERLAY_FILES: whitelist.join(','), OVERLAY_REPLACED_FILES: replacements.join(','),
    OVERLAY_ADDED_FILES: additions.join(','), SITE_ARCHIVE: archive, SITE_TREE_SHA256: tree,
    SITE_ARCHIVE_SHA256: archiveSha, SITE_ARCHIVE_BYTES: archiveBytes.length, OVERLAY_RECEIPT_JSON: JSON.stringify(receipt) };
  for (const [key, value] of Object.entries(values)) process.stdout.write(`${key}=${value}\n`);
} catch (error) {
  process.stderr.write(`appearance-numbering overlay refused: ${error.message}\n`); process.exitCode = 65;
} finally {
  if (!published && publishedArchive && pending) {
    try {
      const owned = fs.lstatSync(path.join(pending, 'site.tar.gz')), target = fs.lstatSync(archive);
      if (owned.dev === target.dev && owned.ino === target.ino) fs.unlinkSync(archive);
    } catch {}
  }
  if (pending) fs.rmSync(pending, { recursive: true, force: true });
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
}
NODE
fi
case "$BASE" in
  "$OUT"/gongde-site-*.tar.gz) ;;
  *) echo "Base must be a local gongde-site archive" >&2; exit 64 ;;
esac
test -f "$BASE" && test -f "$BASE.sha256"
EXPECTED=$(awk 'NR == 1 { print $1 }' "$BASE.sha256")
ACTUAL=$(shasum -a 256 "$BASE" | awk '{ print $1 }')
test "$EXPECTED" = "$ACTUAL"

if test "$PROFILE" = creator-guide; then
  STAGE=$(mktemp -d "$ROOT/.local-work/candidates/creator-guide-overlay.XXXXXX")
else
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/gongde-overlay.XXXXXX")
fi
cleanup() { find "$STAGE" -xdev -depth -delete 2>/dev/null || true; }
trap cleanup EXIT INT TERM
tar -xzf "$BASE" -C "$STAGE"
if find "$STAGE" -type l | grep -q .; then
  echo "Base contains a symbolic link" >&2
  exit 65
fi

BASE_TREE_SHA=not-checked
if test "$PROFILE" != website; then
  BASE_TREE_SHA=$(
    cd "$STAGE"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
      shasum -a 256 "$file"
    done | shasum -a 256 | awk '{ print $1 }'
  )
  BASE_NAME=$(basename "$BASE")
  EXPECTED_TREE=${BASE_NAME#gongde-site-}
  EXPECTED_TREE=${EXPECTED_TREE%.tar.gz}
  if test "$BASE_TREE_SHA" != "$EXPECTED_TREE"; then
    echo "Base tree does not match its immutable release name" >&2
    exit 65
  fi
  if ! test -f "$STAGE/community.html" || ! test -f "$STAGE/community.js"; then
    echo "base archive is missing community entry files" >&2
    exit 1
  fi
fi

for name in $FILES; do
  if ! test -f "$STAGE/$name" || ! test -f "$ROOT/website/$name"; then
    echo "overlay file missing from base or source: $name" >&2
    exit 1
  fi
  if test "$PROFILE" != website && test -L "$ROOT/website/$name"; then
    echo "Preview source must be a regular file, not a symbolic link" >&2
    exit 65
  fi
  cp "$ROOT/website/$name" "$STAGE/$name"
done

TREE_SHA=$(
  cd "$STAGE"
  find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done | shasum -a 256 | awk '{ print $1 }'
)
ARCHIVE="$OUT/gongde-site-$TREE_SHA.tar.gz"
if test -e "$ARCHIVE"; then
  echo "Archive already exists; refusing to overwrite an immutable release" >&2
  exit 65
fi
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$ARCHIVE" .
(cd "$OUT" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
SIZE=$(stat -f '%z' "$ARCHIVE")
if test "$SIZE" -gt 20971520; then
  echo "Archive exceeds the 20MiB static deployment limit" >&2
  exit 65
fi

printf 'BASE_ARCHIVE=%s\n' "$BASE"
printf 'OVERLAY_PROFILE=%s\n' "$PROFILE"
printf 'BASE_TREE_SHA256=%s\n' "$BASE_TREE_SHA"
printf 'BASE_ARCHIVE_SHA256=%s\n' "$ACTUAL"
printf 'OVERLAY_FILES=%s\n' "$(printf '%s' "$FILES" | tr ' ' ',')"
printf 'SITE_ARCHIVE=%s\n' "$ARCHIVE"
printf 'SITE_TREE_SHA256=%s\n' "$TREE_SHA"
printf 'SITE_ARCHIVE_SHA256=%s\n' "$(awk 'NR == 1 { print $1 }' "$ARCHIVE.sha256")"
printf 'SITE_ARCHIVE_BYTES=%s\n' "$SIZE"
