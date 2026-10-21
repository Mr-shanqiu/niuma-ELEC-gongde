#!/usr/bin/env node

// Every local asset a page points at must exist in the staged site.
// A missing ES module import fails the whole module graph, so the page can
// render while its scripts silently never run; catch that before deploying.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const stage = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: verify-website-references.mjs <staged-site>');

const pages = (await readdir(stage)).filter(name => name.endsWith('.html'));
if (!pages.length) throw new Error('Staged website has no HTML pages');

// Skip anything that is not a same-origin file path: absolute URLs, protocol
// relative URLs, fragment links and query-only links are not local assets.
function localPath(value) {
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/i.test(trimmed)) return null;
  const path = trimmed.split(/[?#]/)[0];
  if (!path) return null;
  const relative = path.replace(/^\//, '');
  // `%23` is an encoded '#'. Inline SVG data URIs contain url(%23filter),
  // which points at an element id inside the same document, not at a file.
  if (!relative || relative.startsWith('%23')) return null;
  return relative;
}

const missing = [];
for (const page of pages) {
  const html = await readFile(join(stage, page), 'utf8');
  const references = [];
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/gi)) references.push(match[2]);
  for (const match of html.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) references.push(match[2]);
  for (const match of html.matchAll(/\b(?:import|export)\s+(?:[^;'"]*?\s+from\s+)?(['"])([^'"\r\n]+)\1/g)) references.push(match[2]);
  for (const value of references) {
    const path = localPath(value);
    if (!path || !/\.[a-z0-9]{2,5}$/i.test(path)) continue;
    if (!existsSync(join(stage, path))) missing.push(`${page} -> ${path}`);
  }
}
// Stylesheets and scripts reach assets through url() and relative imports.
const runtimeRoot = join(stage, 'assets', 'runtime');
const sources = [];
for (const name of await readdir(stage)) {
  if (/\.(?:js|css)$/.test(name)) sources.push({ name, dir: stage });
}
for (const revision of await readdir(runtimeRoot).catch(() => [])) {
  const directory = join(runtimeRoot, revision);
  for (const name of await readdir(directory)) {
    if (/\.(?:js|css)$/.test(name)) sources.push({ name, dir: directory });
  }
}
for (const { name, dir } of sources) {
  const source = await readFile(join(dir, name), 'utf8');
  const references = [];
  if (name.endsWith('.css')) {
    for (const match of source.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) references.push(match[2]);
  } else {
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^;'"]*?\s+from\s+)?(['"])([^'"\r\n]+)\1/g)) references.push(match[2]);
    for (const match of source.matchAll(/\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)) references.push(match[2]);
  }
  for (const value of references) {
    const path = localPath(value);
    if (!path) continue;
    // Root-absolute URLs resolve against the site root, everything else
    // against the file that names it.
    const target = value.trim().startsWith('/') ? join(stage, path) : join(dir, path);
    if (!existsSync(target)) missing.push(`${name} -> ${value.trim()}`);
  }
}

if (missing.length) {
  console.error('ERROR: staged site references files it does not contain:');
  for (const entry of [...new Set(missing)].sort()) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(`SITE_REFERENCES_OK pages=${pages.length} sources=${sources.length}`);
