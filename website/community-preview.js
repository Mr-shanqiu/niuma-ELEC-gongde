const imagePattern = /^(?:\/api\/gongde\/(?:creators|community|admin\/creators)\/versions\/[a-f0-9]{32}\/images\/|\/assets\/previews\/packs\/[a-z0-9_-]+\/)[a-z0-9][a-z0-9_-]{0,59}\.png$/;
// Match the server's unpacked-image budget; source ZIPs have a separate limit.
const maximumImageBytes = 12 * 1024 * 1024;
let resourceQueue = Promise.resolve();

function sample(frames, phase, interpolation) {
  if (phase <= frames[0].t) return frames[0];
  if (phase >= frames.at(-1).t) return frames.at(-1);
  for (let index = 1; index < frames.length; index++) {
    const right = frames[index];
    if (phase > right.t) continue;
    const left = frames[index - 1];
    let mix = (phase - left.t) / (right.t - left.t);
    if (interpolation === 'smoothstep') mix = mix * mix * (3 - 2 * mix);
    return Object.fromEntries(['x', 'y', 'rotation', 'scale', 'scale_y', 'alpha'].map(key => {
      const fallback = key === 'scale_y' ? 1 : 0;
      const a = left[key] ?? fallback, b = right[key] ?? fallback;
      return [key, a + (b - a) * mix];
    }));
  }
  return frames.at(-1);
}

async function fetchPreviewImage(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) return response;
    if (response.status !== 503) throw new Error('creator_preview_unavailable');
    const problem = await response.json().catch(() => null);
    if (problem?.error !== 'creator_storage_busy' || attempt === 2) {
      throw new Error('creator_preview_unavailable');
    }
    let delay = 250 * (attempt + 1);
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1) {
        throw new Error('creator_preview_unavailable');
      }
      delay = Math.max(delay, seconds * 1000);
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('creator_preview_unavailable');
}

async function loadImages(specification) {
  const images = new Map();
  try {
    for (const name of new Set(specification.manifest.layers.map(layer => layer.image))) {
      const path = specification.images[name];
      if (!imagePattern.test(path)) throw new Error('creator_preview_invalid');
      const response = await fetchPreviewImage(path);
      const blob = await response.blob();
      if (blob.size > maximumImageBytes || blob.type !== 'image/png') throw new Error('creator_preview_invalid');
      images.set(name, await createImageBitmap(blob));
    }
    return images;
  } catch (error) {
    for (const image of images.values()) image.close();
    throw error;
  }
}

export async function mountCreatorPreview(container, specification) {
  const { canvas_width: canvasWidth, canvas_height: canvasHeight } = specification.manifest;
  if (![canvasWidth, canvasHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('creator_preview_invalid');
  }
  const fit = Math.min(240 / canvasWidth, 170 / canvasHeight);
  const offsetX = (240 - canvasWidth * fit) / 2, offsetY = (170 - canvasHeight * fit) / 2;
  const load = resourceQueue.then(() => loadImages(specification));
  resourceQueue = load.then(() => undefined, () => undefined);
  const images = await load;
  const canvas = document.createElement('canvas');
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = 240 * ratio;
  canvas.height = 170 * ratio;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '根据投稿文件渲染的真实形象预览');
  const context = canvas.getContext('2d');
  if (!context) { for (const image of images.values()) image.close(); throw new Error('creator_preview_unavailable'); }
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let animation = 0, destroyed = false;
  function paint(phase) {
    if (destroyed) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, 240, 170);
    context.save(); context.translate(offsetX, 170 - offsetY); context.scale(fit, -fit);
    for (const layer of specification.manifest.layers) {
      const frame = sample(layer.keyframes, phase, layer.interpolation);
      const [x, y, width, height] = layer.frame;
      const anchorX = x + width * layer.anchor[0], anchorY = y + height * layer.anchor[1];
      context.save(); context.globalAlpha = frame.alpha;
      context.translate(anchorX + frame.x, anchorY + frame.y);
      context.rotate(frame.rotation * Math.PI / 180);
      context.scale(frame.scale, frame.scale * (frame.scale_y ?? 1)); context.translate(-anchorX, -anchorY);
      context.translate(x, y + height); context.scale(1, -1);
      context.drawImage(images.get(layer.image), 0, 0, width, height);
      context.restore();
    }
    context.restore();
  }
  function strike() {
    if (destroyed || animation || document.hidden) return;
    if (reducedMotion.matches) { paint(0); return; }
    let start = null;
    const duration = /Mac|iPhone|iPad/.test(navigator.platform) ? 231 : 220;
    function tick(now) {
      if (start === null) start = now;
      const phase = (now - start) / duration;
      if (phase >= 1 || destroyed || document.hidden) { animation = 0; paint(0); return; }
      paint(phase); animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; cancelAnimationFrame(animation);
    for (const image of images.values()) image.close();
  }
  container.replaceChildren(canvas);
  paint(0);
  return { strike, destroy };
}

async function previewPage() {
  if (document.body.dataset.page !== 'creator-preview') return;
  const parameters = new URLSearchParams(location.search);
  const audience = parameters.get('audience'), versionId = parameters.get('version');
  const message = document.getElementById('preview-message');
  if (!['admin', 'creator'].includes(audience) || !/^[a-f0-9]{32}$/.test(versionId ?? '')) {
    message.textContent = '预览地址不正确。'; return;
  }
  const base = audience === 'admin' ? '/api/gongde/admin/creators' : '/api/gongde/creators';
  try {
    let specification;
    if (audience === 'admin') {
      const response = await fetch(`${base}/versions/${versionId}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('creator_preview_unavailable');
      specification = await response.json();
    } else {
      throw new Error('creator_preview_invalid');
    }
    const player = await mountCreatorPreview(document.getElementById('preview-stage'), specification);
    const button = document.getElementById('preview-strike');
    button.disabled = false; button.addEventListener('click', player.strike);
    message.textContent = `版本 ${specification.versionLabel} · 真实文件预览`;
    if (parent !== window) parent.postMessage({ type: 'niuma-creator-preview-ready', versionId }, location.origin);
    addEventListener('pagehide', player.destroy, { once: true });
  } catch { message.textContent = '真实预览暂时无法加载，请确认登录状态和素材存储，不要批准此版本。'; }
}

void previewPage();
