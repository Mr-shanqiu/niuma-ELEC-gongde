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
  const cache = new Map();
  let indexPromise;

  async function digest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
  }

  async function checkedFetch(url, hash) {
    const response = await fetch(`${url}?sha256=${hash}`, { cache: 'no-cache' });
    if (!response.ok) throw new Error('preview_resource_unavailable');
    const bytes = await response.arrayBuffer();
    if (await digest(bytes) !== hash) throw new Error('preview_release_mismatch');
    return bytes;
  }

  async function resources(slug) {
    if (!cache.has(slug)) cache.set(slug, (async () => {
      indexPromise ||= fetch('assets/previews/source-map.json', { cache: 'no-store' }).then((response) => {
        if (!response.ok) throw new Error('preview_index_unavailable');
        return response.json();
      });
      const index = await indexPromise;
      if (index.schemaVersion !== 3 || !index.packs[slug]) throw new Error('preview_contract_missing');
      const entry = index.packs[slug];
      const base = `assets/previews/packs/${slug}/`;
      const bytes = await checkedFetch(`${base}manifest.json`, entry.manifestSha256);
      const manifest = JSON.parse(new TextDecoder().decode(bytes));
      const names = manifest.renderer ? ['body.png', 'mallet.png'] : [...new Set(manifest.layers.map((layer) => layer.image))];
      const images = new Map();
      await Promise.all(names.map(async (name) => {
        const file = entry.files[name];
        if (!file || file.sourceSha256 !== file.projectedSha256) throw new Error('preview_asset_not_exact');
        const data = await checkedFetch(`${base}${name}`, file.sourceSha256);
        images.set(name, await createImageBitmap(new Blob([data], { type: 'image/png' })));
      }));
      return { manifest, images, fingerprint: entry.manifestSha256 };
    })());
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

  function nativeWoodfish(ctx, manifest, images, phase) {
    const t = phase < .42 ? phase / .42 : (phase - .42) / .58;
    const smooth = t * t * (3 - 2 * t);
    const amount = phase < .42 ? smooth : 1 - smooth;
    const body = images.get('body.png');
    const mallet = images.get('mallet.png');
    const spec = manifest[isMac ? 'macOS' : 'Windows'];
    if (isMac) {
      ctx.translate(spec.center[0], spec.center[1]);
      ctx.scale(spec.scale, spec.scale);
      ctx.translate(-spec.center[0], -spec.center[1]);
      const [x, y, w, h] = spec.shadow;
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill();
      drawImage(ctx, body, spec.body);
      ctx.translate(...spec.pivot);
      ctx.rotate((spec.angle[0] + spec.angle[1] * amount) * Math.PI / 180);
      drawImage(ctx, mallet, spec.shaft, [spec.shaftSourceX, 0, mallet.width - spec.shaftSourceX, mallet.height]);
      drawImage(ctx, mallet, spec.head, [0, 0, Math.min(spec.headSourceWidth, mallet.width), mallet.height]);
    } else {
      // Native Windows uses a top-left 240x250 window, artwork is its bottom 170px.
      ctx.translate(0, 250); ctx.scale(1, -1);
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

  async function load(container) {
    container.dataset.previewState = 'loading';
    const { manifest, images, fingerprint } = await resources(container.dataset.packPreview);
    const canvas = document.createElement('canvas');
    const ratio = Math.min(devicePixelRatio || 1, 3);
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    function paint(phase) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(0, height); ctx.scale(1, -1);
      if (manifest.renderer === 'native-woodfish-v1') nativeWoodfish(ctx, manifest, images, phase);
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
    const card = container.closest('.character-card');
    if (card) {
      card.addEventListener('pointerenter', play);
      card.addEventListener('pointerleave', () => { if (!card.contains(document.activeElement)) stop(); });
      card.addEventListener('focusin', play);
      card.addEventListener('focusout', (event) => { if (!card.contains(event.relatedTarget)) stop(); });
      new ResizeObserver(() => {
        container.style.transform = `scale(${Math.min(.84, (card.clientWidth - 30) / width)})`;
      }).observe(card);
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
    const index = await indexPromise;
    if (!index) throw new Error('appearance_preview_not_ready');
    const entries = Object.values(index.packs);
    return Object.fromEntries(assetIds.map((id) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry?.assetSha256) throw new Error('appearance_preview_not_ready');
      return [id, entry.assetSha256];
    }));
  }
  window.NiuMaAppearance = Object.freeze({ load, sample, duration, revisions });
})();
