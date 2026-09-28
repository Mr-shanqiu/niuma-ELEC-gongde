const languageButton = document.querySelector('.language');
let language = localStorage.getItem('niuma-site-language') || (navigator.language.startsWith('zh') ? 'zh' : 'en');

function applyLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-zh]').forEach((node) => {
    const value = node.dataset[language];
    if (value !== undefined) node.innerHTML = value;
  });
  languageButton.textContent = language === 'zh' ? 'EN' : '中文';
}
languageButton.addEventListener('click', () => {
  language = language === 'zh' ? 'en' : 'zh';
  localStorage.setItem('niuma-site-language', language);
  applyLanguage();
  updatePackSelection();
});
applyLanguage();

const previewObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    previewObserver.unobserve(entry.target);
    window.NiuMaAppearance.load(entry.target).catch(() => {
      entry.target.dataset.previewState = 'error';
      entry.target.textContent = language === 'zh' ? '预览正在更新，请刷新页面' : 'Preview updating. Please reload.';
      const choice = entry.target.closest('.character-card')?.querySelector('[data-asset-id]');
      if (choice) { choice.checked = false; choice.disabled = true; updatePackSelection(); }
    });
  }
}, { rootMargin: '240px' });
document.querySelectorAll('[data-pack-preview]').forEach((container) => previewObserver.observe(container));

document.querySelectorAll('[data-copy-sha]').forEach((button) => {
  button.addEventListener('click', async () => {
    const value = button.dataset.copySha;
    try {
      await navigator.clipboard.writeText(value);
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    button.textContent = language === 'zh' ? '已复制' : 'Copied';
    window.setTimeout(() => {
      button.textContent = button.dataset[language] || '';
    }, 1400);
  });
});

const stage = document.querySelector('.counter-demo');
const total = document.querySelector('#demo-total');
function demoStrike() {
  stage.classList.remove('striking');
  void stage.offsetWidth;
  stage.classList.add('striking');
  stage.querySelector('[data-pack-preview]')?.appearancePlayer?.strike();
  total.textContent = String(Number(total.textContent) + 1);
}
document.querySelector('.strike-button').addEventListener('click', demoStrike);
setInterval(demoStrike, 4200);

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: .12 });
document.querySelectorAll('.reveal').forEach((node, index) => {
  node.style.transitionDelay = String(Math.min(index % 5, 3) * 70) + 'ms';
  observer.observe(node);
});

const paymentTestMode = new URLSearchParams(window.location.search).get('payment_test') === '1';
const paymentModal = document.querySelector('.payment-modal');
const paymentStatus = paymentModal.querySelector('.payment-status');
const paymentSubmit = paymentModal.querySelector('.payment-submit');
const paymentChannels = [...paymentModal.querySelectorAll('[data-channel]')];
const purchaseTotal = document.querySelector('#purchase-total');
const packChoices = [...document.querySelectorAll('[data-asset-id]')];
const selectedPackCount = document.querySelector('#selected-pack-count');
const modalSelectedCount = document.querySelector('#modal-selected-count');
const selectedPackList = document.querySelector('#selected-pack-list');
const accessCodeInput = paymentModal.querySelector('.access-code-input');
const accessNew = paymentModal.querySelector('.access-new');
const accessRestore = paymentModal.querySelector('.access-restore');
const accessHistory = paymentModal.querySelector('.access-history');
const accessHistoryPanel = paymentModal.querySelector('.access-history-panel');
const accessCodeResult = paymentModal.querySelector('.access-code-result');
let selectedPaymentChannel = '';
let accessMode = 'new';
let activeAccessCode = localStorage.getItem('niuma-access-code') || '';

function localize(zh, en) { return language === 'zh' ? zh : en; }

function selectedAssetIds() {
  return packChoices.filter((choice) => choice.checked).map((choice) => choice.dataset.assetId);
}

function updatePackSelection() {
  const selected = packChoices.filter((choice) => choice.checked);
  if (selectedPackCount) selectedPackCount.textContent = String(selected.length);
  if (modalSelectedCount) modalSelectedCount.textContent = localize(`已选择 ${selected.length} / 10`, `${selected.length} / 10 selected`);
  if (selectedPackList) selectedPackList.replaceChildren(...selected.map((choice) => {
    const item = document.createElement('li');
    const heading = choice.closest('.character-card')?.querySelector('h3');
    item.textContent = heading?.dataset[language] || heading?.textContent || choice.dataset.assetId;
    return item;
  }));
  if (typeof purchaseButton !== 'undefined') purchaseButton.disabled = selected.length < 1;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(typeof body === 'object' && body ? body.error : `http_${response.status}`);
    error.code = typeof body === 'object' && body ? body.error : `http_${response.status}`;
    throw error;
  }
  return body;
}

function normalizeAccessCode(value) {
  return value.trim().toUpperCase().replace(/\\s+/g, '');
}

function closeModal(modal, returnFocus) {
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  returnFocus.focus();
}

function enablePaymentChannels() {
  paymentChannels.forEach((item) => { item.disabled = false; });
  purchaseTotal.textContent = accessMode === 'existing' ? '¥0.20' : '¥1.00';
}

function selectAccessMode(mode) {
  accessMode = mode;
  selectedPaymentChannel = '';
  paymentChannels.forEach((item) => { item.disabled = true; item.classList.remove('selected'); });
  paymentSubmit.disabled = true;
  accessNew.classList.toggle('selected', mode === 'new');
  accessRestore.classList.toggle('selected', mode === 'existing');
  accessCodeResult.hidden = true;
  if (mode === 'new') {
    paymentStatus.textContent = localize('直接选择支付方式。付款成功后会生成你的永久权益码。', 'Choose a payment method. Your permanent access code is created after payment.');
    enablePaymentChannels();
  }
}

async function restoreAccess(code, quiet = false) {
  const normalized = normalizeAccessCode(code);
  const result = await api('/api/gongde/access', { headers: { 'x-gongde-access-code': normalized } });
  if (!result.ownsOfficialPass) throw new Error('official_pass_required');
  activeAccessCode = normalized;
  accessCodeInput.value = normalized;
  localStorage.setItem('niuma-access-code', normalized);
  accessMode = 'existing';
  accessNew.classList.remove('selected');
  accessRestore.classList.add('selected');
  enablePaymentChannels();
  if (!quiet) paymentStatus.textContent = localize('权益已恢复。本批最多 10 个形象包，整批 ¥0.20。', 'Access restored. This batch of up to 10 packs costs ¥0.20.');
  return result;
}

async function openPaymentModal() {
  if (selectedAssetIds().length < 1) return;
  paymentModal.hidden = false;
  document.body.classList.add('modal-open');
  selectedPaymentChannel = '';
  updatePackSelection();
  accessHistoryPanel.hidden = true;
  accessCodeResult.hidden = true;
  paymentChannels.forEach((item) => { item.disabled = true; item.classList.remove('selected'); });
  paymentSubmit.disabled = true;
  if (activeAccessCode) {
    try {
      await restoreAccess(activeAccessCode, true);
      paymentStatus.textContent = localize('已读取本机保存的权益码，本批统一为 ¥0.20。', 'Your saved access code is ready. This batch costs ¥0.20.');
      return;
    } catch {
      activeAccessCode = '';
      localStorage.removeItem('niuma-access-code');
    }
  }
  selectAccessMode('new');
}

const purchaseButton = document.querySelector('.purchase-button');
purchaseButton.addEventListener('click', openPaymentModal);
packChoices.forEach((choice) => choice.addEventListener('change', () => {
  if (selectedAssetIds().length > 10) choice.checked = false;
  updatePackSelection();
}));
updatePackSelection();
paymentModal.querySelectorAll('[data-payment-close]').forEach((node) => node.addEventListener('click', () => closeModal(paymentModal, purchaseButton)));

accessNew.addEventListener('click', () => selectAccessMode('new'));
accessRestore.addEventListener('click', async () => {
  paymentStatus.textContent = localize('正在验证权益码…', 'Checking access code…');
  try { await restoreAccess(accessCodeInput.value); }
  catch { paymentStatus.textContent = localize('权益码无效，请检查后重试。', 'The access code is invalid. Check it and try again.'); }
});

paymentChannels.forEach((button) => {
  button.addEventListener('click', () => {
    selectedPaymentChannel = button.dataset.channel;
    paymentChannels.forEach((item) => item.classList.toggle('selected', item === button));
    paymentSubmit.disabled = false;
  });
});

function showWechatQr(statusNode, dataUrl) {
  const image = document.createElement('img');
  image.src = dataUrl;
  image.alt = localize('微信支付二维码', 'WeChat Pay QR code');
  image.width = 210;
  image.height = 210;
  image.style.display = 'block';
  image.style.margin = '12px auto';
  const text = document.createElement('span');
  text.textContent = localize('请使用微信扫码支付，付款后会自动下载所选形象包。', 'Scan with WeChat. Your selected packs will download automatically after payment.');
  statusNode.replaceChildren(image, text);
}

async function downloadPack(pending, accessCode = '') {
  const headers = accessCode
    ? { 'x-gongde-access-code': accessCode }
    : { authorization: `Bearer ${pending.buyerToken}` };
  const response = await fetch(`/api/gongde/orders/${pending.orderNo}/package`, { headers });
  if (!response.ok) throw new Error('pack_download_failed');
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const disposition = response.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/i)?.[1];
  link.download = filename || (Number(response.headers.get('x-gongde-pack-count') || '1') > 1 ? '牛马电子功德形象包.zip' : '牛马电子功德形象包.nmgpack');
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function showAccessCode(code) {
  accessCodeResult.hidden = false;
  const title = document.createElement('strong');
  title.textContent = localize('请保存你的永久权益码', 'Save your permanent access code');
  const value = document.createElement('code');
  value.textContent = code;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = localize('复制权益码', 'Copy code');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(code);
    copy.textContent = localize('已复制', 'Copied');
  });
  accessCodeResult.replaceChildren(title, value, copy);
}

accessHistory.addEventListener('click', async () => {
  const code = normalizeAccessCode(accessCodeInput.value || activeAccessCode);
  if (!code) {
    paymentStatus.textContent = localize('请先输入权益码。', 'Enter your access code first.');
    return;
  }
  try {
    await restoreAccess(code, true);
    const result = await api('/api/gongde/access/orders', { headers: { 'x-gongde-access-code': code } });
    const fulfilled = result.orders.filter((order) => order.state === 'FULFILLED' && order.purchaseKind !== 'support');
    accessHistoryPanel.hidden = false;
    if (!fulfilled.length) {
      accessHistoryPanel.textContent = localize('暂时没有可下载的历史批次。', 'No downloadable batches yet.');
      return;
    }
    accessHistoryPanel.replaceChildren(...fulfilled.map((order) => {
      const row = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = `${new Date(order.createdAt).toLocaleString()} · ${order.assetIds.length} ${localize('个形象', 'packs')}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = localize('重新下载', 'Download again');
      button.addEventListener('click', () => downloadPack({ orderNo: order.orderNo }, code).catch(() => {
        paymentStatus.textContent = localize('该批次首次导入期限已过，无法重新生成。', 'This batch is no longer available for first import.');
      }));
      row.append(label, button);
      return row;
    }));
  } catch {
    paymentStatus.textContent = localize('权益码无效，请检查后重试。', 'The access code is invalid. Check it and try again.');
  }
});

async function pollOrder(pending, statusNode) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const result = await api(`/api/gongde/orders/${pending.orderNo}`, { headers: { authorization: `Bearer ${pending.buyerToken}` } });
      if (result.order.state === 'FULFILLED') {
        sessionStorage.removeItem('niuma-pending-checkout');
        if (pending.accessCode) {
          activeAccessCode = pending.accessCode;
          accessCodeInput.value = pending.accessCode;
          localStorage.setItem('niuma-access-code', pending.accessCode);
          showAccessCode(pending.accessCode);
        }
        if (pending.purchaseKind !== 'support') await downloadPack(pending);
        statusNode.textContent = pending.purchaseKind === 'support'
          ? localize('赞赏成功，谢谢你的支持。', 'Support received. Thank you.')
          : localize('支付成功，所选形象包已经开始下载。请保存好权益码。', 'Payment complete. Your packs are downloading. Save your access code.');
        return;
      }
      if (['EXPIRED', 'CANCELED', 'EXCEPTION'].includes(result.order.state)) throw new Error('order_closed');
    } catch (error) {
      if (error.message === 'order_closed') {
        sessionStorage.removeItem('niuma-pending-checkout');
        statusNode.textContent = localize('订单已关闭，请重新发起。', 'This order is closed. Please start again.');
        return;
      }
    }
  }
  statusNode.textContent = localize('等待时间已结束，可刷新页面继续查询原订单。', 'The waiting window ended. Refresh to continue checking the same order.');
}

async function startCheckout({ channel, purchaseKind, amountFen, statusNode }) {
  const assetIds = purchaseKind === 'support' ? [] : selectedAssetIds();
  if (purchaseKind !== 'support' && (assetIds.length < 1 || assetIds.length > 10)) throw new Error('invalid_asset_selection');
  const previewRevisions = purchaseKind === 'support' ? {} : await window.NiuMaAppearance.revisions(assetIds);
  if (purchaseKind !== 'support') {
    const current = await api('/api/gongde/appearance-revisions');
    if (assetIds.some((id) => current.revisions?.[id] !== previewRevisions[id])) {
      statusNode.textContent = localize('形象已更新，请刷新页面查看新版后再购买。本次尚未创建订单或扣款。', 'Characters have changed. Reload to preview the new version before purchasing. No order or charge was created.');
      return;
    }
  }
  const headers = purchaseKind === 'asset-delivery' ? { 'x-gongde-access-code': activeAccessCode } : {};
  const checkout = await api('/api/gongde/checkout', {
    method: 'POST', headers,
    body: JSON.stringify({ channel, purchaseKind, amountFen, assetIds, previewRevisions })
  });
  if (checkout.accessCode) {
    activeAccessCode = checkout.accessCode;
    accessCodeInput.value = checkout.accessCode;
    localStorage.setItem('niuma-access-code', checkout.accessCode);
    showAccessCode(checkout.accessCode);
  }
  const pending = {
    orderNo: checkout.orderNo,
    buyerToken: checkout.buyerToken,
    accessCode: checkout.accessCode || null,
    purchaseKind,
    assetIds: checkout.assetIds
  };
  sessionStorage.setItem('niuma-pending-checkout', JSON.stringify(pending));
  if (checkout.checkout.kind === 'alipay-page') {
    window.location.assign(checkout.checkout.redirectUrl);
    return;
  }
  showWechatQr(statusNode, checkout.checkout.qrDataUrl);
  void pollOrder(pending, statusNode);
}

if (paymentTestMode) {
  paymentSubmit.dataset.zh = '模拟支付成功';
  paymentSubmit.dataset.en = 'Simulate successful payment';
  paymentSubmit.addEventListener('click', () => {
    if (!selectedPaymentChannel) return;
    const code = activeAccessCode || 'GD-TEST-DEMO-CODE-ONLY-0001';
    activeAccessCode = code;
    localStorage.setItem('niuma-access-code', code);
    showAccessCode(code);
    paymentStatus.textContent = localize(`模拟支付成功：已生成 ${selectedAssetIds().length} 个形象包。`, `Test payment succeeded: ${selectedAssetIds().length} packs are ready.`);
    paymentSubmit.disabled = true;
  });
  applyLanguage();
} else {
  paymentSubmit.dataset.zh = '立即支付';
  paymentSubmit.dataset.en = 'Pay now';
  paymentSubmit.addEventListener('click', async () => {
    if (!selectedPaymentChannel) return;
    paymentSubmit.disabled = true;
    paymentStatus.textContent = localize('正在创建安全订单…', 'Creating a secure order…');
    try {
      await startCheckout({
        channel: selectedPaymentChannel,
        purchaseKind: accessMode === 'existing' ? 'asset-delivery' : 'official-pass',
        statusNode: paymentStatus
      });
    } catch (error) {
      paymentStatus.textContent = error.code === 'access_code_invalid'
        ? localize('权益码无效，请检查后重试。', 'The access code is invalid. Check it and try again.')
        : localize('订单暂时无法创建，请稍后再试。', 'Unable to create the order right now. Please try again.');
      paymentSubmit.disabled = false;
    }
  });
  applyLanguage();
}

const supportModal = document.querySelector('.support-modal');
const supportOpen = document.querySelector('.support-open');
const supportSubmit = document.querySelector('.support-submit');
const supportStatus = document.querySelector('.support-status');
const supportAmounts = [...document.querySelectorAll('[data-support-amount]')];
const supportChannels = [...document.querySelectorAll('[data-support-channel]')];
let supportAmount = 100;
let supportChannel = '';

supportOpen.addEventListener('click', () => {
  supportModal.hidden = false;
  document.body.classList.add('modal-open');
  supportAmounts[0].focus();
  supportChannels.forEach((item) => { item.disabled = false; });
});
supportModal.querySelectorAll('[data-support-close]').forEach((node) => node.addEventListener('click', () => closeModal(supportModal, supportOpen)));
supportAmounts.forEach((button) => button.addEventListener('click', () => {
  supportAmount = Number(button.dataset.supportAmount);
  supportAmounts.forEach((item) => item.classList.toggle('selected', item === button));
  document.querySelector('#support-total').textContent = `¥${(supportAmount / 100).toFixed(2)}`;
}));
supportChannels.forEach((button) => button.addEventListener('click', () => {
  supportChannel = button.dataset.supportChannel;
  supportChannels.forEach((item) => item.classList.toggle('selected', item === button));
  supportSubmit.disabled = false;
}));
if (paymentTestMode) {
  supportSubmit.dataset.zh = '模拟赞赏成功';
  supportSubmit.dataset.en = 'Simulate support';
  supportSubmit.addEventListener('click', () => {
    if (!supportChannel) return;
    supportStatus.textContent = language === 'zh' ? '模拟赞赏成功，谢谢你的支持。' : 'Test support succeeded. Thank you.';
    supportSubmit.disabled = true;
  });
  applyLanguage();
} else {
  supportSubmit.dataset.zh = '确认赞赏';
  supportSubmit.dataset.en = 'Support now';
  supportSubmit.addEventListener('click', async () => {
    if (!supportChannel) return;
    supportSubmit.disabled = true;
    supportStatus.textContent = localize('正在创建安全订单…', 'Creating a secure order…');
    try {
      await startCheckout({ channel: supportChannel, purchaseKind: 'support', amountFen: supportAmount, statusNode: supportStatus });
    } catch {
      supportStatus.textContent = localize('赞赏订单暂时无法创建，请稍后再试。', 'Unable to create a support order right now.');
      supportSubmit.disabled = false;
    }
  });
  applyLanguage();
}

if (!paymentTestMode) {
  try {
    const pending = JSON.parse(sessionStorage.getItem('niuma-pending-checkout') || 'null');
    if (pending?.orderNo && pending?.buyerToken) {
      const statusNode = pending.purchaseKind === 'support' ? supportStatus : paymentStatus;
      const modal = pending.purchaseKind === 'support' ? supportModal : paymentModal;
      modal.hidden = false;
      document.body.classList.add('modal-open');
      statusNode.textContent = localize('正在查询刚才的订单…', 'Checking your recent order…');
      void pollOrder(pending, statusNode);
    }
  } catch {
    sessionStorage.removeItem('niuma-pending-checkout');
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!paymentModal.hidden) closeModal(paymentModal, purchaseButton);
  if (!supportModal.hidden) closeModal(supportModal, supportOpen);
});
