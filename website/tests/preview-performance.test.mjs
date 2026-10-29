import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../pack-player.js', import.meta.url), 'utf8');
const hash = async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
function runtime(extra = {}) {
  const context = vm.createContext({ window: {}, navigator: { platform: 'MacIntel' },
    matchMedia: () => ({ matches: false }), document: { querySelector: () => null },
    crypto: webcrypto, Blob, TextDecoder, Uint8Array, AbortSignal, DOMException,
    setTimeout: fn => { queueMicrotask(fn); }, ...extra });
  vm.runInContext(source.replace('window.NiuMaAppearance =',
    'globalThis.internal = { readWithRetry, nativeWoodfish }; window.NiuMaAppearance ='), context);
  return context;
}
test('body timeout retries once with a fresh signal; cancellation does not retry', async () => {
  const signals = [];
  const c = runtime({ fetch: async (_url, init) => {
    signals.push(init.signal);
    return { ok: true, arrayBuffer: async () => {
      if (signals.length === 1) throw new DOMException('body stalled', 'TimeoutError');
      assert.equal(init.signal.aborted, false); return new Uint8Array([1, 2]).buffer;
    }};
  }});
  await c.internal.readWithRetry('/layer.png', {});
  assert.equal(signals.length, 2); assert.notEqual(signals[0], signals[1]);
  let calls = 0;
  c.fetch = async () => { calls++; throw new DOMException('cancelled', 'AbortError'); };
  await assert.rejects(c.internal.readWithRetry('/layer.png', {}), { name: 'AbortError' });
  assert.equal(calls, 1);
});
test('derived covers are checked against their digest and server identity', async () => {
  const bytes = Buffer.from('cover bytes');
  const identity = { assetId: 'official.test', previewRevision: 'a'.repeat(64) };
  const index = { packs: { test: { id: identity.assetId, assetSha256: identity.previewRevision,
    web: { basePath: '/assets/previews/packs-web/test/hash/', files: { 'cover.png': { sha256: await hash(bytes) } } } } } };
  const indexBytes = Buffer.from(JSON.stringify(index));
  const paths = [];
  const c = runtime({ document: { querySelector: () => ({ content: '' }) },
    fetch: async path => { paths.push(path); return new Response(path.includes('source-map') ? indexBytes : bytes); } });
  await c.window.NiuMaAppearance.cover('test', identity);
  assert.equal(paths.length, 2);
  await assert.rejects(c.window.NiuMaAppearance.cover('test', { ...identity, previewRevision: 'b'.repeat(64) }), /preview_release_mismatch/);
  assert.equal(paths.length, 2, 'mismatch cannot request stale art');
  const corrupt = runtime({ fetch: async path => new Response(path.includes('source-map') ? indexBytes : Buffer.from('corrupt')) });
  await assert.rejects(corrupt.window.NiuMaAppearance.cover('test', identity), /preview_release_mismatch/);
});
test('versioned index uses a frozen path and verifies its bytes', async () => {
  const bytes = Buffer.from(JSON.stringify({ packs: {} })), digest = await hash(bytes), paths = [];
  const c = runtime({ document: { querySelector: () => ({ content: digest }) },
    fetch: async path => { paths.push(path); return new Response(bytes); } });
  assert.equal(await c.window.NiuMaAppearance.cover('missing'), null);
  assert.deepEqual(paths, [`/assets/previews/index/${digest}.json`]);
});
test('native mallet crop follows the source-to-derivative scale', () => {
  const c = runtime(), draws = [];
  const context = new Proxy({ drawImage: (...args) => draws.push(args) }, { get: (obj, key) => obj[key] || (() => {}) });
  const spec = { center: [0,0], scale: 1, shadow: [0,0,1,1], body:[0,0,1,1], pivot:[0,0],
    angle:[0,0], shaft:[0,0,1,1], head:[0,0,1,1], shaftSourceX:108, headSourceWidth:145 };
  const mallet = { width:480, height:120 };
  c.internal.nativeWoodfish(context, { renderer:'native-woodfish-v2', macOS:spec,
    sourceDimensions: { 'mallet.png': { width:600, height:150 } } },
    new Map([['body.png', { width:1,height:1 }], ['mallet.png', mallet]]), 0, null);
  assert.equal(draws[1][1], 86.4); assert.equal(draws[2][3], 116);
});
test('failed animation leaves an existing cover in place', async () => {
  let flow = await readFile(new URL('../free-flow.js', import.meta.url), 'utf8');
  // Execute the actual preview function and its helpers without starting page routing.
  flow = flow.slice(flow.indexOf('const $ ='), flow.indexOf('function summary(')).replace(/^export /gm, '');
  const children = [{ tagName:'IMG' }];
  const container = { dataset:{}, childNodes:children, replaceChildren: () => assert.fail('must retain cover') };
  const c = vm.createContext({ window: { NiuMaAppearance: { load:async () => { throw new Error('network'); } } },
    document:{}, location:{}, localStorage:{}, URL, Blob });
  vm.runInContext(flow + '\nglobalThis.previewTest = preview;', c);
  await assert.rejects(c.previewTest(container, { builtin:true }), /预览暂时无法加载/);
  assert.equal(container.childNodes, children);
});
test('carousel assigns each deferred source once over multiple complete rotations', async () => {
  const listeners = new Map();
  const panels = ['count','calendar','offwork','easter'].map(key => ({ dataset:{featurePanel:key}, addEventListener(){},
    classList:{ values:new Set(), toggle(name,on){ on ? this.values.add(name) : this.values.delete(name); }, contains(name){return this.values.has(name);} } }));
  const images = panels.map((panel,i) => ({ dataset:{src:`/image-${i}.png`}, assigned:[],
    set src(value){this.assigned.push(value);}, removeAttribute(){delete this.dataset.src;}, closest:()=>panel }));
  const stage = { querySelectorAll: selector => selector.includes('data-feature-panel') ? panels : selector.includes('data-feature-tab') ? [] : images,
    querySelector:()=>null, addEventListener:(type,fn)=>listeners.set(type,fn) };
  const context = vm.createContext({ document:{ querySelector: selector=>selector==='[data-feature-stage]'?stage:null,
    querySelectorAll:()=>[], addEventListener(){} }, matchMedia:()=>({matches:true,addEventListener(){}}),
    sessionStorage:{getItem:()=>0}, addEventListener(){}, removeEventListener(){},
    setInterval:()=>1, clearInterval(){}, IntersectionObserver:class{observe(){}},
    setTimeout:()=>1, clearTimeout(){} });
  let carousel = await readFile(new URL('../assets/home-feature.js', import.meta.url),'utf8');
  carousel = carousel.replace('  show(0);','  globalThis.carouselShow = show;\n  show(0);');
  vm.runInContext(carousel,context);
  for(let i=0;i<12;i++)context.carouselShow(i%4);
  for(const image of images)assert.equal(image.assigned.length,1);
});
test('web stills contain only embedded PNGs and retain the shared canvas', async () => {
  const index=JSON.parse(await readFile(new URL('../assets/previews/source-map.json',import.meta.url),'utf8'));
  for(const [slug,entry] of Object.entries(index.packs)) {
    const cover=await readFile(new URL('..'+entry.web.basePath+entry.web.cover,import.meta.url),'utf8');
    assert.match(cover,/viewBox="0 0 240 170"/);
    assert.doesNotMatch(cover,/<script|<foreignObject|\bon\w+=/i);
    const refs=[...cover.matchAll(/href="([^"]+)"/g)].map(m=>m[1]);
    const manifest=JSON.parse(await readFile(new URL(`../assets/previews/packs/${slug}/manifest.json`,import.meta.url),'utf8'));
    assert.equal(refs.length,manifest.renderer ? 3 : manifest.layers.length,slug+' contains full phase-zero layers');
    assert.ok(refs.every(ref=>ref.startsWith('data:image/png;base64,')),slug+' has no external dependency');
  }
});
test('overlapping hero interactions share one player upgrade', async () => {
  const src=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const body=src.slice(src.indexOf('const stage ='),src.indexOf('function strike()'));
  let calls=0,finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const context=vm.createContext({document:{querySelector:()=>({querySelector:()=>({querySelector:()=>null})}),getElementById:()=>({})},
    matchMedia:()=>({matches:false}),window:{NiuMaAppearance:{load:()=>{calls++;return pending;}}}});
  vm.runInContext(body+'\nglobalThis.ensure = ensurePlayer;',context);
  const first=context.ensure(),second=context.ensure(),third=context.ensure();
  assert.equal(calls,1);finish({strike(){}});
  await Promise.all([first,second,third]);assert.equal(calls,1);
});
