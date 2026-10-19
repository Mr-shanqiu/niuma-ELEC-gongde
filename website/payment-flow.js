import { MAX_ITEMS, MAX_BYTES, validateSelection } from './free-api.js?v=locale-20261017';
const API = '/api/gongde';
const CURRENT_KEY = 'niuma-current-payment-v1';
export const ACTIVE_CLAIM_KEY = 'niuma-current-group-claim-v1';
const $ = id => document.getElementById(id);
let mappingsPromise;
const messages = {
  appearance_preview_outdated: '预览版本已更新，请返回图库重新选择；不会自动重建交易。',
  payment_not_enabled: '直接支付暂未开放，可切换官方群码免费领取。',
  wechat_payment_not_enabled: '微信支付暂不可用，请稍后重试。',
  alipay_not_enabled: '支付宝暂不可用，请稍后重试。',
  order_access_denied: '当前交易凭据无法验证，请私下联系项目。',
  order_not_found: '当前交易暂未找到，请保留本页并稍后重试。',
  payment_status_unconfirmed: '暂时无法向支付平台确认订单结果。请点击“查询本次付款状态”重试；如果已付款，不要重复支付。持续无法确认时请在“付款遇到问题”中联系项目。',
  idempotency_key_conflict: '本次请求与原交易不一致，请继续原交易，不要重复付款。',
  idempotency_conflict: '本次请求与原交易不一致，请继续原交易，不要重复付款。',
  checkout_in_progress: '本次交易仍在创建中，请继续同一次请求，不要重新付款。',
  checkout_request_expired: '本次创建请求已到期，请查询当前交易结果后再操作。',
  checkout_storage_unavailable: '支付请求存储暂不可用，请稍后继续同一次请求。',
  pack_delivery_expired_or_missing: '本次交付暂不可用，请私下联系项目；已保存文件不受影响。',
  download_link_expired: '本次短时链接已过期，可继续同一次交付。'
};
export const paymentError = error => messages[error?.code] || error?.message || '暂时无法连接，请继续本次交易，不要重复付款。';
export async function paymentRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.timeout(15000), ...options,
      headers: { 'content-type': 'application/json', ...options.headers } });
  } catch { throw new Error('网络结果未确认，请重试同一次请求，不要重新付款。'); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(messages[body?.error] || (response.status === 429
      ? '操作过于频繁，请稍后继续本次交易。' : '服务暂不可用，请保留当前交易并稍后重试。'));
    error.code = body?.error; error.status = response.status;
    error.safeToAbandon = body?.checkoutCreated === false && [400, 409, 422].includes(response.status);
    throw error;
  }
  if (!body || typeof body !== 'object') throw new Error('服务信息不完整，请继续本次请求，不要重新付款。');
  return body;
}
export async function officialMappings() {
  if (!mappingsPromise) {
    mappingsPromise = Promise.all([paymentRequest('/appearance-numbers'), paymentRequest('/appearance-revisions')])
      .then(([catalogue, versions]) => {
        if (!Array.isArray(catalogue.appearances) || !versions.revisions || typeof versions.revisions !== 'object')
          throw new Error('官方形象与支付版本暂无法确认，选择已保留。');
        const byNumber = new Map();
        for (const item of catalogue.appearances) {
          const assetId = item.internalId, revision = versions.revisions[assetId];
          if (item.sourceKind !== 'official' || item.state !== 'PUBLISHED' || typeof assetId !== 'string' ||
              ['woodfish', 'official.woodfish'].includes(assetId) || assetId.startsWith('creator.') ||
              !/^[a-f0-9]{64}$/i.test(revision || '')) continue;
          byNumber.set(String(item.appearanceNumber), { assetId, revision });
        }
        return byNumber;
      }).catch(error => { mappingsPromise = null; throw error; });
  }
  return mappingsPromise;
}
export function paymentItem(item, mappings) {
  const official = mappings.get(String(item.number));
  return official ? { ...item, paymentAssetId: official.assetId, paymentPreviewRevision: official.revision } : null;
}
export function paymentSelectionProblem(items) {
  const problem = validateSelection(items);
  if (problem) return problem;
  if (items.some(item => typeof item.paymentAssetId !== 'string' || item.paymentAssetId.startsWith('creator.') ||
      ['woodfish', 'official.woodfish'].includes(item.paymentAssetId) || !/^[a-f0-9]{64}$/i.test(item.paymentPreviewRevision || '')))
    return '直接支付仅支持已确认版本的官方扩展形象，请返回图库重新选择。';
  return new Set(items.map(item => item.paymentAssetId)).size === items.length ? null : '每批需选择不同官方扩展形象。';
}
export function currentPayment() {
  const raw = sessionStorage.getItem(CURRENT_KEY);
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('当前交易数据损坏，请私下联系项目，勿重复付款。'); }
  if (value?.version !== 1 || typeof value.key !== 'string' || !Array.isArray(value.items) ||
      !value.body || !['wechat', 'alipay'].includes(value.body.channel))
    throw new Error('当前交易无法读取，请私下联系项目，勿重复付款。');
  return value;
}
const saveCurrent = value => sessionStorage.setItem(CURRENT_KEY, JSON.stringify(value));
const clearCurrent = () => sessionStorage.removeItem(CURRENT_KEY);
function allowedUrl(value, external = false) {
  try {
    if (typeof value !== 'string' || !value) return null;
    const url = new URL(value, location.href);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) ||
        (url.origin !== location.origin && (!external || url.protocol !== 'https:'))) return null;
    return url.href;
  } catch { return null; }
}
export async function downloadFile(url, filename, expectedBytes = null) {
  const target = allowedUrl(url, true);
  if (!target || !/\.(nmgpack|nmgpacks)$/i.test(filename || '')) throw new Error('下载链接或文件名尚未确认，请继续本次交付。');
  if (expectedBytes !== null && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_BYTES))
    throw new Error('文件大小尚未确认，请继续同一次交付。');
  // Stay in the originating tab: the link is obtained asynchronously, so a new
  // window can lose user activation or hide the download from page-scoped tools.
  // Content-Disposition starts the save without replacing this delivery page.
  // This requests a download; it cannot confirm that the file has been saved.
  const link = document.createElement('a');
  link.href = target; link.download = filename; link.rel = 'noreferrer'; link.target = '_self';
  document.body.append(link); link.click(); link.remove();
}
export async function mountPayment(getItems, changed = () => {}, blocked = () => false) {
  const create = $('payment-create'), refresh = $('payment-refresh'), download = $('payment-download');
  const channel = $('payment-channel'), notice = $('payment-status');
  let config = null, configError = '', busy = false, order = null, timer, expiryTimer, stopped = false, polls = 0, untrusted = false, awaitingSave = false;
  // Recovery must remain actionable without opening the optional help section.
  const refreshHome = refresh.parentNode, refreshNext = refresh.nextSibling;
  function showRecoveryAction(needed) {
    if (needed) notice.after(refresh);
    else refreshHome.insertBefore(refresh, refreshNext);
  }
  const finish = document.createElement('button');
  finish.id = 'payment-complete'; finish.type = 'button'; finish.textContent = '已找到文件，完成'; finish.hidden = true;
  download.after(finish);
  const say = (text, error = false) => { notice.textContent = text; notice.dataset.tone = error ? 'error' : ''; };
  function active() {
    try { return currentPayment(); }
    catch (error) { say(error.message, true); untrusted = true; return null; }
  }
  function render() {
    const pending = active(), items = pending?.items || getItems(), problem = paymentSelectionProblem(items);
    $('payment-total').textContent = '¥' + items.length.toFixed(2);
    $('payment-total').setAttribute('aria-label', items.length + ' 个形象，每个1元，合计' + items.length + '元');
    channel.disabled = busy || Boolean(pending);
    $('payment-items').replaceChildren(...items.map(item => { const row = document.createElement('li'); row.textContent = item.title + ' · #' + item.number; return row; }));
    create.disabled = busy || untrusted || Boolean(pending?.orderNo) || (!pending && (!config || Boolean(problem) || blocked()));
    create.hidden = Boolean(pending?.orderNo);
    create.textContent = pending ? '重试本次付款请求' : '确认，支付 ¥' + items.length;
    download.textContent = awaitingSave ? '重新下载本批文件' : '下载形象包';
    refresh.hidden = !pending?.orderNo; refresh.disabled = busy || !pending?.orderNo;
    download.hidden = order?.state !== 'FULFILLED' || !pending?.orderNo;
    download.disabled = busy || order?.state !== 'FULFILLED' || !pending?.orderNo;
    finish.hidden = !awaitingSave || !pending?.orderNo; finish.disabled = busy;
    if (!pending) { clearTimeout(expiryTimer); $('payment-checkout').replaceChildren(); order = null; download.hidden = true; showRecoveryAction(false); }
    changed();
  }
  function showCheckout(pending) {
    clearTimeout(expiryTimer);
    const box = $('payment-checkout'); box.replaceChildren(); showRecoveryAction(false);
    if (untrusted || (order && order.state !== 'PENDING_PAYMENT')) return false;
    if (!Number.isFinite(Date.parse(pending.expiresAt)) || Date.parse(pending.expiresAt) <= Date.now()) {
      say('本次付款入口已到期，正在核对订单是否关闭。请查询本次付款状态；确认关闭后即可重新付款或改用群码。若已付款，请勿重复支付。');
      showRecoveryAction(true); return false;
    }
    if (!pending.checkout) {
      say('本次订单的付款入口暂未恢复，请查询本次付款状态重试。订单和选择已保留，不会另建订单。', true);
      showRecoveryAction(true); return false;
    }
    if (pending.amountFen !== pending.items.length * 100 || pending.currency !== 'CNY') {
      untrusted = true; say('服务端金额与 ¥1/个不一致，已保留交易但不展示付款入口，请联系项目。', true); showRecoveryAction(true); return false;
    }
    if (pending.checkout.kind === 'wechat-native' && pending.body.channel === 'wechat' &&
        /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(pending.checkout.qrDataUrl || '')) {
      const image = document.createElement('img'); image.src = pending.checkout.qrDataUrl;
      image.className = 'flow-qr'; image.alt = '微信支付本次 ' + pending.items.length + ' 个形象，¥' + pending.items.length;
      box.append(image);
    } else if (pending.checkout.kind === 'alipay-page' && pending.body.channel === 'alipay') {
      const url = allowedUrl(pending.checkout.redirectUrl, true);
      if (!url || new URL(url).protocol !== 'https:') { say('支付宝地址尚未确认，请保留交易并联系项目。', true); showRecoveryAction(true); return false; }
      const link = document.createElement('a'); link.className = 'button primary'; link.href = url;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开支付宝完成本次付款'; box.append(link);
    } else { say('支付入口尚未确认，请查询本次付款状态或联系项目，不要重复创建。', true); showRecoveryAction(true); return false; }
    expiryTimer = setTimeout(() => {
      const current = active();
      if (stopped || current?.orderNo !== pending.orderNo || (order && order.state !== 'PENDING_PAYMENT')) return;
      showCheckout(current); polls = 0; void query();
    }, Math.min(2147483647, Math.max(1, Date.parse(pending.expiresAt) - Date.now() + 1)));
    return true;
  }
  async function loadConfig() {
    try {
      const value = await paymentRequest('/payment-config');
      if (value.enabled !== true || value.unitPriceFen !== 100 || value.maxItems !== MAX_ITEMS ||
          !value.paymentChannels || typeof value.paymentChannels !== 'object' || value.licenseMode !== 'perpetual' || value.importExpiresAt !== null || value.signerReady !== true || value.purchaseKind !== 'appearance-batch') throw new Error('直接支付暂未开放或价格配置未确认，可切换官方群码免费领取。');
      const channels = ['wechat', 'alipay'].filter(item => value.paymentChannels[item] === true);
      if (!channels.length) throw new Error('当前没有可用支付渠道，可切换官方群码免费领取。');
      config = value; configError = ''; channel.replaceChildren();
      for (const value of channels) {
        const option = document.createElement('option'); option.value = value;
        option.textContent = value === 'wechat' ? '微信支付' : '支付宝'; channel.append(option);
      }
      const pending = active(); if (pending) channel.value = pending.body.channel;
      if (!pending) say('选择支付方式后，生成本次付款入口。');
    } catch (error) { config = null; configError = paymentError(error); if (!active()) say(configError, true); }
    render();
  }
  function queue() {
    clearTimeout(timer);
    if (!stopped && polls++ < 30 && !document.hidden) timer = setTimeout(() => { void query(true); }, 3000);
  }
  async function query(automatic = false) {
    const pending = active();
    if (busy || !pending?.orderNo || !pending.buyerToken) return;
    busy = true; clearTimeout(timer); render();
    try {
      const result = await paymentRequest('/orders/' + encodeURIComponent(pending.orderNo),
        { headers: { authorization: 'Bearer ' + pending.buyerToken, 'x-gongde-checkout-key': pending.key } });
      const states = ['PENDING_PAYMENT', 'PAID', 'FULFILLED', 'CLOSED', 'EXPIRED', 'CANCELED', 'CANCELLED', 'EXCEPTION', 'REFUND_PENDING', 'FAILED', 'REFUNDED'];
      if (!result.order || !states.includes(result.order.state)) throw new Error('交易状态尚未确认，请继续本次交易。');
      if (result.licenseMode !== 'perpetual' || result.importExpiresAt !== null) throw new Error('服务端永久本地使用契约未确认，请保留交易并联系项目。');
      if (result.order.orderNo !== pending.orderNo || result.order.channel !== pending.body.channel ||
          result.order.amountFen !== pending.items.length * 100 || result.order.currency !== 'CNY' ||
          !Number.isFinite(Date.parse(result.order.expiresAt))) throw new Error('订单信息与本次选择不一致，请保留本页并联系项目。');
      Object.assign(pending, { expiresAt: result.order.expiresAt, amountFen: result.order.amountFen,
        currency: result.order.currency, ...(result.checkout ? { checkout: result.checkout } : {}) });
      saveCurrent(pending);
      const stateLabels = { PENDING_PAYMENT: '等待付款', PAID: '已付款，正在准备文件', FULFILLED: '文件已准备好',
        CLOSED: '订单已关闭', EXPIRED: '订单已过期', CANCELED: '订单已取消', CANCELLED: '订单已取消',
        EXCEPTION: '订单需要处理', REFUND_PENDING: '退款处理中', FAILED: '订单暂未完成', REFUNDED: '已退款' };
      order = result.order; $('payment-order').textContent = '订单 ' + pending.orderNo + ' · ' + stateLabels[order.state];
      if (order.state === 'FULFILLED') {
        clearTimeout(expiryTimer); showRecoveryAction(false);
        $('payment-checkout').replaceChildren();
        say(awaitingSave ? '已发起下载，请查看浏览器下载记录。' : '付款成功，文件已准备好。下载后可永久离线使用。');
      } else if (['PENDING_PAYMENT', 'PAID'].includes(order.state)) {
        const payable = showCheckout(pending);
        if (order.state === 'PAID') say('付款成功，正在准备文件，请保持本页打开。');
        else if (payable) say('等待付款，请使用上方付款入口。付款后，本页会自动显示下载入口。');
        queue();
      } else if (['CLOSED', 'EXPIRED', 'CANCELED', 'CANCELLED', 'REFUNDED'].includes(order.state)) {
        clearCurrent(); order = null; $('payment-order').textContent = '';
        say('本次交易已结束，选择已保留。可以重新发起付款，或点击下方“改用群码免费领取”。');
      } else {
        clearTimeout(expiryTimer); $('payment-checkout').replaceChildren(); showRecoveryAction(true);
        say('本次交易未完成，请私下联系项目；为避免重复扣费，仍保留当前交易。', true);
      }
    } catch (error) {
      clearTimeout(expiryTimer); $('payment-checkout').replaceChildren(); showRecoveryAction(true);
      say(paymentError(error), true); if (automatic) queue();
    }
    finally { busy = false; render(); }
  }
  create.onclick = async () => {
    if (busy || create.disabled) return;
    busy = true; clearTimeout(timer);
    try {
      let pending = currentPayment();
      if (!pending) {
        const items = getItems(), problem = paymentSelectionProblem(items);
        if (!config || problem || blocked()) throw new Error(problem || configError || '支付配置尚未确认。');
        pending = { version: 1, key: crypto.randomUUID(), createdAt: new Date().toISOString(),
          items: items.map(item => ({ ...item })), body: { channel: channel.value, purchaseKind: 'appearance-batch',
            assetIds: items.map(item => item.paymentAssetId),
            previewRevisions: Object.fromEntries(items.map(item => [item.paymentAssetId, item.paymentPreviewRevision])) } };
        saveCurrent(pending);
      }
      render(); say('正在创建本次订单，请稍候。网络失败可重试本次请求，不会另建订单。');
      const result = await paymentRequest('/checkout', { method: 'POST', body: JSON.stringify(pending.body),
        headers: { 'Idempotency-Key': pending.key } });
      if (typeof result.orderNo !== 'string' || !/^[A-Z0-9_]+$/.test(result.orderNo) ||
          typeof result.buyerToken !== 'string' || !result.buyerToken)
        throw new Error('创建结果未确认，请继续同一次创建请求，不要重新付款。');
      pending = { ...pending, orderNo: result.orderNo, buyerToken: result.buyerToken,
        amountFen: result.amountFen, currency: result.currency, expiresAt: result.expiresAt, checkout: result.checkout };
      saveCurrent(pending); order = null; polls = 0; showCheckout(pending);
      $('payment-order').textContent = '本次交易：' + pending.orderNo;
    } catch (error) {
      const pending = active();
      if (error.safeToAbandon === true && pending && !pending.orderNo) {
        clearCurrent(); order = null;
        say(paymentError(error) + ' 服务端确认尚未创建交易；选择已保留，可以调整或改用官方群码。', true);
      } else say(paymentError(error), true);
    }
    finally { busy = false; render(); if (active()?.orderNo) void query(); }
  };
  refresh.onclick = () => { polls = 0; void query(); };
  finish.onclick = () => {
    if (busy || !awaitingSave || !active()?.orderNo) return;
    clearTimeout(timer); clearCurrent(); order = null; awaitingSave = false;
    $('payment-order').textContent = '';
    say('本次下载已完成，请保留本机文件。再次在官网发起下载需重新付款，或使用有效官方群码。');
    document.dispatchEvent(new CustomEvent('niuma-download-completed'));
    render();
  };
  download.onclick = async () => {
    if (busy || download.disabled) return;
    const pending = active(); if (!pending?.buyerToken) return;
    busy = true; clearTimeout(timer); render(); say('正在接收本次形象文件，请保持本页打开…');
    try {
      const result = await paymentRequest('/orders/' + encodeURIComponent(pending.orderNo) + '/package-link',
        { method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + pending.buyerToken } });
      const url = allowedUrl(result.downloadUrl);
      if (result.licenseMode !== 'perpetual' || result.importExpiresAt !== null) throw new Error('交付许可尚未确认，请保留交易并联系项目。');
      if (!url || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now() || result.count !== pending.items.length ||
          !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || result.bytes > MAX_BYTES)
        throw new Error('交付链接未确认，请重试同一次交付，不要重新付款。');
      await downloadFile(url, result.filename, result.bytes);
      awaitingSave = true;
      say('已发起下载，请查看浏览器下载记录；尚未确认文件已保存。');
      document.dispatchEvent(new CustomEvent('niuma-download-started', { detail: { filename: result.filename } }));
    } catch (error) { say(paymentError(error), true); }
    finally { busy = false; render(); }
  };
  addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); clearTimeout(expiryTimer); });
  addEventListener('pageshow', () => { stopped = false; polls = 0; render(); if (active()?.orderNo) void query(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else { polls = 0; if (active()?.orderNo) void query(); } });
  render(); await loadConfig();
  const pending = active(); if (pending?.orderNo) { say('正在恢复本次订单及付款入口…'); void query(); }
  return { render, hasCurrent: () => Boolean(active()) || untrusted };
}
