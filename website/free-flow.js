import { request, post, errorText, validNumber, validAccess, readSelection, writeSelection, validateSelection,
  confirmation, pendingConfirmation, clearConfirmation, reportFields, CONFIRMATION_KEY, MAX_ITEMS, MAX_BYTES, PERMANENT_NOTE, safeDownloadUrl, normalizeText, codePoints } from './free-api.js';
import { mountCreatorPreview } from './community-preview.js';

const $ = id => document.getElementById(id);
export function node(tag, text, className = '') {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text;
  value.className = className; return value;
}
function status(text, error = false) { const target = $('flow-status'); if (target) { target.textContent = text; target.dataset.tone = error ? 'error' : ''; } }
const bytes = value => Number.isFinite(value) ? `${(value / 1048576).toFixed(2)} MiB` : '大小尚未确认';
const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '尚未签发';
function action(label, operation) {
  const button = node('button', label); button.type = 'button';
  button.addEventListener('click', async () => { button.disabled = true; try { await operation(button); } catch (error) { status(errorText(error), true); } finally { button.disabled = false; } });
  return button;
}
async function preview(container, item) {
  try {
    if (item.preview?.manifest && item.preview?.images) return await mountCreatorPreview(container, item.preview);
    if (!item.previewUrl) throw new Error('preview_missing');
    const url = new URL(item.previewUrl, location.href);
    if (url.origin !== location.origin && url.protocol !== 'https:') throw new Error('preview_invalid');
    const response = await fetch(url.href, { credentials: url.origin === location.origin ? 'same-origin' : 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('preview_unavailable');
    const type = response.headers.get('content-type') || '';
    if (type.startsWith('image/')) {
      const image = node('img'); image.alt = `${item.title}的真实预览`; image.src = url.href;
      await image.decode(); container.replaceChildren(image);
      return { strike: () => { image.src = url.href; }, destroy: () => {} };
    }
    const spec = await response.json();
    if (spec.renderer === 'native-woodfish-v1') {
      const slug = url.pathname.match(/\/assets\/previews\/packs\/([^/]+)\/manifest\.json$/)?.[1];
      if (!slug || !window.NiuMaAppearance) throw new Error('preview_invalid');
      container.dataset.packPreview = slug;
      return await window.NiuMaAppearance.load(container);
    }
    return await mountCreatorPreview(container, spec.manifest ? spec : { manifest: spec,
      images: Object.fromEntries(spec.layers.map(layer => [layer.image, new URL(layer.image, url).pathname])) });
  } catch { container.replaceChildren(node('p', '真实预览暂时无法加载，请重试。', 'flow-meta')); throw new Error('真实预览暂时无法加载。'); }
}
function summary(items, access = null) {
  const limit = validAccess(access) ? access.maxItems : MAX_ITEMS;
  $('selection-count').textContent = `已选 ${items.length} / ${limit}`;
  if ($('selection-bytes')) $('selection-bytes').textContent = `预计最多 ${bytes(items.reduce((sum, item) => sum + (item.deliveryBytesUpperBound || 0), 0))} / 16 MiB`;
}
export async function library() {
  let items = readSelection(), cursor = '', history = [], nextCursor = null, page = 1, generation = 0, timer;
  let access = null;
  const form = $('library-search');
  const query = new URLSearchParams(location.search);
  form.elements.q.value = query.get('q') || query.get('number') || '';
  form.elements.author.value = query.get('author') || '';
  function save() { writeSelection(items); summary(items, access); }
  function reset() { cursor = ''; history = []; page = 1; }
  async function load() {
    const stamp = ++generation;
    const q = normalizeText(form.elements.q.value);
    if (codePoints(q) > 80) { status('搜索最多 80 个字。', true); return; }
    status('正在读取形象库…'); $('library-previous').disabled = true; $('library-next').disabled = true;
    const params = new URLSearchParams({ sort: form.elements.sort.value });
    for (const [key, value] of [['q', q], ['tag', normalizeText(form.elements.tag.value)], ['author', form.elements.author.value], ['cursor', cursor]]) if (value) params.set(key, value);
    try {
      const result = await request('/appearances?' + params);
      if (stamp !== generation) return;
      if (!Array.isArray(result.items) || result.items.length > 24) throw new Error('response_invalid');
      nextCursor = result.nextCursor;
      $('library-gallery').replaceChildren();
      for (const item of result.items) {
        const card = node('article', undefined, 'library-card');
        const picture = node('div', '正在加载真实预览…', 'library-preview');
        const title = node('h3'); const link = node('a', item.title); link.href = `appearance.html?number=${encodeURIComponent(item.number)}`; title.append(link);
        const author = action(item.authorPublicNumber || item.authorDisplayName, async () => { form.elements.author.value = item.authorPublicNumber || ''; reset(); await load(); }); author.className = 'library-author';
        const choice = node('input'); choice.type = 'checkbox'; choice.checked = items.some(entry => String(entry.number) === String(item.number)); choice.disabled = true;
        const label = node('label'); label.append(choice, document.createTextNode(' 选择此形象'));
        const controls = node('div', undefined, 'flow-actions'); controls.append(label);
        card.append(picture, title, node('p', item.description), node('p', `#${item.number}`, 'flow-meta'), author, controls);
        choice.addEventListener('change', () => {
          if (!choice.checked) items = items.filter(entry => String(entry.number) !== String(item.number));
          else {
            const limit = validAccess(access) ? access.maxItems : MAX_ITEMS;
            if (items.length >= limit) { choice.checked = false; status(`每批最多 ${limit} 个，请先取消一个再选择。`, true); return; }
            items.push(item);
          }
          save(); status('选择已保留，翻页不会清除。');
        });
        const retry = action('重试预览', async () => { const player = await preview(picture, item); choice.disabled = item.canClaim !== true; controls.append(action('播放动作', () => player.strike())); retry.hidden = true; }); retry.hidden = true;
        controls.append(retry);
        $('library-gallery').append(card);
        void preview(picture, item).then(player => { choice.disabled = item.canClaim !== true; controls.append(action('播放动作', () => player.strike())); }).catch(() => { retry.hidden = false; });
      }
      $('library-page').textContent = `第 ${page} 页 · 每页 24 个`;
      $('library-previous').disabled = history.length === 0; $('library-next').disabled = !nextCursor;
      status(result.items.length ? '只展示可公开、可领取的作品。' : '没有找到对应形象，试试其他编号或关键词。'); save();
    } catch (error) { if (stamp === generation) { status(errorText(error), true); $('library-gallery').replaceChildren(); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); clearTimeout(timer); reset(); void load(); });
  form.elements.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { reset(); void load(); }, 300); });
  for (const name of ['sort', 'tag']) form.elements[name].addEventListener('change', () => { reset(); void load(); });
  $('library-clear-filters').addEventListener('click', () => { form.reset(); reset(); void load(); });
  $('library-previous').addEventListener('click', () => { cursor = history.pop() || ''; page -= 1; void load(); });
  $('library-next').addEventListener('click', () => { history.push(cursor); cursor = nextCursor; page += 1; void load(); });
  $('selection-clear').addEventListener('click', () => { items = []; save(); void load(); });
  summary(items); void request('/access').then(value => { access = value; summary(items, access); }).catch(() => {});
  await load();
}
async function appearance() {
  const number = new URLSearchParams(location.search).get('number');
  if (!validNumber(number)) { status('请输入完整的 100001 至 999999999 形象编号。', true); return; }
  try {
    const item = await request('/appearances/' + encodeURIComponent(number));
    $('appearance-title').textContent = item.title;
    $('appearance-description').textContent = item.description;
    $('appearance-number').textContent = `#${item.number}`;
    $('appearance-author').textContent = item.authorPublicNumber || item.authorDisplayName;
    $('appearance-author').href = `index.html?author=${encodeURIComponent(item.authorPublicNumber || '')}#characters`;
    if (item.creatorDouyinNumber) {
      $('appearance-douyin').hidden = false; $('appearance-douyin-number').textContent = item.creatorDouyinNumber;
      $('appearance-douyin-copy').addEventListener('click', () => { void navigator.clipboard.writeText(item.creatorDouyinNumber).then(() => status('抖音号已复制。')).catch(() => status('无法自动复制，请选择账号文字手动复制。', true)); });
    }
    $('appearance-share').addEventListener('click', () => { void navigator.clipboard.writeText(new URL(`appearance.html?number=${item.number}`, location.href).href).then(() => status('公开作品链接已复制。')).catch(() => status('请复制当前公开详情页地址。')); });
    const select = $('appearance-select');
    const play = async () => { select.disabled = true; const player = await preview($('appearance-preview'), item); select.disabled = item.canClaim !== true; $('appearance-play').disabled = false; $('appearance-play').onclick = () => player.strike(); };
    $('appearance-preview-retry').onclick = () => { void play().catch(error => status(error.message, true)); };
    try { await play(); status('预览与公开版本一致；编号由平台分配。'); }
    catch (error) { status(error.message, true); }
    select.onclick = () => {
      const items = readSelection();
      if (!items.some(entry => String(entry.number) === String(item.number))) {
        if (items.length >= MAX_ITEMS) { status('每批最多 10 个，请返回形象库调整选择。', true); return; }
        items.push(item); writeSelection(items);
      }
      status('已加入选择，可继续挑选或前往免费领取。');
    };
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
  let items = readSelection(), access = null, busy = false, configReady = false, refreshed = false;
  const button = $('claim-create');
  function render() {
    summary(items, access);
    $('claim-items').replaceChildren(...items.map(item => {
      const row = node('li'); row.append(node('strong', `${item.title} · #${item.number}`), action('移除', async () => { items = items.filter(entry => String(entry.number) !== String(item.number)); writeSelection(items); render(); })); return row;
    }));
    const problem = validateSelection(items, validAccess(access) ? access.maxItems : MAX_ITEMS);
    $('claim-selection-status').textContent = problem || '一个批次只下载一个文件，重复领取不扣次数。';
    const recovering = pendingConfirmation(items);
    button.disabled = busy || (!recovering && (!configReady || !refreshed || !validAccess(access) || Boolean(problem)));
    button.textContent = recovering ? '恢复本次领取结果' : '免费领取';
    $('claim-access-status').textContent = validAccess(access)
      ? `${access.kind === 'GROUP' ? '粉丝群权益码' : `作者推广码 ${access.authorPublicNumber || ''}`}已验证，每批最多 ${access.maxItems} 个，可重复领取，不扣次数。换码时间：${time(access.expiresAt)}`
      : '尚无有效领取码。可以先选最多 10 个形象，选好后再验证。';
  }
  async function refreshItems() {
    const next = [];
    for (const selected of items) {
      const current = await request(`/appearances/${encodeURIComponent(selected.number)}`);
      if (current.catalogRevision !== selected.catalogRevision) { next.push({ ...selected, canClaim: false }); }
      else next.push(current);
    }
    items = next; refreshed = true; writeSelection(items); render();
  }
  render();
  $('claim-code-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const verify = form.querySelector('button'); verify.disabled = true;
    status('正在向服务器验证领取码…');
    try { const value = await post('/access/verify', { code: form.elements.code.value.trim() }); access = value; form.elements.code.value = ''; render(); status(validAccess(access) ? '领取码已验证；数量与大小仍由服务器最终核对。' : '服务器未返回有效权限，尚不能领取。', !validAccess(access)); }
    catch (error) { status(errorText(error), true); } finally { verify.disabled = false; }
  });
  $('claim-change-code').addEventListener('click', () => { $('claim-code-form').elements.code.focus(); });
  $('claim-clear-access').addEventListener('click', async () => {
    try { await request('/access', { method: 'DELETE' }); access = null; render(); status('已清除当前验码状态，已创建的记录仍保留。'); }
    catch (error) { status(errorText(error), true); }
  });
  button.addEventListener('click', async () => {
    if (busy) return; busy = true; render(); status('正在确认服务器权限与作品版本…');
    try {
      const existing = confirmation(items);
      // Once a request was sent, recover that exact request before rechecking an expired code.
      if (!existing.sent) {
        access = await request('/access');
        const problem = validateSelection(items, validAccess(access) ? access.maxItems : MAX_ITEMS);
        if (!validAccess(access) || problem) { render(); throw new Error(problem || '请先输入有效领取码。'); }
        existing.sent = true; sessionStorage.setItem(CONFIRMATION_KEY, JSON.stringify(existing));
      }
      const result = await post('/claims/appearances', { items: JSON.parse(existing.digest) }, { 'Idempotency-Key': existing.key });
      if (typeof result.claimId !== 'string' || !result.claimId || !['PREPARING', 'READY', 'FAILED', 'EXPIRED', 'BLOCKED'].includes(result.state)) throw new Error('response_invalid');
      location.assign(`delivery.html?claim=${encodeURIComponent(result.claimId)}`);
    } catch (error) { status(error.code ? errorText(error) : error.message === 'network_unavailable' || error.message === 'response_invalid' ? errorText(error) : error.message, true); }
    finally { busy = false; render(); }
  });
  try {
    const config = await request('/config');
    configReady = config.enabled === true && config.ready === true && config.licenseMode === 'perpetual' && config.importExpiresAt === null && config.downloadRetentionSeconds === 604800 && typeof config.minPerpetualClientVersion === 'string';
    $('claim-client-note').textContent = configReady ? `永久交付文件请使用 ${config.minPerpetualClientVersion} 或更新的兼容客户端。` : '永久交付尚未确认开放；请等待平台状态，不会创建旧限时包。';
    await refreshItems();
    try { access = await request('/access'); } catch { status('暂时无法读取验码状态；所选形象已保留，请稍后验证。', true); }
    render();
    if (pendingConfirmation(items)) status('本次创建结果尚未确认。点击“恢复本次领取结果”重发原请求与原键；码到期不影响已经创建的记录。');
    else if (configReady) status('请确认选择并输入有效领取码。');
  } catch (error) {
    render(); status(pendingConfirmation(items) ? '平台状态暂不可读，仍可用原键恢复本次已经发送的领取请求，不另造权限。' : errorText(error), true);
  }
  $('claims-refresh').addEventListener('click', async () => {
    try {
      const result = await request('/claims');
      if (!Array.isArray(result.items)) throw new Error('response_invalid');
      $('claim-history').replaceChildren(...result.items.map(entry => { const row = node('li'); const link = node('a', `${entry.claimId || entry.id} · ${entry.state}`); link.href = `delivery.html?claim=${encodeURIComponent(entry.claimId || entry.id)}`; row.append(link); return row; }));
      if (!result.items.length) $('claim-history').textContent = '本浏览器暂无领取记录。';
    } catch (error) { status(errorText(error), true); }
  });
}
async function delivery() {
  const id = new URLSearchParams(location.search).get('claim');
  if (!id || id.length > 128) { status('该领取记录不存在或无法访问，请在原浏览器打开。', true); return; }
  $('delivery-id').textContent = id;
  const path = '/claims/' + encodeURIComponent(id), start = Date.now();
  let current = null, timer, attempt = 0, loading = false;
  const retryKey = crypto.randomUUID();
  async function refresh(automatic = false) {
    if (loading) return; loading = true; clearTimeout(timer);
    $('delivery-download').hidden = true; $('delivery-retry').hidden = true; $('delivery-new').hidden = true;
    try {
      current = await request(path);
      const titles = { PREPARING: '正在准备形象包', READY: '形象包已准备好', FAILED: '本次准备未完成', EXPIRED: '本站本批重下载入口已到期', BLOCKED: '包含暂不可分发的作品' };
      if (!titles[current.state]) throw new Error('response_invalid');
      $('delivery-state').textContent = titles[current.state];
      $('delivery-items').replaceChildren(...(current.items || []).map(item => node('li', `${item.title || item.metadataSnapshot?.title || '形象'} · #${item.number || item.appearanceNumber}`)));
      $('delivery-meta').textContent = `${bytes(current.bytes)} · SHA-256：${current.sha256 || '准备完成后显示'} · 签发时间：${time(current.issuedAt)}`;
      $('delivery-retention').textContent = current.downloadExpiresAt ? `本站保留本次重下载入口至 ${time(current.downloadExpiresAt)}；已下载文件不受影响。` : '准备中尚未签发文件，7 天服务器重下载窗口尚未开始。';
      if (current.state === 'READY') {
        if (current.licenseMode !== 'perpetual' || current.importExpiresAt !== null || !current.issuedAt || !current.downloadExpiresAt) throw new Error('response_invalid');
        $('delivery-download').hidden = false; status('一个批次、一个文件。' + PERMANENT_NOTE + '。');
      } else if (current.state === 'PREPARING') {
        const stage = { QUEUED: '排队', RESOURCES: '准备资源', GENERATING: '生成文件', queued: '排队', resources: '准备资源', generating: '生成文件', preparing_resources: '准备资源', generating_file: '生成文件' }[current.stage];
        status(stage ? `当前阶段：${stage}。可离开后回来，关闭网页不会取消任务。` : '服务端正在准备。可离开后回来。');
        if (Date.now() - start < 90000) { const delay = [1000, 2000, 3000, 5000][Math.min(attempt++, 3)]; timer = setTimeout(() => { void refresh(true); }, delay); }
        else status('仍在处理，点击刷新状态。');
      } else if (current.state === 'FAILED') {
        $('delivery-retry').hidden = current.recoverable !== true;
        status(current.message || current.errorMessage || '请重试或返回形象库减少选择；原领取记录保留，权限没有扣减。', true);
      } else { $('delivery-new').hidden = false; status(current.state === 'EXPIRED' ? '已下载文件仍可随时导入。需要重下时，凭当前有效码重新领取仍可分发的作品。' : '本次不能下载，请返回形象库移除问题项后重新领取。', current.state === 'BLOCKED'); }
    } catch (error) {
      status(errorText(error), true);
      if (automatic && Date.now() - start < 90000) timer = setTimeout(() => { void refresh(true); }, 5000);
    } finally { loading = false; }
  }
  $('delivery-refresh').onclick = () => { void refresh(); };
  $('delivery-copy').onclick = () => { void navigator.clipboard.writeText(id).then(() => status('批次编号已复制，请勿公开私人交付地址。')).catch(() => status('请手动复制批次编号。')); };
  $('claim-again').addEventListener('click', () => clearConfirmation());
  $('delivery-download').onclick = async () => {
    const button = $('delivery-download'); button.disabled = true; status('正在请求短时下载链接…');
    try {
      const result = await post(path + '/download-link');
      const url = safeDownloadUrl(result.url), expires = Date.parse(result.expiresAt), retention = Date.parse(current?.downloadExpiresAt);
      if (!url || !(expires > Date.now()) || expires > Date.now() + 301000 || expires > retention) throw new Error('response_invalid');
      const link = node('a'); link.href = url; link.rel = 'noreferrer';
      link.download = (current.items?.length || 1) > 1 ? `niuma-appearances-${id}.nmgpacks` : `niuma-appearance-${id}.nmgpack`;
      document.body.append(link); link.click(); link.remove();
      status('下载已交给浏览器，请查看浏览器进度；尚不代表文件已保存。链接过期可再次点击，不延长 7 天重下载窗口。');
    } catch (error) { status(errorText(error), true); } finally { button.disabled = false; }
  };
  $('delivery-retry').onclick = async () => {
    $('delivery-retry').disabled = true;
    try { await post(path + '/retry', {}, { 'Idempotency-Key': retryKey }); await refresh(); }
    catch (error) { status(errorText(error), true); } finally { $('delivery-retry').disabled = false; }
  };
  $('delivery-new').onclick = () => {
    const items = (current?.items || []).map(item => ({ ...item.metadataSnapshot, number: item.number || item.appearanceNumber,
      catalogRevision: item.catalogRevision, title: item.title || item.metadataSnapshot?.title, canClaim: false }));
    if (items.length) writeSelection(items);
    clearConfirmation(); location.assign('claim.html');
  };
  addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  await refresh();
}
async function installers() {
  try {
    const result = await request('/installers');
    if (!Array.isArray(result.items)) throw new Error('response_invalid');
    $('installer-list').replaceChildren();
    for (const item of result.items) {
      const url = safeDownloadUrl(item.publicDownloadUrl);
      if (!url || typeof item.version !== 'string' || !item.releaseId || !Number.isSafeInteger(item.bytes) || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')) continue;
      const card = node('section', undefined, 'flow-panel');
      const platform = /mac/i.test(item.platform) ? 'Mac' : /win/i.test(item.platform) ? 'Windows' : item.platform;
      card.append(node('h2', platform), node('p', `${item.version} · ${item.format} · ${bytes(item.bytes)}`), node('p', `系统要求：${item.systemRequirements || '请查看安装说明与发布说明'}`, 'flow-meta'),
        node('p', `SHA-256：${item.sha256}`, 'flow-meta'), node('p', `Release：${item.releaseId}`, 'flow-meta'));
      const link = node('a', `免费下载 ${platform} 版`, 'button primary'); link.href = url; link.rel = 'noreferrer'; card.append(link);
      card.append(node('p', item.perpetualCompatible === true ? '支持永久形象交付包。' : '永久形象交付兼容性以发布元数据与最低版本说明为准。', 'flow-meta'));
      $('installer-list').append(card);
    }
    status($('installer-list').children.length ? '公开安装产物无需账号、Cookie 或领取码。基础木鱼随客户端提供。' : '暂无可确认的正式安装产物，请稍后重试。', !$('installer-list').children.length);
  } catch (error) { status(errorText(error), true); }
  // Config failure must never disable already available public installer links.
  void request('/config').then(config => {
    $('installer-compatibility').textContent = typeof config.minPerpetualClientVersion === 'string'
      ? `永久形象包最低兼容版本：${config.minPerpetualClientVersion}。` : '永久形象包最低兼容版本尚未确认。';
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
