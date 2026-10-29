/* Native appearance contract: 240x170 artwork, bottom-left coordinates,
 * Schema 1/2: linear interpolation and uniform scale. Schema 3 additionally
 * declares per-layer interpolation and vertical scale in the same manifest.
 * No per-character CSS deformation, replacement artwork, or global easing. */
(() => {
  'use strict';
  const width = 240;
  const height = 170;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const duration = isMac ? 231 : 220;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // Native woodfish manifests are versioned. v1 describes one piece of mallet
  // artwork in a separate Windows coordinate space; v2 records the geometry
  // both clients now share. An unknown version is refused rather than drawn
  // as if it were the latest, so a future format cannot be misread silently.
  const nativeRenderers = new Set(['native-woodfish-v1', 'native-woodfish-v2']);
  const cache = new Map();
  const webAssets = new Map();
  let indexPromise;
  let requestScheduler = operation => operation();
  function setRequestScheduler(schedule) {
    if (typeof schedule === 'function') requestScheduler = schedule;
  }

  async function digest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
  }

  // One request plus at most one retry, with the deadline covering the body read
  // as well. A server that sends headers and then stalls is the same failure as
  // one that never answers, and must not hang a card forever. A cancelled task,
  // a 4xx or a digest mismatch are definite answers and are never retried:
  // re-fetching a release mismatch would only download the same wrong file.
  const attemptTimeout = 10000;
  function transientFailure(error) {
    if (error?.name === 'AbortError') return false;
    if (typeof error?.status === 'number') return error.status >= 500 && error.status !== 501;
    // A timeout or a network-level TypeError is worth one more try; anything
    // else (a parse or contract error) is this release's own answer.
    return error?.name === 'TimeoutError' || error?.name === 'TypeError';
  }
  async function readWithRetry(target, init) {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      const remaining = 16000 - (Date.now() - started);
      if (remaining <= 0) throw new DOMException('Preview timed out', 'TimeoutError');
      try {
        // Each attempt owns its deadline, including the response body.
        const response = await fetch(target, { ...init,
          signal: AbortSignal.timeout(Math.min(attemptTimeout, remaining)) });
        if (!response.ok) {
          const error = new Error('preview_resource_unavailable');
          error.status = response.status;
          throw error;
        }
        return await response.arrayBuffer();
      } catch (error) {
        if (attempt >= 1 || !transientFailure(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  async function checkedFetch(url, hash, options = {}) {
    return requestScheduler(async () => {
      // A derivative lives in a directory already named after its own contents,
      // so the query string would only make the URL unique for no benefit.
      const target = options.contentAddressed ? url : `${url}?sha256=${hash}`;
      const bytes = await readWithRetry(target, { cache: 'force-cache' });
      // Content-addressed paths do not replace verification of received bytes.
      if (await digest(bytes) !== hash) throw new Error('preview_release_mismatch');
      return bytes;
    }, { priority: 0 });
  }

  /** The generated preview index: one hash-checked read shared by every caller. */
  function previewIndex() {
    indexPromise ||= requestScheduler(async () => {
      const hash = document.querySelector('meta[name="gongde-preview-index"]')?.content;
      const versioned = /^[a-f0-9]{64}$/.test(hash || '');
      const bytes = await readWithRetry((versioned ? `/assets/previews/index/${hash}.json` : '/assets/previews/source-map.json'),
        { cache: versioned ? 'force-cache' : 'no-store' });
      if (versioned && await digest(bytes) !== hash) throw new Error('preview_release_mismatch');
      try { return JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new Error('preview_index_invalid'); }
    }, { priority: 0 }).catch(error => {
      // A failed index must not poison the page forever: clearing it makes the
      // next cover or retry ask again, while every card already painted keeps
      // its bytes.
      indexPromise = undefined;
      throw error;
    });
    return indexPromise;
  }

  function checkIdentity(entry, identity) {
    if (identity && (entry?.id !== identity.assetId || entry?.assetSha256 !== identity.previewRevision)) {
      throw new Error('preview_release_mismatch');
    }
  }
  async function resources(slug, identity) {
    const index = await previewIndex();
    checkIdentity(index.packs?.[slug], identity);
    if (!cache.has(slug)) {
      const pending = (async () => {
      const index = await previewIndex();
      if (index.schemaVersion !== 3 || !index.packs[slug]) throw new Error('preview_contract_missing');
      const entry = index.packs[slug];
      const base = `/assets/previews/packs/${slug}/`;
      const bytes = await checkedFetch(entry.files['manifest.json']?.publicPath || `${base}manifest.json`, entry.manifestSha256);
      const manifest = JSON.parse(new TextDecoder().decode(bytes));
      if (manifest.renderer && !nativeRenderers.has(manifest.renderer)) throw new Error('preview_contract_unsupported');
      const names = manifest.renderer ? ['body.png', 'mallet.png'] : [...new Set(manifest.layers.map((layer) => layer.image))];
      // A web derivative is optional: an older index has no `web` entry. When
      // it is missing, the content-addressed public copy of the delivery art is
      // the fallback, so a card can still animate rather than show nothing.
      // Derivative bytes are verified against the hash in the checked index.
      const web = entry.web;
      const url = (name) => (web?.files?.[name] && web.layers?.[name] !== undefined)
        ? `${web.basePath}${encodeURIComponent(String(web.layers[name]))}`
        : (entry.files[name]?.publicPath || `${base}${name}`);
      const images = new Map();
      await Promise.all(names.map(async (name) => {
        const file = entry.files[name];
        if (!file || file.sourceSha256 !== file.projectedSha256) throw new Error('preview_asset_not_exact');
        const derived = Boolean(web?.files?.[name]);
        const bytes = await checkedFetch(url(name), derived ? web.files[name].sha256 : file.sourceSha256, { contentAddressed: derived });
        images.set(name, await createImageBitmap(new Blob([bytes], { type: 'image/png' })));
      }));
      return { manifest, images, fingerprint: entry.manifestSha256, web: Boolean(web?.files) };
      })();
      // A failed load must not be remembered as this pack's answer: the retry
      // button would then fail instantly without asking the network again.
      pending.catch(() => { if (cache.get(slug) === pending) cache.delete(slug); });
      cache.set(slug, pending);
    }
    return cache.get(slug);
  }

  function sample(frames, phase, interpolation = 'linear') {
    if (phase <= frames[0].t) return frames[0];
    if (phase >= frames[frames.length - 1].t) return frames[frames.length - 1];
    for (let index = 1; index < frames.length; index++) {
      const right = frames[index];
      if (phase > right.t) continue;
      const left = frames[index - 1];
      let mix = (phase - left.t) / (right.t - left.t);
      if (interpolation === 'smoothstep') mix = mix * mix * (3 - 2 * mix);
      return Object.fromEntries(['x', 'y', 'rotation', 'scale', 'scale_y', 'alpha'].map((key) => {
        const fallback = key === 'scale_y' ? 1 : 0;
        const a = left[key] ?? fallback, b = right[key] ?? fallback;
        return [key, a + (b - a) * mix];
      }));
    }
    return frames[frames.length - 1];
  }

  function drawImage(ctx, image, rect, crop) {
    const [x, y, w, h] = rect;
    ctx.save();
    ctx.translate(x, y + h);
    ctx.scale(1, -1);
    ctx.drawImage(image, ...(crop || [0, 0, image.width, image.height]), 0, 0, w, h);
    ctx.restore();
  }

  // v1 Windows specs described a single mallet rotated as one piece, so the
  // preview had to fit that whole sweep into the canvas. Kept only for indexes
  // published before the two clients were aligned; new manifests use v2.
  function windowsWoodfishViewV1(spec) {
    const points = [];
    const corners = ([x, y, w, h]) => [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    points.push(...corners(spec.body), ...corners(spec.shadow));
    const angles = [spec.angle[0], spec.angle[0] - spec.angle[1]].map((value) => value * Math.PI / 180);
    const low = Math.min(...angles), high = Math.max(...angles);
    for (const [x, y] of corners(spec.mallet)) {
      const dx = x - spec.pivot[0], dy = y - spec.pivot[1];
      const candidates = [low, high];
      // Include axis extrema between the endpoints so every strike frame fits.
      const direction = Math.atan2(dy, dx);
      for (const extremum of [-direction, Math.PI / 2 - direction]) {
        const first = Math.ceil((low - extremum) / Math.PI);
        const last = Math.floor((high - extremum) / Math.PI);
        for (let turn = first; turn <= last; turn++) candidates.push(extremum + turn * Math.PI);
      }
      for (const angle of candidates) {
        points.push([
          spec.pivot[0] + dx * Math.cos(angle) - dy * Math.sin(angle),
          spec.pivot[1] + dx * Math.sin(angle) + dy * Math.cos(angle),
        ]);
      }
    }
    const left = Math.min(...points.map(([x]) => x));
    const right = Math.max(...points.map(([x]) => x));
    const top = Math.min(...points.map(([, y]) => y));
    const bottom = Math.max(...points.map(([, y]) => y));
    const scale = Math.min((width - 8) / (right - left), (height - 8) / (bottom - top));
    return {
      scale,
      x: (width - (right - left) * scale) / 2 - left * scale,
      y: (height - (bottom - top) * scale) / 2 - top * scale,
    };
  }

  function nativeWoodfish(ctx, manifest, images, phase, windowsView) {
    const t = phase < .42 ? phase / .42 : (phase - .42) / .58;
    const smooth = t * t * (3 - 2 * t);
    const amount = phase < .42 ? smooth : 1 - smooth;
    const body = images.get('body.png');
    const mallet = images.get('mallet.png');
    // v2 unified the two clients on the macOS geometry: Windows mirrors it
    // through y = 250 - y, and this canvas is already flipped to a bottom
    // origin, so the macOS numbers describe both. Only a v1 index still needs
    // the old Windows branch, which rotated one-piece artwork.
    const unified = manifest.renderer !== 'native-woodfish-v1';
    const spec = unified || isMac ? manifest.macOS : manifest.Windows;
    if (unified || isMac) {
      ctx.translate(spec.center[0], spec.center[1]);
      ctx.scale(spec.scale, spec.scale);
      ctx.translate(-spec.center[0], -spec.center[1]);
      const [x, y, w, h] = spec.shadow;
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill();
      drawImage(ctx, body, spec.body);
      ctx.translate(...spec.pivot);
      ctx.rotate((spec.angle[0] + spec.angle[1] * amount) * Math.PI / 180);
      // Source crops are native pixel coordinates, while web layers may be smaller.
      const sourceWidth = manifest.sourceDimensions?.['mallet.png']?.width;
      const sourceScale = sourceWidth ? mallet.width / sourceWidth : 1;
      const shaftX = spec.shaftSourceX * sourceScale;
      drawImage(ctx, mallet, spec.shaft, [shaftX, 0, mallet.width - shaftX, mallet.height]);
      drawImage(ctx, mallet, spec.head, [0, 0, Math.min(spec.headSourceWidth * sourceScale, mallet.width), mallet.height]);
    } else {
      // Native Windows uses top-left window coordinates. Fit the complete artwork
      // and mallet sweep into this preview instead of cropping the top 80px.
      ctx.translate(0, height); ctx.scale(1, -1);
      ctx.translate(windowsView.x, windowsView.y);
      ctx.scale(windowsView.scale, windowsView.scale);
      const [x, y, w, h] = spec.shadow;
      ctx.fillStyle = 'rgba(0,0,0,.243137)';
      ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.drawImage(body, ...spec.body);
      ctx.translate(...spec.pivot);
      ctx.rotate((spec.angle[0] - spec.angle[1] * amount) * Math.PI / 180);
      ctx.translate(-spec.pivot[0], -spec.pivot[1]);
      ctx.drawImage(mallet, ...spec.mallet);
    }
  }

  /**
   * Read one pack's web derivative as a blob, without loading its layers.
   *
   * The gallery paints covers from these and only calls `load` (which decodes
   * every animation layer) once the visitor hovers, focuses or asks for the
   * preview. Resolves null when this release published no derivative, so the
   * caller can fall back to the delivery art instead of showing nothing.
   */
  async function webAsset(slug, name, identity) {
    const index = await previewIndex();
    checkIdentity(index.packs?.[slug], identity);
    const web = index.packs[slug]?.web;
    if (name === 'cover.png') name = web?.cover || name;
    if (!web?.files?.[name]) return null;
    const target = `${web.basePath}${encodeURIComponent(String(web.layers?.[name] ?? name))}`;
    // Several cards can ask for the same still in one frame — a first row that
    // enters the viewport together, a retry landing next to a scroll. One
    // promise per address keeps that to one request.
    if (!webAssets.has(target)) {
      const pending = checkedFetch(target, web.files[name].sha256, { contentAddressed: true })
        .then(bytes => new Blob([bytes], { type: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }))
        .catch(error => { webAssets.delete(target); throw error; });
      webAssets.set(target, pending);
    }
    return webAssets.get(target);
  }
  async function load(container, identity) {
    container.dataset.previewState = 'loading';
    const { manifest, images, fingerprint } = await resources(container.dataset.packPreview, identity);
    const canvas = document.createElement('canvas');
    const ratio = Math.min(devicePixelRatio || 1, 3);
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    const windowsView = !isMac && manifest.renderer === 'native-woodfish-v1'
      ? windowsWoodfishViewV1(manifest.Windows) : null;
    function paint(phase) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(0, height); ctx.scale(1, -1);
      if (nativeRenderers.has(manifest.renderer)) nativeWoodfish(ctx, manifest, images, phase, windowsView);
      else for (const layer of manifest.layers) {
        const frame = sample(layer.keyframes, phase, layer.interpolation);
        const [x, y, w, h] = layer.frame;
        const ax = x + w * layer.anchor[0], ay = y + h * layer.anchor[1];
        ctx.save(); ctx.globalAlpha = frame.alpha;
        ctx.translate(ax + frame.x, ay + frame.y);
        ctx.rotate(frame.rotation * Math.PI / 180);
        ctx.scale(frame.scale, frame.scale * (frame.scale_y ?? 1)); ctx.translate(-ax, -ay);
        drawImage(ctx, images.get(layer.image), layer.frame);
        ctx.restore();
      }
      ctx.restore();
    }
    let raf = 0, timer = 0, active = false;
    const stop = () => { cancelAnimationFrame(raf); clearInterval(timer); raf = timer = 0; active = false; paint(0); };
    function strike() {
      if (reducedMotion.matches || active || document.hidden) return;
      active = true;
      const start = performance.now();
      const tick = (now) => {
        const phase = (now - start) / duration;
        if (phase >= 1) { active = false; raf = 0; paint(0); return; }
        paint(phase); raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    const play = () => { if (timer) return; strike(); timer = setInterval(strike, 1100); };
    // The library renders `.library-card`; `.character-card` is the older name
    // the hero once used. Binding to either keeps hover-to-animate and the
    // preview downscale working wherever the player is mounted.
    const card = container.closest('.library-card, .character-card');
    if (card) {
      card.addEventListener('pointerenter', play);
      card.addEventListener('pointerleave', () => { if (!card.contains(document.activeElement)) stop(); });
      card.addEventListener('focusin', play);
      card.addEventListener('focusout', (event) => { if (!card.contains(event.relatedTarget)) stop(); });
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    reducedMotion.addEventListener('change', stop);
    container.replaceChildren(canvas);
    container.dataset.previewState = 'ready';
    container.dataset.manifestSha256 = fingerprint;
    const player = { strike, stop, paint, manifest, fingerprint };
    container.appearancePlayer = player;
    paint(0);
    return player;
  }
  async function revisions(assetIds) {
    const index = await previewIndex();
    if (!index) throw new Error('appearance_preview_not_ready');
    const entries = Object.values(index.packs);
    return Object.fromEntries(assetIds.map((id) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry?.assetSha256) throw new Error('appearance_preview_not_ready');
      return [id, entry.assetSha256];
    }));
  }
  /** Whether this release published web derivatives for a slug. */
  async function hasWebAssets(slug) {
    try {
      const index = await previewIndex();
      const web = index.packs[slug]?.web;
      return Boolean(web?.files?.[web.cover || 'cover.png']);
    } catch { return false; }
  }
  window.NiuMaAppearance = Object.freeze({ load, cover: (slug, identity) => webAsset(slug, 'cover.png', identity), webAsset, hasWebAssets,
    sample, duration, revisions, setRequestScheduler });
})();
