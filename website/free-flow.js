import { request, post, errorText, validNumber, validAccess, readSelection, writeSelection, validateSelection,
  confirmation, pendingConfirmation, clearConfirmation, reportFields, CONFIRMATION_KEY, MAX_ITEMS, MAX_BYTES, PERMANENT_NOTE, safeDownloadUrl, normalizeText, codePoints } from './free-api.js?v=locale-20261017';
import { officialMappings, paymentItem, currentPayment, mountPayment, downloadFile, paymentError, ACTIVE_CLAIM_KEY } from './payment-flow.js?v=locale-20261017';
import { mountCreatorPreview, mountPublicPreview, schedulePreviewRequest } from './community-preview.js';

window.NiuMaAppearance?.setRequestScheduler?.(schedulePreviewRequest);

const $ = id => document.getElementById(id);
const GALLERY_CACHE_KEY = 'niuma-public-gallery-v1';
const GALLERY_CACHE_TTL = 10 * 60 * 1000;
const GALLERY_CACHE_LIMIT = 512 * 1024;
function gallerySnapshots() {
  try {
    const raw = localStorage.getItem(GALLERY_CACHE_KEY);
    if (!raw || raw.length > GALLERY_CACHE_LIMIT) return [];
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries.filter(entry => entry && typeof entry.key === 'string' &&
      Number.isFinite(entry.at) && entry.at <= Date.now() && Date.now() - entry.at < GALLERY_CACHE_TTL &&
      Array.isArray(entry.items) && entry.items.length <= 24 && entry.items.every(item =>
        validNumber(item?.number) && typeof item.title === 'string' && typeof item.description === 'string' &&
        typeof item.catalogRevision === 'string')).slice(0, 8) : [];
  } catch { return []; }
}
function rememberGallery(key, result) {
  // Public display metadata only. Never cache access codes, order credentials,
  // download grants or permission to select an unconfirmed catalogue version.
  const fields = ['number', 'title', 'description', 'authorPublicNumber', 'authorDisplayName',
    'creatorDouyinNumber', 'tags', 'previewUrl', 'preview', 'catalogRevision', 'deliveryBytesUpperBound'];
  const entry = { key, at: Date.now(), nextCursor: result.nextCursor,
    items: result.items.map(item => Object.fromEntries(fields.map(field => [field, item[field]]))) };
  try {
    const entries = [entry, ...gallerySnapshots().filter(previous => previous.key !== key)].slice(0, 8);
    let raw = JSON.stringify(entries);
    while (raw.length > GALLERY_CACHE_LIMIT && entries.length > 1) { entries.pop(); raw = JSON.stringify(entries); }
    if (raw.length <= GALLERY_CACHE_LIMIT) localStorage.setItem(GALLERY_CACHE_KEY, raw);
  } catch { /* A disabled or full cache must not prevent browsing or downloads. */ }
}
export function node(tag, text, className = '') {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text;
  value.className = className; return value;
}
function status(text, error = false) {
  const target = $('flow-status');
  if (target) { target.textContent = text; target.dataset.tone = error ? 'error' : ''; }
  const feedback = $('selection-feedback');
  if (feedback) { feedback.textContent = error ? text : ''; feedback.dataset.tone = error ? 'error' : ''; }
}
const bytes = value => Number.isFinite(value) ? `${(value / 1048576).toFixed(2)} MiB` : '大小尚未确认';
const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '尚未签发';
function publicWorkUrl(number) {
  return new URL(`index.html?work=${encodeURIComponent(number)}#characters`, location.href).href;
}
async function shareWork(number, button) {
  const url = publicWorkUrl(number);
  let feedback = button?.shareFeedback;
  if (!feedback && button) {
    feedback = node('div', undefined, 'work-share-feedback');
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    button.parentElement.after(feedback); button.shareFeedback = feedback;
  }
  try {
    await navigator.clipboard.writeText(url);
    if (button) button.textContent = '链接已复制';
    if (feedback) feedback.replaceChildren(node('p', '发给朋友即可找到这个形象，不包含你的领取码或付款信息。'));
    else status('形象链接已复制，可以发给朋友。');
  } catch {
    if (!feedback) { status(`请手动复制形象链接：${url}`); return; }
    const input = node('input'); input.type = 'text'; input.readOnly = true; input.value = url;
    input.setAttribute('aria-label', '可手动复制的形象链接');
    input.addEventListener('focus', () => input.select());
    feedback.replaceChildren(node('p', '浏览器未允许自动复制。请复制下方链接发给朋友：'), input);
    input.focus({ preventScroll: true }); input.select();
  }
}
function action(label, operation) {
  const button = node('button', label); button.type = 'button';
  button.addEventListener('click', async () => { button.disabled = true; try { await operation(button); } catch (error) { status(errorText(error), true); } finally { button.disabled = false; } });
  return button;
}
async function preview(container, item, options = {}) {
  try {
    if (item.builtin === true) {
      container.dataset.packPreview = 'woodfish';
      return await window.NiuMaAppearance.load(container);
    }
    const settings = { ...options, public: true, revision: item.catalogRevision, label: `${item.title}的真实预览` };
    if (item.preview?.publicPreview) return await mountPublicPreview(container, item.preview.publicPreview, settings);
    if (item.preview?.manifest && item.preview?.images) return await mountCreatorPreview(container, item.preview, settings);
    if (!item.previewUrl) throw new Error('preview_missing');
    const url = new URL(item.previewUrl, location.href);
    if (url.origin !== location.origin && url.protocol !== 'https:') throw new Error('preview_invalid');
    const resource = await schedulePreviewRequest(async () => {
      const response = await fetch(url.href, { credentials: url.origin === location.origin ? 'same-origin' : 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('preview_unavailable');
      const type = response.headers.get('content-type') || '';
      return type.startsWith('image/') ? { image: await response.blob() } : { spec: await response.json() };
    }, options);
    if (resource.image) {
      const image = node('img'), objectUrl = URL.createObjectURL(resource.image);
      image.alt = settings.label; image.src = objectUrl; image.decoding = 'async';
      try { await image.decode(); } catch (error) { URL.revokeObjectURL(objectUrl); throw error; }
      container.replaceChildren(image);
      return { strike: () => {}, stop: () => {}, destroy: () => URL.revokeObjectURL(objectUrl) };
    }
    const spec = resource.spec;
    if (spec.renderer === 'native-woodfish-v1') {
      const slug = url.pathname.match(/\/assets\/previews\/packs\/([^/]+)\/manifest\.json$/)?.[1];
      if (!slug || !window.NiuMaAppearance) throw new Error('preview_invalid');
      container.dataset.packPreview = slug;
      return await window.NiuMaAppearance.load(container);
    }
    return await mountCreatorPreview(container, spec.manifest ? spec : { manifest: spec,
      images: Object.fromEntries(spec.layers.map(layer => [layer.image, new URL(layer.image, url).pathname])) }, settings);
  } catch {
    container.replaceChildren(node('p', '封面暂未载入，仍可选择或查看作品。', 'flow-meta'));
    throw new Error('预览暂时无法加载，请重试。');
  }
}
function summary(items, access = null) {
  const limit = MAX_ITEMS;
  $('selection-count').textContent = `已选 ${items.length} / ${limit}`;
  if ($('selection-bytes')) $('selection-bytes').textContent = `预计最多 ${bytes(items.reduce((sum, item) => sum + (item.deliveryBytesUpperBound || 0), 0))} / 16 MiB`;
}
export async function library() {
  let items = readSelection(), cursor = '', history = [], nextCursor = null, page = 1, generation = 0, timer;
  let access = null, cards = new Map();
  const retained = new Map(), observed = new WeakMap(), gallerySections = new Set();
  const toolbar = $('selection-toolbar'), gallery = $('library-gallery'), form = $('library-search');
  document.addEventListener('niuma-selection-change', () => { items = readSelection(); save(); });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const priority = state => state.hovered || state.card.contains(document.activeElement) ? -10 : state.visible ? 0 : state.near ? 10 : 30;
  function stopAnimation(state) {
    clearInterval(state.animationTimer); state.animationTimer = 0; state.player?.stop?.();
  }
  function animate(state) {
    const focused = state.card.contains(document.activeElement);
    if (state.disposed || !state.active || !state.visible || document.hidden || reducedMotion.matches || (!state.hovered && !focused)) {
      stopAnimation(state); return;
    }
    if (!state.player) { if (!state.coverFailed) void mount(state); return; }
    if (state.animationTimer) return;
    state.player.strike(); state.animationTimer = setInterval(() => state.player?.strike(), 1100);
  }
  async function mount(state) {
    if (state.disposed || state.loading || state.player || !state.active) return;
    state.loading = true; state.coverFailed = false;
    state.picture.setAttribute('aria-busy', 'true');
    try {
      const player = await preview(state.picture, state.item, {
        priority: () => priority(state),
        onAnimationError: () => {
          if (state.disposed) return;
          clearInterval(state.animationTimer); state.animationTimer = 0;
          state.hint.textContent = '封面可用，动作暂未载入。'; state.retry.hidden = false;
          state.hint.hidden = false;
        },
        onAnimationReady: () => {
          state.retry.hidden = true; state.hint.textContent = '悬停或键盘聚焦，看它动一下';
          state.hint.hidden = !reducedMotion.matches;
        },
      });
      if (state.disposed) { player.destroy?.(); return; }
      state.player = player; state.retry.hidden = true;
      state.hint.textContent = reducedMotion.matches ? '已按系统设置减少动态效果' : '悬停或键盘聚焦，看它动一下';
      state.hint.hidden = !reducedMotion.matches;
      animate(state);
    } catch {
      if (!state.disposed) {
        state.coverFailed = true; state.retry.hidden = false;
        state.hint.textContent = '预览未载入，不影响选择。';
        state.hint.hidden = false;
      }
    } finally { state.loading = false; state.picture.removeAttribute('aria-busy'); }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = observed.get(entry.target);
      if (!state || !state.active) continue;
      state.visible = entry.isIntersecting;
      if (state.visible && !state.player && !state.coverFailed) void mount(state);
      animate(state);
    }
  }, { rootMargin: '0px 0px -110px 0px' });
  const nearbyObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = observed.get(entry.target);
      if (!state || !state.active) continue;
      state.near = entry.isIntersecting;
      if (state.near && !state.player && !state.coverFailed) void mount(state);
    }
  }, { rootMargin: '220px 0px' });
  function detach(state) {
    state.active = false; state.visible = false; state.near = false; state.hovered = false;
    observer.unobserve(state.card); nearbyObserver.unobserve(state.card); stopAnimation(state);
  }
  function dispose(state) {
    detach(state); state.disposed = true; state.player?.destroy?.(); state.card.remove();
  }
  function updateChoice(state) {
    if (state.item.builtin === true) return;
    const selected = items.some(entry => String(entry.number) === String(state.item.number));
    state.choice.checked = selected;
    state.choice.disabled = state.item.canClaim !== true && !selected;
    state.choiceText.textContent = selected ? '已选择' : state.item.catalogPending ? '正在确认…' : state.item.canClaim === true ? '选择此形象' : '暂不可领取';
    state.card.classList.toggle('is-selected', selected);
  }
  const query = new URLSearchParams(location.search);
  const sharedNumber = validNumber(query.get('work')) ? query.get('work') : '';
  let locateSharedWork = Boolean(sharedNumber);
  form.elements.q.value = sharedNumber || query.get('q') || query.get('number') || '';
  form.elements.author.value = query.get('author') || '';
  if (form.elements.author.value) $('library-more-filters').open = true;
  function save() {
    writeSelection(items); summary(items, access);
    for (const state of cards.values()) updateChoice(state);
    if (!toolbar) return;
    toolbar.hidden = !items.length && gallerySections.size === 0;
    $('selection-view').textContent = `查看已选（${items.length}）`;
    const link = $('selection-claim');
    link.setAttribute('aria-disabled', String(!items.length)); link.tabIndex = items.length ? 0 : -1;
    $('selection-clear').disabled = !items.length;
    $('selection-chosen').replaceChildren(...items.map(item => {
      const row = node('li'), detail = node('a', `${item.title} · #${item.number}`);
      detail.href = `appearance.html?number=${encodeURIComponent(item.number)}`;
      const remove = action(`移除${item.title}`, async () => {
        items = items.filter(entry => String(entry.number) !== String(item.number));
        save(); status('已移除，其他选择仍保留。');
        $('selection-chosen').querySelector('button')?.focus();
      });
      row.append(detail, remove); return row;
    }));
    if (!items.length) $('selection-chosen').append(node('li', '还没选小伙伴。悬停看动作，勾选喜欢的形象。'));
  }
  const sectionObserver = toolbar ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) gallerySections.add(entry.target); else gallerySections.delete(entry.target);
    }
    toolbar.hidden = !items.length && gallerySections.size === 0;
  }, { rootMargin: '0px 0px -110px 0px' }) : null;
  for (const element of [$('library-heading'), gallery]) if (element) sectionObserver?.observe(element);
  $('selection-claim')?.addEventListener('click', event => {
    if (!items.length) { event.preventDefault(); status('请先选择至少一个形象。', true); }
  });
  function reset() { cursor = ''; history = []; page = 1; }
  function createCard(item) {
    const card = node('article', undefined, 'library-card');
    if (item.builtin === true) card.classList.add('library-card-free');
    card.dataset.appearanceNumber = item.number;
    const picture = node('div', '封面即将载入', 'library-preview'); picture.setAttribute('aria-busy', 'false');
    const title = node('h3'), link = node('a', item.title);
    link.href = item.builtin === true ? 'download.html' : `appearance.html?number=${encodeURIComponent(item.number)}`; title.append(link);
    if (item.builtin === true) title.append(node('span', '免费', 'library-free-badge'));
    const description = node('p', item.description, 'library-description');
    const hint = node('p', '悬停或键盘聚焦，看它动一下', 'flow-meta library-preview-hint');
    hint.hidden = !reducedMotion.matches;
    const state = { card, picture, link, item, description, hint, player: null, hovered: false, visible: false, near: false,
      active: true, disposed: false, animationTimer: 0, loading: false, coverFailed: false };
    const author = action(item.authorPublicNumber || item.authorDisplayName || '官方作品', async () => {
      if (!state.item.authorPublicNumber) return;
      form.elements.author.value = state.item.authorPublicNumber; $('library-more-filters').open = true;
      reset(); await load();
    });
    author.className = 'library-author'; author.disabled = !item.authorPublicNumber;
    const choice = node('input'); choice.type = 'checkbox';
    choice.setAttribute('aria-label', `选择${item.title}，编号${item.number}`);
    const choiceText = node('span'), label = node('label', undefined, 'library-choice');
    label.append(choice, choiceText);
    const controls = node('div', undefined, 'flow-actions');
    if (item.builtin === true) {
      const download = node('a', '免费下载客户端', 'library-free-download');
      download.href = 'download.html'; controls.append(download);
    } else controls.append(label);
    const retry = action('重试预览', async () => {
      if (state.player?.retry) { state.retry.hidden = true; state.player.retry(); }
      else await mount(state);
    }); retry.hidden = true;
    controls.append(retry);
    const share = action('复制形象链接', button => shareWork(state.item.number, button));
    share.title = '复制这个形象的页面链接，发给朋友';
    share.setAttribute('aria-label', `复制${item.title}的公开作品链接`);
    if (item.builtin !== true) controls.append(share);
    Object.assign(state, { author, choice, choiceText, retry });
    const credit = node('div', undefined, 'library-credit');
    credit.append(node('p', item.builtin === true ? '客户端内置 · 无需登录或领取码' : `#${item.number}`, 'flow-meta library-number'), author);
    card.append(picture, title, description, controls, credit, hint);
    if (item.creatorDouyinNumber) {
      credit.after(node('p', `作者抖音号：${item.creatorDouyinNumber}`, 'flow-meta library-douyin'));
    }
    choice.addEventListener('change', () => {
      if (!choice.checked) items = items.filter(entry => String(entry.number) !== String(state.item.number));
      else {
        const limit = MAX_ITEMS;
        if (items.length >= limit) { updateChoice(state); status(`每批最多 ${limit} 个，请先取消一个再选择。`, true); return; }
        if (state.item.canClaim !== true) { updateChoice(state); return; }
        items.push(state.item);
      }
      save(); status('选择已保留，翻页不会清除。');
    });
    card.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') { state.hovered = true; if (!state.coverFailed) void mount(state); animate(state); }
    });
    card.addEventListener('pointerleave', () => { state.hovered = false; animate(state); });
    card.addEventListener('focusin', () => { if (!state.coverFailed) void mount(state); animate(state); });
    card.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget) && !state.hovered) stopAnimation(state); });
    observed.set(card, state); updateChoice(state); return state;
  }
  function displayGallery(result, pending = false) {
      const q = normalizeText(form.elements.q.value);
      nextCursor = result.nextCursor;
      const visibleItems = pending ? result.items.map(item => ({ ...item, canClaim: false, catalogPending: true })) : [...result.items];
      const showWoodfish = page === 1 && !form.elements.author.value && !normalizeText(form.elements.tag.value)
        && (!q || '基础木鱼 免费木鱼 木鱼 woodfish'.includes(q.toLowerCase()));
      if (showWoodfish) visibleItems.unshift({
        number: 'builtin-woodfish', builtin: true, title: '基础木鱼',
        description: '永久免费，安装客户端即可使用。', canClaim: false,
      });
      const nextCards = new Map(), fragment = document.createDocumentFragment();
      for (const item of visibleItems) {
        const key = JSON.stringify([item.number, item.catalogRevision, item.preview?.publicPreview?.revision || item.preview || item.previewUrl]);
        let state = retained.get(key);
        if (!state) state = createCard(item);
        state.item = item; state.active = true; state.link.textContent = item.title;
        state.description.textContent = item.description;
        state.author.textContent = item.authorPublicNumber || item.authorDisplayName || '官方作品';
        state.author.disabled = !item.authorPublicNumber; updateChoice(state);
        retained.delete(key); retained.set(key, state);
        nextCards.set(key, state); fragment.append(state.card);
      }
      for (const [key, state] of cards) if (!nextCards.has(key)) detach(state);
      cards = nextCards; gallery.replaceChildren(fragment); gallery.classList.remove('library-is-loading');
      for (const state of cards.values()) { observer.observe(state.card); nearbyObserver.observe(state.card); }
      // Only four first-row covers start eagerly. Animation layers start on
      // intent, never as part of the catalogue or neighboring-row prefetch.
      for (const state of [...cards.values()].slice(0, 4)) if (!state.coverFailed) void mount(state);
      for (const [key, state] of retained) {
        if (retained.size <= 48) break;
        if (!state.active) { dispose(state); retained.delete(key); }
      }
      $('library-page').textContent = `第 ${page} 页 · 每页最多 24 个扩展形象`;
      $('library-previous').disabled = pending || history.length === 0; $('library-next').disabled = pending || !nextCursor;
      status(visibleItems.length ? '基础木鱼永久免费；扩展形象 ¥1/个，或用官方群码免费领取。悬停可看动作。' : '没有找到对应形象，试试其他编号或关键词。'); save();
  }
  async function load() {
    const stamp = ++generation, q = normalizeText(form.elements.q.value);
    if (codePoints(q) > 80) { status('搜索最多 80 个字。', true); return; }
    const catalogueQuery = window.NiuMaLocale?.searchQuery(q) ?? q;
    const params = new URLSearchParams({ sort: form.elements.sort.value });
    for (const [key, value] of [['q', catalogueQuery], ['tag', normalizeText(form.elements.tag.value)], ['author', form.elements.author.value], ['cursor', cursor]]) if (value) params.set(key, value);
    const key = params.toString(), cached = gallerySnapshots().find(entry => entry.key === key);
    if (cached) displayGallery(cached, true);
    else if (!cards.size) status('');
    $('library-previous').disabled = true; $('library-next').disabled = true;
    gallery.setAttribute('aria-busy', 'true');
    try {
      const [result, official] = await Promise.all([request('/appearances?' + params), officialMappings()]);
      if (stamp !== generation) return;
      if (!Array.isArray(result.items) || result.items.length > 24) throw new Error('response_invalid');
      result.items = result.items.map(item => paymentItem(item, official)).filter(Boolean);
      items = items.map(selected => { const latest = result.items.find(item => String(item.number) === String(selected.number));
        return latest && latest.catalogRevision === selected.catalogRevision && !selected.paymentPreviewRevision ? { ...selected, paymentAssetId: latest.paymentAssetId, paymentPreviewRevision: latest.paymentPreviewRevision } : selected; });
      rememberGallery(key, result);
      displayGallery(result);
      if (locateSharedWork) {
        locateSharedWork = false;
        const shared = [...cards.values()].find(state => String(state.item.number) === sharedNumber);
        if (shared) {
          shared.card.tabIndex = -1;
          shared.card.focus({ preventScroll: true });
          shared.card.scrollIntoView({ block: 'center', behavior: 'auto' });
          status(`已找到分享的作品「${shared.item.title}」· #${sharedNumber}，可自行选择领取。`);
        } else {
          status('分享的作品暂不可公开或已下架。点击“清除筛选”可浏览其他公开作品。');
        }
      }
    } catch (error) {
      if (stamp !== generation) return;
      if (!cards.size) { gallery.replaceChildren(); gallery.classList.remove('library-is-loading'); }
      $('library-previous').disabled = history.length === 0; $('library-next').disabled = !nextCursor;
      status(errorText(error) + (cards.size ? ' 已保留上次列表，请重试。' : ''), true);
    } finally {
      if (stamp === generation) gallery.setAttribute('aria-busy', 'false');
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); clearTimeout(timer); reset(); void load(); });
  form.elements.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { reset(); void load(); }, 300); });
  for (const name of ['sort', 'tag']) form.elements[name].addEventListener('change', () => { reset(); void load(); });
  $('library-clear-filters').addEventListener('click', () => { form.reset(); $('library-more-filters').open = false; reset(); void load(); });
  $('library-previous').addEventListener('click', () => { cursor = history.pop() || ''; page -= 1; void load(); });
  $('library-next').addEventListener('click', () => { history.push(cursor); cursor = nextCursor; page += 1; void load(); });
  $('selection-clear').addEventListener('click', () => { items = []; save(); status('选择已清空，预览继续保留。'); });
  document.addEventListener('visibilitychange', () => { for (const state of cards.values()) animate(state); });
  reducedMotion.addEventListener('change', () => { for (const state of cards.values()) animate(state); });
  addEventListener('pagehide', event => {
    clearTimeout(timer);
    for (const state of retained.values()) if (event.persisted) stopAnimation(state); else dispose(state);
    if (!event.persisted) { observer.disconnect(); nearbyObserver.disconnect(); sectionObserver?.disconnect(); }
  });
  addEventListener('pageshow', event => {
    if (event.persisted) void load();
    for (const state of cards.values()) animate(state);
  });
  save();
  await load();
}
async function appearance() {
  const number = new URLSearchParams(location.search).get('number');
  if (!validNumber(number)) { status('请输入完整的 100001 至 999999999 形象编号。', true); return; }
  try {
    const original = await request('/appearances/' + encodeURIComponent(number));
    const item = paymentItem(original, await officialMappings());
    if (!item) { status('公开共创暂停，仅开放官方扩展形象；基础木鱼直接免费。', true); return; }
    $('appearance-title').textContent = item.title;
    $('appearance-description').textContent = item.description;
    $('appearance-number').textContent = `#${item.number}`;
    $('appearance-author').textContent = item.authorPublicNumber || item.authorDisplayName;
    $('appearance-author').href = `index.html?author=${encodeURIComponent(item.authorPublicNumber || '')}#characters`;
    if (item.creatorDouyinNumber) {
      $('appearance-douyin').hidden = false; $('appearance-douyin-number').textContent = item.creatorDouyinNumber;
      $('appearance-douyin-copy').addEventListener('click', () => { void navigator.clipboard.writeText(item.creatorDouyinNumber).then(() => status('抖音号已复制。')).catch(() => status('无法自动复制，请选择账号文字手动复制。', true)); });
    }
    $('appearance-share').addEventListener('click', event => { void shareWork(item.number, event.currentTarget); });
    const select = $('appearance-select'), stage = $('appearance-preview');
    let player = null, mounting = false, visible = true;
    select.disabled = item.canClaim !== true;
    select.onclick = () => {
      const items = readSelection();
      if (!items.some(entry => String(entry.number) === String(item.number))) {
        if (items.length >= MAX_ITEMS) { status('每批最多 10 个，请返回形象库调整选择。', true); return; }
        items.push(item); writeSelection(items);
      }
      status('已加入选择，可继续挑选或按 ¥1/个支付下载，也可用官方群码免费领取。');
    };
    const play = async () => {
      if (mounting) return;
      if (player?.retry) { player.retry(); return; }
      mounting = true;
      try {
        player?.destroy?.(); player = await preview(stage, item, {
          priority: 0, onAnimationError: () => { $('appearance-preview-retry').hidden = false; status('封面可用，动作暂未载入。仍可加入选择。'); },
        });
        $('appearance-play').disabled = false; $('appearance-preview-retry').hidden = true;
        $('appearance-play').onclick = () => player?.strike();
        status('封面与公开版本一致；点击播放或移入预览查看动作。');
      } finally { mounting = false; }
    };
    $('appearance-preview-retry').onclick = () => { void play().catch(error => status(error.message, true)); };
    stage.addEventListener('pointerenter', () => { if (visible) player?.strike(); });
    stage.addEventListener('pointerleave', () => player?.stop?.());
    $('appearance-play').addEventListener('focus', () => { if (visible) player?.strike(); });
    const observer = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting === true;
      if (!visible) player?.stop?.();
    });
    observer.observe(stage);
    document.addEventListener('visibilitychange', () => { if (document.hidden) player?.stop?.(); });
    addEventListener('pagehide', event => { if (event.persisted) player?.stop?.(); else { player?.destroy?.(); observer.disconnect(); } });
    try { await play(); }
    catch (error) { $('appearance-preview-retry').hidden = false; status(error.message, true); }
    $('report-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
      for (const field of form.querySelectorAll('[data-report-error]')) field.textContent = '';
      try {
        const values = reportFields(Object.fromEntries(new FormData(form)));
        const result = await post('/reports', { number: item.number, ...values });
        if (typeof result.reportId !== 'string' || !result.reportId) throw new Error('response_invalid');
        status(`举报已受理，编号：${result.reportId}。`); form.reset();
      } catch (error) {
        const field = error.field && form.querySelector(`[data-report-error="${error.field}"]`);
        if (field) field.textContent = error.message;
        status(field ? error.message : errorText(error), true);
      } finally { button.disabled = false; }
    });
  } catch (error) { status(error.status === 404 ? '作品不存在、已下架或暂不可公开。' : errorText(error), true); }
}
async function claim() {
  let items = readSelection(), access = null, busy = false, verifying = false, refreshed = false, configReady = false;
  let notice = null, expiryTimer, paymentUI = null, mappings = null;
  const button = $('claim-create'), codeForm = $('claim-code-form'), route = $('claim-route');
  route.value = new URLSearchParams(location.search).get('route') === 'group' || document.body.dataset.defaultRoute === 'group' ? 'group' : 'payment';
  const groupPending = () => {
    try { return JSON.parse(sessionStorage.getItem(CONFIRMATION_KEY) || 'null')?.sent === true ||
      Boolean(sessionStorage.getItem(ACTIVE_CLAIM_KEY)); } catch { return true; }
  };
  function paying() {
    try { return Boolean(currentPayment()); } catch { return true; }
  }
  function codeStatus(text = '', error = false) {
    $('claim-code-status').textContent = text; $('claim-code-status').dataset.tone = error ? 'error' : '';
    codeForm.elements.code.setAttribute('aria-invalid', String(error));
  }
  function render() {
    const paid = paying(), recovering = pendingConfirmation(items), problem = validateSelection(items);
    summary(items);
    $('payment-panel').hidden = route.value !== 'payment';
    $('group-panel').hidden = route.value !== 'group';
    $('claim-items').replaceChildren(...items.map(item => {
      const row = node('li'), remove = action('移除' + item.title, async () => {
        items = items.filter(entry => String(entry.number) !== String(item.number));
        writeSelection(items); notice = null; render(); paymentUI?.render();
      });
      remove.disabled = busy || verifying || paid || groupPending();
      row.append(node('strong', item.title + ' · #' + item.number), remove); return row;
    }));
    $('claim-selection-status').textContent = problem || '每批最多 10 个不同扩展形象，保存文件后永久本地使用。';
    $('claim-selection-status').dataset.tone = problem ? 'error' : '';
    button.disabled = paid || busy || verifying || Boolean(sessionStorage.getItem(ACTIVE_CLAIM_KEY)) ||
      (!recovering && (!configReady || !refreshed || !validAccess(access) || Boolean(problem)));
    button.textContent = busy ? '正在确认领取…' : recovering ? '继续本次领取请求' : '官方群码免费领取' + (items.length ? ' ' + items.length + ' 个' : '');
    button.setAttribute('aria-busy', String(busy));
    codeForm.querySelector('button').disabled = busy || verifying;
    $('claim-change-code').disabled = busy || verifying;
    $('claim-clear-access').disabled = busy || verifying;
    $('claim-access-status').textContent = validAccess(access)
      ? '官方群码已验证，每批最多 10 个，可重复免费领取，不扣额度。换码时间：' + time(access.expiresAt)
      : '请输入 GD 加六位数字的三天官方群码，字母大小写均可；不接受作者码。';
    const activeGroup = sessionStorage.getItem(ACTIVE_CLAIM_KEY);
    $('claim-continue').hidden = !activeGroup;
    const text = paid ? (route.value === 'payment'
      ? ''
      : '当前有进行中的付款，请切换到“付费下载”继续；已选形象会保留。')
      : activeGroup ? '当前有进行中的群码交付，请在“群码免费领取”中继续本批交付。'
      : route.value === 'payment' ? ''
      : recovering ? '上次领取结果未确认，请继续本次领取，不会另建批次。'
      : !refreshed ? '正在确认所选官方形象与版本…'
      : !configReady ? '群码领取暂不可用；可切换直接支付，已选形象仍保留。'
      : !validAccess(access) ? '输入官方群码并验证后，即可免费领取，不扣额度。'
      : problem || '官方群码有效，可以免费领取本批形象。';
    status(notice?.text || text, notice?.error || Boolean(problem));
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    if (validAccess(access)) expiryTimer = setTimeout(() => { access = null; render(); },
      Math.min(2147483647, Math.max(1, Date.parse(access.expiresAt) - Date.now() + 1)));
  }
  async function refreshItems() {
    mappings = await officialMappings();
    const next = [];
    for (const selected of items) {
      const current = await request('/appearances/' + encodeURIComponent(selected.number));
      const mapped = paymentItem(current, mappings);
      if (!mapped || current.catalogRevision !== selected.catalogRevision ||
          (selected.paymentPreviewRevision && selected.paymentPreviewRevision !== mapped.paymentPreviewRevision))
        next.push({ ...selected, canClaim: false });
      else next.push(mapped);
    }
    items = next; refreshed = true; writeSelection(items); render(); paymentUI?.render();
  }
  render();
  route.onchange = () => { notice = null; render(); };
  codeForm.onsubmit = async event => {
    event.preventDefault(); if (busy || verifying) return;
    const code = codeForm.elements.code.value.trim().toUpperCase();
    if (!/^GD[0-9]{6}$/.test(code)) { codeStatus('只接受 GD 加六位数字的官方群码。', true); return; }
    let verifiedThisSubmission = false;
    verifying = true; notice = null; codeStatus('正在验证官方群码…'); render();
    try {
      const value = await post('/access/verify', { code });
      if (!validAccess(value)) throw new Error('未确认有效官方群码，请获取群内最新码。');
      access = value; verifiedThisSubmission = true; codeForm.elements.code.value = ''; codeStatus('验证成功，免费领取不扣额度。'); scheduleExpiry();
    } catch (error) { codeStatus(error.code ? errorText(error) : error.message, true); }
    finally { verifying = false; render(); }
    // Continue only this explicit successful submission, through the existing
    // guarded/idempotent action. Pending payment or unready state stays blocked.
    if (verifiedThisSubmission && route.value === 'group' && !button.disabled) await button.onclick();
  };
  codeForm.elements.code.oninput = () => codeStatus();
  $('claim-change-code').onclick = () => codeForm.elements.code.focus();
  $('claim-clear-access').onclick = async () => {
    if (busy || verifying) return;
    verifying = true; render();
    try {
      await request('/access', { method: 'DELETE' }); access = null; notice = null;
      clearTimeout(expiryTimer); codeStatus('已清除验码状态，选择与当前交付仍保留。');
    } catch (error) { codeStatus(errorText(error), true); }
    finally { verifying = false; render(); }
  };
  $('claim-continue').onclick = () => {
    try {
      const active = JSON.parse(sessionStorage.getItem(ACTIVE_CLAIM_KEY) || 'null');
      if (active?.claimId) location.assign('delivery.html?claim=' + encodeURIComponent(active.claimId));
    } catch { status('当前交付数据无法读取，请联系项目。', true); }
  };
  button.onclick = async () => {
    if (button.disabled || busy || verifying) return;
    busy = true; notice = { text: '正在确认本次领取，请稍候；网络失败可继续本次请求。', error: false }; render();
    try {
      const existing = confirmation(items);
      if (!existing.sent) {
        access = await request('/access');
        const problem = validateSelection(items);
        if (!validAccess(access) || problem) throw new Error(problem || '请先验证有效官方群码。');
        if (!mappings || items.some(item => !mappings.has(String(item.number)))) throw new Error('仅开放官方扩展形象，请重新选择。');
        existing.sent = true; existing.items = items; sessionStorage.setItem(CONFIRMATION_KEY, JSON.stringify(existing));
      }
      const result = await post('/claims/appearances', { items: JSON.parse(existing.digest) }, { 'Idempotency-Key': existing.key });
      if (typeof result.claimId !== 'string' || !result.claimId ||
          !['PREPARING', 'READY', 'FAILED', 'EXPIRED', 'BLOCKED'].includes(result.state)) throw new Error('response_invalid');
      sessionStorage.setItem(ACTIVE_CLAIM_KEY, JSON.stringify({ claimId: result.claimId, retryKey: crypto.randomUUID() }));
      location.assign('delivery.html?claim=' + encodeURIComponent(result.claimId));
    } catch (error) { notice = { text: error.code || ['network_unavailable', 'response_invalid'].includes(error.message) ? errorText(error) : error.message, error: true }; }
    finally { busy = false; render(); paymentUI?.render(); }
  };
  void mountPayment(() => items, render, groupPending).then(value => { paymentUI = value; value.render(); })
    .catch(error => { $('payment-status').textContent = paymentError(error); });
  void request('/config').then(config => {
    configReady = config.enabled === true && config.ready === true && config.licenseMode === 'perpetual' && config.importExpiresAt === null;
    render();
  }).catch(() => { configReady = false; render(); });
  try {
    await refreshItems();
    access = await request('/access');
    if (!validAccess(access)) access = null;
    scheduleExpiry(); render();
  } catch (error) { notice = { text: error.code ? errorText(error) : error.message, error: true }; render(); }
  addEventListener('pagehide', () => clearTimeout(expiryTimer));
  addEventListener('pageshow', () => { render(); scheduleExpiry(); });
}
async function delivery() {
  const id = new URLSearchParams(location.search).get('claim');
  let active;
  try { active = JSON.parse(sessionStorage.getItem(ACTIVE_CLAIM_KEY) || 'null'); } catch { /* No recoverable current delivery. */ }
  if (!id || id.length > 128 || active?.claimId !== id) {
    $('delivery-state').textContent = '没有当前进行中的交付';
    $('delivery-refresh').disabled = true;
    status('本站不提供历史领取或重下载入口，请返回图库创建新批次。已保存文件永久本地使用。', true); return;
  }
  $('delivery-id').textContent = id;
  const path = '/claims/' + encodeURIComponent(id), start = Date.now();
  let current = null, timer, attempt = 0, loading = false, completed = false;
  const finish = document.createElement('button');
  finish.id = 'delivery-complete'; finish.type = 'button'; finish.textContent = '已找到文件，完成'; finish.hidden = true;
  $('delivery-download').after(finish);
  function clearActive() { sessionStorage.removeItem(ACTIVE_CLAIM_KEY); clearConfirmation(); }
  finish.onclick = () => {
    if (loading || completed || finish.hidden) return;
    clearTimeout(timer); clearActive(); completed = true; finish.hidden = true;
    $('delivery-state').textContent = '本次下载已完成';
    $('delivery-download').hidden = true; $('delivery-new').hidden = false;
    status('请保留本机文件，可长期离线使用。重新在官网下载请创建新批次并使用有效官方群码，或付费下载。');
    document.dispatchEvent(new CustomEvent('niuma-download-completed'));
  };
  async function refresh(automatic = false) {
    if (loading || completed) return;
    loading = true; clearTimeout(timer);
    $('delivery-download').hidden = true; $('delivery-retry').hidden = true; $('delivery-new').hidden = true;
    try {
      current = await request(path);
      const titles = { PREPARING: '正在准备你的形象包', READY: '小伙伴准备好了',
        FAILED: '本次准备未完成', EXPIRED: '本次交付已到期', BLOCKED: '包含暂不可分发的形象' };
      if (!titles[current.state]) throw new Error('response_invalid');
      $('delivery-state').textContent = titles[current.state];
      $('delivery-items').replaceChildren(...(current.items || []).map(item => node('li', (item.title || '形象') + ' · #' + (item.number || item.appearanceNumber))));
      $('delivery-meta').textContent = bytes(current.bytes) + ' · SHA-256：' + (current.sha256 || '准备完成后显示') + ' · 签发时间：' + time(current.issuedAt);
      if (current.state === 'READY') {
        if (current.licenseMode !== 'perpetual' || current.importExpiresAt !== null) throw new Error('response_invalid');
        $('delivery-download').hidden = false; status('一个批次、一个文件。' + PERMANENT_NOTE + '。');
      } else if (current.state === 'PREPARING') {
        status('正在准备本批文件，请保留当前页面；不消耗群码额度。');
        if (Date.now() - start < 90000) timer = setTimeout(() => { void refresh(true); }, [1000, 2000, 3000, 5000][Math.min(attempt++, 3)]);
        else status('仍在处理，可刷新本批状态。');
      } else if (current.state === 'FAILED') {
        $('delivery-retry').hidden = current.recoverable !== true;
        status('本次准备未完成，可继续本次交付重试；不消耗群码额度。', true);
      } else {
        clearActive(); completed = true; $('delivery-new').hidden = false; $('delivery-refresh').disabled = true;
        status('本次交付已结束。可返回图库重新选择，直接支付或用当前官方群码免费领取；已保存文件不受影响。', true);
      }
    } catch (error) {
      status(errorText(error), true);
      if (automatic && Date.now() - start < 90000) timer = setTimeout(() => { void refresh(true); }, 5000);
    } finally { loading = false; }
  }
  $('delivery-refresh').onclick = () => { void refresh(); };
  $('delivery-copy').onclick = () => { void navigator.clipboard.writeText(id).then(() => status('当前批次编号已复制，请勿公开私人交付地址。')).catch(() => status('请手动复制批次编号。')); };
  $('claim-again').onclick = event => {
    if (!completed) { event.preventDefault(); status('请先完成当前交付，不会清除进行中的请求。'); }
  };
  $('delivery-download').onclick = async () => {
    if (loading || completed) return;
    loading = true; clearTimeout(timer); $('delivery-download').disabled = true;
    $('delivery-refresh').disabled = true; status('正在接收本批文件，请保持本页打开…');
    try {
      const result = await post(path + '/download-link');
      const url = safeDownloadUrl(result.url), expires = Date.parse(result.expiresAt);
      if (!url || !(expires > Date.now()) || expires > Date.now() + 301000) throw new Error('response_invalid');
      const filename = result.filename;
      if (typeof filename !== 'string' || !filename || /[\r\n\\/]/.test(filename) || !/\.nmgpacks?$/.test(filename)) throw new Error('response_invalid');
      await downloadFile(url, filename, current.bytes);
      finish.hidden = false; $('delivery-state').textContent = '下一步，找到刚下载的文件';
      $('delivery-download').textContent = '重新下载本批文件';
      status('已发起下载，请查看浏览器下载记录；尚未确认文件已保存。');
      document.dispatchEvent(new CustomEvent('niuma-download-started', { detail: { filename } }));
    } catch (error) { status(error.code ? errorText(error) : paymentError(error), true); }
    finally { loading = false; $('delivery-download').disabled = false; $('delivery-refresh').disabled = completed; }
  };
  $('delivery-retry').onclick = async () => {
    if (loading || completed) return;
    loading = true; $('delivery-retry').disabled = true;
    try { await post(path + '/retry', {}, { 'Idempotency-Key': active.retryKey }); }
    catch (error) { status(errorText(error), true); }
    finally { loading = false; $('delivery-retry').disabled = false; }
    await refresh();
  };
  $('delivery-new').onclick = () => { if (completed) location.assign('claim.html'); };
  addEventListener('pagehide', () => clearTimeout(timer));
  await refresh();
}
async function installers() {
  try {
    const result = await request('/installers');
    if (!Array.isArray(result.items)) throw new Error('response_invalid');
    $('installer-list').replaceChildren(); $('installer-history-list').replaceChildren();
    const approved = result.items.filter(item => safeDownloadUrl(item.publicDownloadUrl) && typeof item.platform === 'string' && /^\d+\.\d+\.\d+$/.test(item.version || '') && item.releaseId && Number.isSafeInteger(item.bytes) && /^[a-f0-9]{64}$/i.test(item.sha256 || ''));
    const platformKey = item => /mac/i.test(item.platform) ? 'Mac' : /win/i.test(item.platform) ? 'Windows' : item.platform;
    const compare = (a, b) => {
      const left = a.version.split('.').map(Number), right = b.version.split('.').map(Number);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    };
    const latest = new Map();
    for (const item of approved) { const key = platformKey(item); if (!latest.has(key) || compare(item, latest.get(key)) > 0) latest.set(key, item); }
    const recommended = /Windows/i.test(navigator.userAgent) ? 'Windows' : /Macintosh|Mac OS X/i.test(navigator.userAgent) ? 'Mac' : null;
    for (const item of approved.sort((a, b) => compare(b, a))) {
      const url = safeDownloadUrl(item.publicDownloadUrl);
      const platform = platformKey(item), current = compare(item, latest.get(platform)) === 0;
      const card = node('section', undefined, `flow-panel installer-card${current && platform === recommended ? ' is-recommended' : ''}`);
      if (current) card.append(node('p', platform === recommended ? '适合这台电脑 · 当前版本' : '当前版本', 'installer-badge'));
      card.append(node('h2', platform), node('p', `${item.version} · ${item.format} · ${bytes(item.bytes)}`));
      if (item.systemRequirements) card.append(node('p', `系统要求：${item.systemRequirements}`, 'flow-meta'));
      card.append(node('p', platform === 'Mac' ? '下载后打开 DMG，将应用拖入“应用程序”。' : platform === 'Windows' ? '下载后双击 EXE，按中文安装步骤完成安装。' : '下载后请查看相应安装说明。', 'flow-meta'));
      const link = node('a', current ? `免费下载 ${platform} 版` : `下载 ${platform} ${item.version} 旧版`, current ? 'button primary' : 'button');
      link.href = url; link.rel = 'noreferrer'; card.append(link);
      link.dataset.installerPlatform = platform === 'Mac' ? 'macos' : platform === 'Windows' ? 'windows' : '';
      link.dataset.installerSha256 = item.sha256;
      link.dataset.installerBytes = String(item.bytes);
      const help = node('a', '查看安装步骤', 'installer-help'); help.href = `install.html${platform === 'Windows' ? '?os=windows' : platform === 'Mac' ? '?os=mac' : ''}`; card.append(help);
      const details = node('details', undefined, 'installer-details');
      details.append(node('summary', '文件详情与校验信息'), node('p', `SHA-256：${item.sha256}`, 'flow-meta'), node('p', `发布编号：${item.releaseId}`, 'flow-meta'), node('p', item.perpetualCompatible === true ? '支持永久离线形象包。' : '扩展形象的兼容性请查看最低版本说明。', 'flow-meta'));
      card.append(details);
      $(current ? 'installer-list' : 'installer-history-list').append(card);
    }
    $('installer-history').hidden = !$('installer-history-list').children.length;
    status($('installer-list').children.length ? '选择你的电脑系统即可下载。基础木鱼内置，不需要登录或领取码。' : '暂无可确认的正式安装包，请稍后重试。', !$('installer-list').children.length);
  } catch (error) { status(errorText(error), true); }
  // Config failure must never disable already available public installer links.
  void request('/config').then(config => {
    $('installer-compatibility').textContent = typeof config.minPerpetualClientVersion === 'string'
      ? `领取扩展形象时，请使用 ${config.minPerpetualClientVersion} 或更新的客户端。` : '扩展形象的最低兼容版本暂未确认。';
  }).catch(() => { $('installer-compatibility').textContent = '兼容性状态暂不可读，公开客户端下载不受验码服务影响。'; });
}
export function developer() {
  for (const button of document.querySelectorAll('[data-copy-developer]')) button.onclick = async () => {
    try { await navigator.clipboard.writeText('1872941388'); button.textContent = '抖音号已复制'; }
    catch { button.textContent = '请手动复制：1872941388'; }
  };
  void request('/config').then(config => {
    const url = safeDownloadUrl(config.developerDouyinHomepageUrl);
    if (url) for (const link of document.querySelectorAll('[data-developer-homepage]')) { link.href = url; link.hidden = false; }
  }).catch(() => {});
}
const page = document.body.dataset.flow;
if (page) {
  developer();
  const routes = { claim, delivery, appearance, download: installers };
  if (routes[page]) void routes[page]();
}
