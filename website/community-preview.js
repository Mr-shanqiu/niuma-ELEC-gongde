const imagePattern = /^(?:\/api\/gongde\/(?:creators|community|admin\/creators)\/versions\/[a-f0-9]{32}\/images\/|\/assets\/previews\/packs\/[a-z0-9_-]+\/)[a-z0-9][a-z0-9_-]{0,59}\.png$/;
const publicImagePattern = /^\/(?:api\/gongde\/community\/versions\/[a-f0-9]{32}\/previews|api\/gongde\/v2\/previews\/official\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}|assets\/previews\/public)\/[a-f0-9]{64}\/(?:cover|layer-[0-5])\.png$/;
const maximumImageBytes = 12 * 1024 * 1024;
const maximumCachedBytes = 32 * 1024 * 1024;
const maximumDecodedBytes = 64 * 1024 * 1024;
const imageCache = new Map();
const requests = [];
let cachedBytes = 0, decodedBytes = 0, activeRequests = 0, requestSequence = 0;

function requestPriority(task) {
  try {
    const value = typeof task.priority === 'function' ? task.priority() : task.priority;
    return Number.isFinite(value) ? value : 20;
  } catch { return 20; }
}
function drainRequests() {
  requests.sort((left, right) => requestPriority(left) - requestPriority(right) || left.order - right.order);
  while (activeRequests < 4 && requests.length) {
    const task = requests.shift();
    if (task.signal?.aborted) { task.reject(new DOMException('Preview cancelled', 'AbortError')); continue; }
    task.signal?.removeEventListener('abort', task.abort);
    activeRequests += 1;
    Promise.resolve().then(task.operation).then(task.resolve, task.reject).finally(() => {
      activeRequests -= 1; drainRequests();
    });
  }
}
export function schedulePreviewRequest(operation, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException('Preview cancelled', 'AbortError')); return; }
    const task = { operation, resolve, reject, priority: options.priority, signal: options.signal, order: requestSequence++ };
    task.abort = () => {
      const index = requests.indexOf(task);
      if (index >= 0) { requests.splice(index, 1); reject(new DOMException('Preview cancelled', 'AbortError')); }
    };
    task.signal?.addEventListener('abort', task.abort, { once: true });
    requests.push(task);
    queueMicrotask(drainRequests);
  });
}
function discardImage(key, entry) {
  if (imageCache.get(key) !== entry) return;
  imageCache.delete(key); cachedBytes -= entry.bytes;
}
function previewFailure(kind, status) {
  const error = new Error('creator_preview_unavailable');
  error.kind = kind;
  if (status) error.status = status;
  return error;
}
// One request plus at most one retry, under a per-attempt deadline and a total
// budget that also covers reading the body. A server that sends headers and
// then stalls mid-body is the same failure as one that never answers, so the
// read runs under the same signal and is retried the same way. Definite
// answers — 4xx, a malformed PNG, a cancelled request — are never retried.
const previewAttemptTimeout = 10000;
const previewTotalTimeout = 16000;
function transientKind(error) {
  return error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AbortError' ? 'aborted' : 'network';
}
// The caller's cancellation and this attempt's deadline must both stop the
// fetch. AbortSignal.any is newer than some browsers still in use, so fall back
// to forwarding the caller's abort into a controller of our own. The deadline
// keeps its TimeoutError name on the way through, because a timed-out attempt is
// retried while an explicit cancellation is not.
function attemptSignal(timeout, external) {
  const deadline = AbortSignal.timeout(timeout);
  if (!external) return deadline;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([deadline, external]);
  const controller = new AbortController();
  const reason = new DOMException('Preview attempt timed out', 'TimeoutError');
  const stop = () => controller.abort(external.reason ?? new DOMException('Preview cancelled', 'AbortError'));
  if (external.aborted) stop();
  else {
    external.addEventListener('abort', stop, { once: true });
    deadline.addEventListener('abort', () => controller.abort(reason), { once: true });
    const settle = () => external.removeEventListener('abort', stop);
    controller.signal.addEventListener('abort', settle, { once: true });
  }
  return controller.signal;
}
async function readPreviewBlob(path, options) {
  return schedulePreviewRequest(async () => {
    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = previewTotalTimeout - (Date.now() - started);
      const timeout = attempt === 0 ? previewAttemptTimeout : Math.max(1000, remaining);
      let response;
      try {
        response = await fetch(path, {
          credentials: options.public ? 'omit' : 'same-origin',
          // Private previews stay out of every cache. A public one is an ordinary
          // artwork file: when it is content-addressed it is immutable, and when
          // it is not, the server's own headers decide how it may be reused.
          cache: options.immutable ? 'force-cache' : options.public ? 'default' : 'no-store',
          signal: attemptSignal(timeout, options.signal),
        });
      } catch (error) {
        // A dropped connection or a stalled request is usually transient: retry
        // once with a short wait before reporting the image unavailable. The
        // kind is recorded so callers can tell a network failure from a 4xx.
        const kind = transientKind(error);
        if (kind === 'aborted' || attempt === 1) throw previewFailure(kind);
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      if (response.ok) {
        const length = Number(response.headers.get('content-length'));
        if (length > maximumImageBytes) throw new Error('creator_preview_invalid');
        let blob;
        try {
          blob = await response.blob();
        } catch (error) {
          const kind = transientKind(error);
          if (kind === 'aborted' || attempt === 1) throw previewFailure(kind);
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          continue;
        }
        if (!blob.size || blob.size > maximumImageBytes || blob.type.split(';')[0] !== 'image/png') throw new Error('creator_preview_invalid');
        return blob;
      }
      if (response.status !== 503) throw previewFailure('http', response.status);
      const problem = await response.json().catch(() => null);
      if (!['creator_storage_busy', 'creator_service_unavailable'].includes(problem?.error) || attempt === 1) throw previewFailure('busy', response.status);
      let delay = 250 * (attempt + 1);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1) throw previewFailure('busy', response.status);
        delay = Math.max(delay, seconds * 1000);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw previewFailure('busy');
  }, options);
}
async function cachedPreviewBlob(path, revision, options = {}) {
  // Private creator/admin previews are never retained in the shared image map
  // or the HTTP cache. Only the frozen public derivative routes are immutable.
  if (options.immutable && !publicImagePattern.test(path)) throw new Error('creator_preview_invalid');
  const publicPath = publicImagePattern.test(path) || /^\/api\/gongde\/community\/versions\/[a-f0-9]{32}\/images\//.test(path) || path.startsWith('/assets/previews/packs/');
  if (!options.public || !publicPath) return readPreviewBlob(path, { ...options, public: false, immutable: false });
  const key = `${revision}\0${path}`;
  const previous = imageCache.get(key);
  if (previous) { imageCache.delete(key); imageCache.set(key, previous); return previous.promise; }
  const entry = { bytes: 0, promise: null };
  entry.promise = readPreviewBlob(path, options).then(blob => {
    entry.bytes = blob.size; cachedBytes += entry.bytes;
    for (const [oldKey, oldEntry] of imageCache) {
      if (cachedBytes <= maximumCachedBytes && imageCache.size <= 64) break;
      if (oldEntry.bytes) discardImage(oldKey, oldEntry);
    }
    return blob;
  }).catch(error => { discardImage(key, entry); throw error; });
  imageCache.set(key, entry);
  return entry.promise;
}
async function pngDimensions(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length !== 24 || signature.some((value, index) => bytes[index] !== value) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new Error('creator_preview_invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > 2048 || height > 2048) throw new Error('creator_preview_invalid');
  return { width, height, bytes: width * height * 4 };
}
async function decodeImage(blob) {
  const size = await pngDimensions(blob);
  if (decodedBytes + size.bytes > maximumDecodedBytes) throw new Error('creator_preview_memory_budget');
  decodedBytes += size.bytes;
  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width !== size.width || bitmap.height !== size.height) { bitmap.close(); throw new Error('creator_preview_invalid'); }
    return { bitmap, bytes: size.bytes };
  } catch (error) { decodedBytes -= size.bytes; throw error; }
}
function closeImages(images) {
  for (const image of images.values()) { image.bitmap.close(); decodedBytes -= image.bytes; }
  images.clear();
}
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
function validManifest(manifest) {
  if (!manifest || ![manifest.canvas_width, manifest.canvas_height].every(value => Number.isFinite(value) && value > 0 && value <= 2048) ||
    !Array.isArray(manifest.layers) || !manifest.layers.length || manifest.layers.length > 6) return false;
  return manifest.layers.every(layer =>
    Array.isArray(layer.frame) && layer.frame.length === 4 && layer.frame.every(Number.isFinite) && layer.frame[2] > 0 && layer.frame[3] > 0 &&
    Array.isArray(layer.anchor) && layer.anchor.length === 2 && layer.anchor.every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Array.isArray(layer.keyframes) && layer.keyframes.length >= 1 && layer.keyframes.length <= 64 &&
    layer.keyframes[0].t === 0 && (layer.keyframes.length === 1 || layer.keyframes.at(-1).t === 1) &&
    layer.keyframes.every((frame, index, frames) =>
      ['t', 'x', 'y', 'rotation', 'scale', 'alpha'].every(key => Number.isFinite(frame[key])) &&
      (frame.scale_y === undefined || Number.isFinite(frame.scale_y)) &&
      frame.t >= 0 && frame.t <= 1 && (!index || frame.t > frames[index - 1].t)));
}
async function loadImages(specification, revision, options) {
  const images = new Map();
  const results = await Promise.allSettled([...new Set(specification.manifest.layers.map(layer => layer.image))].map(async name => {
    const path = specification.images?.[name];
    if (!(options.immutable ? publicImagePattern : imagePattern).test(path ?? '')) throw new Error('creator_preview_invalid');
    const blob = await cachedPreviewBlob(path, revision, options);
    const image = await decodeImage(blob);
    images.set(name, image);
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) { closeImages(images); throw failure.reason; }
  return images;
}
export async function mountCreatorPreview(container, specification, options = {}) {
  if (!validManifest(specification?.manifest)) throw new Error('creator_preview_invalid');
  const { canvas_width: canvasWidth, canvas_height: canvasHeight } = specification.manifest;
  const fit = Math.min(240 / canvasWidth, 170 / canvasHeight);
  const offsetX = (240 - canvasWidth * fit) / 2, offsetY = (170 - canvasHeight * fit) / 2;
  const revision = options.immutable ? options.revision : JSON.stringify([options.revision || '', specification.manifest, specification.images]);
  const images = await loadImages(specification, revision, options);
  const canvas = document.createElement('canvas');
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = 240 * ratio; canvas.height = 170 * ratio;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', options.label || '根据投稿文件渲染的真实形象预览');
  const context = canvas.getContext('2d');
  if (!context) { closeImages(images); throw new Error('creator_preview_unavailable'); }
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let animation = 0, destroyed = false;
  function paint(phase) {
    if (destroyed) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, 240, 170);
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
      context.drawImage(images.get(layer.image).bitmap, 0, 0, width, height); context.restore();
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
      if (phase >= 1 || destroyed || document.hidden || reducedMotion.matches) { animation = 0; paint(0); return; }
      paint(phase); animation = requestAnimationFrame(tick);
    }
    animation = requestAnimationFrame(tick);
  }
  function stop() { cancelAnimationFrame(animation); animation = 0; paint(0); }
  function destroy() { if (destroyed) return; stop(); destroyed = true; closeImages(images); }
  container.replaceChildren(canvas); paint(0);
  return { strike, stop, destroy };
}
function publicSpecification(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.revision || '') || typeof value.sourceRevision !== 'string' ||
    value.rendererVersion !== 'public-preview-v1' || value.profile !== 'card-480x340-v1' ||
    value.coverWidth !== 240 || value.coverHeight !== 170 || !validManifest(value.manifest) ||
    value.manifest.schema_version !== 3 || value.manifest.canvas_width !== 480 || value.manifest.canvas_height !== 340 ||
    value.manifest.preview !== 'cover.png' || value.images?.['cover.png'] !== value.coverUrl) throw new Error('creator_preview_invalid');
  const entries = Object.entries(value.images);
  if (entries.length > 7 || entries.some(([name, path]) => {
    if (!/^(?:cover|layer-[0-5])\.png$/.test(name) || typeof path !== 'string' || !publicImagePattern.test(path)) return true;
    const url = new URL(path, location.origin);
    return url.origin !== location.origin || url.search || url.hash || url.pathname !== path || path.split('/').at(-2) !== value.revision || !path.endsWith('/' + name);
  }) || value.manifest.layers.some(layer => !/^layer-[0-5]\.png$/.test(layer.image) || !value.images[layer.image])) throw new Error('creator_preview_invalid');
  return value;
}
export async function mountPublicPreview(container, specification, options = {}) {
  const spec = publicSpecification(specification);
  const resourceOptions = { ...options, public: true, immutable: true, revision: spec.revision };
  const blob = await cachedPreviewBlob(spec.coverUrl, spec.revision, resourceOptions);
  const size = await pngDimensions(blob);
  if (size.width > 480 || size.height > 340) throw new Error('creator_preview_invalid');
  const cover = document.createElement('img'), motion = document.createElement('div');
  const coverObjectUrl = URL.createObjectURL(blob);
  cover.className = 'public-preview-cover'; cover.alt = options.label || '已审核作品的真实封面';
  cover.width = 240; cover.height = 170; cover.decoding = 'async'; cover.src = coverObjectUrl;
  try { await cover.decode(); } catch (error) { URL.revokeObjectURL(coverObjectUrl); throw error; }
  motion.className = 'public-preview-motion'; motion.hidden = true;
  container.replaceChildren(cover, motion); container.dataset.previewState = 'cover';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let player = null, loading = null, wantsMotion = false, destroyed = false, animationFailed = false;
  function strike() {
    if (destroyed || document.hidden || reducedMotion.matches || animationFailed) return;
    wantsMotion = true;
    if (player) { player.strike(); return; }
    if (loading) return;
    loading = mountCreatorPreview(motion, spec, resourceOptions).then(next => {
      if (destroyed || !wantsMotion || document.hidden || reducedMotion.matches) { next.destroy(); return; }
      player = next; motion.hidden = false; cover.hidden = true; container.dataset.previewState = 'ready';
      options.onAnimationReady?.(); player.strike();
    }).catch(error => {
      if (!destroyed) { animationFailed = true; options.onAnimationError?.(error); }
    }).finally(() => { loading = null; });
  }
  function stop() {
    wantsMotion = false;
    // Retain the lightweight cover and compressed public cache, not offscreen
    // decoded layers. A later hover can decode from the same immutable bytes.
    if (player) { player.destroy(); player = null; }
    motion.hidden = true; cover.hidden = false; motion.replaceChildren();
    if (!destroyed) container.dataset.previewState = 'cover';
  }
  function retry() { animationFailed = false; strike(); }
  function destroy() { if (destroyed) return; destroyed = true; stop(); URL.revokeObjectURL(coverObjectUrl); }
  return { strike, stop, retry, destroy };
}
async function previewPage() {
  if (document.body.dataset.page !== 'creator-preview') return;
  const parameters = new URLSearchParams(location.search);
  const audience = parameters.get('audience'), versionId = parameters.get('version');
  const message = document.getElementById('preview-message');
  if (!['admin', 'creator'].includes(audience) || !/^[a-f0-9]{32}$/.test(versionId ?? '')) { message.textContent = '预览地址不正确。'; return; }
  const base = audience === 'admin' ? '/api/gongde/admin/creators' : '/api/gongde/creators';
  try {
    let specification;
    if (audience === 'admin') {
      const response = await fetch(`${base}/versions/${versionId}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('creator_preview_unavailable');
      specification = await response.json();
    } else { throw new Error('creator_preview_invalid'); }
    const player = await mountCreatorPreview(document.getElementById('preview-stage'), specification);
    const button = document.getElementById('preview-strike');
    button.disabled = false; button.addEventListener('click', player.strike);
    message.textContent = `版本 ${specification.versionLabel} · 真实文件预览`;
    if (parent !== window) parent.postMessage({ type: 'niuma-creator-preview-ready', versionId }, location.origin);
    addEventListener('pagehide', player.destroy, { once: true });
  } catch { message.textContent = '真实预览暂时无法加载，请确认登录状态和素材存储，不要批准此版本。'; }
}
void previewPage();
