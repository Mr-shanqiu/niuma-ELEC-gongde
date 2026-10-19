#!/usr/bin/env node

// Give each complete browser runtime an immutable directory. Root files remain
// available for legacy entry points; two prior runtimes survive a deployment.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, posix } from 'node:path';

const stage = resolve(process.argv[2] || '');
const previousArchive = process.argv[3] ? resolve(process.argv[3]) : null;
if (!process.argv[2]) throw new Error('Usage: version-website-assets.mjs <staged-site> [previous-site-archive]');
const origin = 'https://gongde.zqscreen.cn';
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const names = (await readdir(stage)).sort();
const runtimeFiles = names.filter(name => /^[a-z][a-z0-9-]*\.(?:js|css)$/.test(name));
for (const file of ['assets/site-v4.js', 'assets/site-v4.css', 'assets/journey.js', 'assets/journey.css',
  'assets/locale-site.js', 'assets/locale-en.css']) {
  try { await readFile(join(stage, file)); runtimeFiles.push(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
runtimeFiles.sort();
const htmlFiles = new Set(names.filter(name => /^[a-z0-9-]+\.html$/.test(name)));
if (!runtimeFiles.length || !htmlFiles.has('index.html')) throw new Error('Staged website is incomplete');

function localURL(value) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null;
  const url = new URL(value, `${origin}/`);
  return url.origin === origin ? url : null;
}

function relocateCSS(source, file) {
  return source.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (whole, quote, value) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value.trim())) return whole;
    const url = new URL(value.trim(), `${origin}/${file}`);
    return `url("${url.pathname}${url.search}${url.hash}")`;
  });
}

const contents = new Map();
function relocateJS(source, file) {
  const rewrite = (whole, before, quote, value, after = '') => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return whole;
    const url = new URL(value, `${origin}/${file}`), target = url.pathname.slice(1);
    if (url.origin !== origin || !runtimeFiles.includes(target)) return whole;
    let relative = posix.relative(posix.dirname(file), target);
    if (!relative.startsWith('.')) relative = './' + relative;
    return `${before}${quote}${relative}${quote}${after}`;
  };
  return source.replace(/(\b(?:import|export)\s+(?:[^;'\"]*?\s+from\s+)?)(['"])([^'"\r\n]+)\2/g,
    (whole, before, quote, value) => rewrite(whole, before, quote, value))
    .replace(/(\bimport\s*\(\s*)(['"])([^'"\r\n]+)\2(\s*\))/g, rewrite);
}
for (const file of runtimeFiles) {
  const source = await readFile(join(stage, file), 'utf8');
  contents.set(file, file.endsWith('.css') ? relocateCSS(source, file) : relocateJS(source, file));
}
const files = runtimeFiles.map(file => ({ name: file, sha256: digest(contents.get(file)), bytes: Buffer.byteLength(contents.get(file)) }));
let previewIndexHash = null;
try { previewIndexHash = digest(await readFile(join(stage, 'assets/previews/source-map.json'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const revision = digest(JSON.stringify({ profile: 'browser-runtime-v1', files }));
const prefix = `/assets/runtime/${revision}/`;
await mkdir(join(stage, 'assets', 'runtime', revision), { recursive: true });
for (const file of runtimeFiles) {
  const target = join(stage, 'assets', 'runtime', revision, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents.get(file));
}

function versionResource(value) {
  const url = localURL(value);
  const file = url?.pathname.slice(1).replace(/^assets\/runtime\/[a-f0-9]{64}\//, '');
  return file && contents.has(file) ? `${prefix}${file}${url.hash}` : value;
}

for (const file of htmlFiles) {
  let html = await readFile(join(stage, file), 'utf8');
  html = html.replace(/(\b(?:src|href)\s*=\s*)(['"])([^'"]+)\2/gi, (whole, attr, quote, value) => {
    const resource = versionResource(value);
    if (resource !== value) return `${attr}${quote}${resource}${quote}`;
    if (!/^href/i.test(attr)) return whole;
    const url = localURL(value);
    if (!url || !htmlFiles.has(url.pathname.slice(1))) return whole;
    url.searchParams.set('entry', revision.slice(0, 16));
    return `${attr}${quote}${url.pathname}${url.search}${url.hash}${quote}`;
  });
  html = html.replace(/(\bimport\s*\(\s*)(['"])([^'"]+)\2(\s*\))/g,
    (whole, before, quote, value, after) => `${before}${quote}${versionResource(value)}${quote}${after}`);
  html = html.replace(/<script\b(?=[^>]*\btype\s*=\s*['"]module['"])[^>]*>[\s\S]*?<\/script>/gi, script =>
    script.replace(/(\b(?:import|export)\s+(?:[^;'\"]*?\s+from\s+)?)(['"])([^'\"\r\n]+)\2/g,
      (whole, before, quote, value) => `${before}${quote}${versionResource(value)}${quote}`));
  const meta = `<meta name="gongde-site-build" content="${revision}">`;
  html = /<meta\s+name=["']gongde-site-build["'][^>]*>/i.test(html)
    ? html.replace(/<meta\s+name=["']gongde-site-build["'][^>]*>/i, meta)
    : html.replace(/<head(\s[^>]*)?>/i, match => `${match}\n  ${meta}`);
  if (previewIndexHash) {
    const previewMeta = `<meta name="gongde-preview-index" content="${previewIndexHash}">`;
    html = /<meta\s+name=["']gongde-preview-index["'][^>]*>/i.test(html)
      ? html.replace(/<meta\s+name=["']gongde-preview-index["'][^>]*>/i, previewMeta)
      : html.replace(/<head(\s[^>]*)?>/i, match => `${match}\n  ${previewMeta}`);
  }
  await writeFile(join(stage, file), html);
}

const adminPattern = /^admin\/assets\/[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]{8,64}\.(?:js|css)$/;
let currentAdmin = [];
try {
  currentAdmin = (await readdir(join(stage, 'admin', 'assets')))
    .map(name => `admin/assets/${name}`).filter(name => adminPattern.test(name)).sort();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let runtimeVersions = [revision];
let adminBundles = currentAdmin.length ? [currentAdmin] : [];
let retainedFiles = 0;

if (previousArchive) {
  if (!/^gongde-site-[a-f0-9]{64}\.tar\.gz$/.test(basename(previousArchive))) throw new Error('Previous archive must be a frozen site candidate');
  const checksum = (await readFile(`${previousArchive}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  if (!hex.test(checksum) || digest(await readFile(previousArchive)) !== checksum) throw new Error('Previous archive checksum mismatch');
  const members = execFileSync('tar', ['-tzf', previousArchive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
  const manifestMember = members.find(name => name.replace(/^\.\//, '') === 'assets/build/runtime-assets.json');
  let previous = null;
  if (manifestMember) {
    previous = JSON.parse(execFileSync('tar', ['-xzOf', previousArchive, manifestMember], { encoding: 'utf8', maxBuffer: 64 * 1024 }));
    if (previous.schemaVersion !== 1 || !Array.isArray(previous.runtimeVersions) || !previous.runtimeVersions.every(value => hex.test(value))) {
      throw new Error('Previous runtime manifest is invalid');
    }
    runtimeVersions = [...new Set([revision, ...previous.runtimeVersions])].slice(0, 3);
  }
  const previousAdmin = previous?.adminBundles || [members.map(name => name.replace(/^\.\//, '')).filter(name => adminPattern.test(name))];
  for (const bundle of previousAdmin) {
    if (!Array.isArray(bundle) || !bundle.every(name => adminPattern.test(name))) throw new Error('Previous admin bundle manifest is invalid');
    if (bundle.length && !adminBundles.some(existing => JSON.stringify(existing) === JSON.stringify(bundle))) adminBundles.push(bundle);
  }
  adminBundles = adminBundles.slice(0, 3);
  const keepAdmin = new Set(adminBundles.flat());
  const keepRuntime = new Set(runtimeVersions.slice(1));
  const selected = members.filter(member => {
    const name = member.replace(/^\.\//, '');
    const match = name.match(/^assets\/runtime\/([a-f0-9]{64})\/(?:assets\/)?[a-z][a-z0-9-]*\.(?:js|css)$/);
    return (match && keepRuntime.has(match[1])) || keepAdmin.has(name);
  });
  if (selected.length) {
    const temporary = await mkdtemp(join(stage, '.previous-runtime-'));
    try {
      execFileSync('tar', ['-xzf', previousArchive, '-C', temporary, ...selected], { stdio: 'pipe' });
      for (const member of selected) {
        const relative = member.replace(/^\.\//, '');
        const target = join(stage, relative);
        await mkdir(dirname(target), { recursive: true });
        const bytes = await readFile(join(temporary, relative));
        try {
          const existing = await readFile(target);
          if (!existing.equals(bytes)) throw new Error(`Immutable asset collision: ${relative}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await copyFile(join(temporary, relative), target);
          retainedFiles += 1;
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

await mkdir(join(stage, 'assets', 'build'), { recursive: true });
await writeFile(join(stage, 'assets', 'build', 'runtime-assets.json'), `${JSON.stringify({
  schemaVersion: 1, profile: 'browser-runtime-v1', revision, runtimeVersions, adminBundles, files,
}, null, 2)}\n`);
console.log(`SITE_RUNTIME_REVISION=${revision}`);
console.log(`SITE_RUNTIME_RETAINED_FILES=${retainedFiles}`);
