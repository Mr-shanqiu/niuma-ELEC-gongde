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

const stage = document.querySelector('.counter-demo');
const total = document.querySelector('#demo-total');
function demoStrike() {
  stage.classList.remove('striking');
  void stage.offsetWidth;
  stage.classList.add('striking');
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
const phoneInput = document.querySelector('.phone-input');
const smsCode = document.querySelector('.sms-code');
const smsSend = document.querySelector('.sms-send');
const smsVerify = document.querySelector('.sms-verify');
const purchaseTotal = document.querySelector('#purchase-total');
const packChoices = [...document.querySelectorAll('[data-asset-id]')];
const selectedPackCount = document.querySelector('#selected-pack-count');
const modalSelectedCount = document.querySelector('#modal-selected-count');
const selectedPackList = document.querySelector('#selected-pack-list');
let selectedPaymentChannel = '';
let phoneVerified = false;
let ownsOfficialPass = false;
let smsChallengeId = '';
let phoneSession = localStorage.getItem('niuma-phone-session') || '';
let phoneSessionExpiresAt = Number(localStorage.getItem('niuma-phone-session-expires') || '0');

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

function hasPhoneSession() {
  if (phoneSession && phoneSessionExpiresAt > Date.now()) return true;
  phoneSession = '';
  phoneSessionExpiresAt = 0;
  localStorage.removeItem('niuma-phone-session');
  localStorage.removeItem('niuma-phone-session-expires');
  return false;
}

function enablePaymentChannels() {
  paymentChannels.forEach((item) => { item.disabled = false; });
  purchaseTotal.textContent = ownsOfficialPass ? '¥0.20' : '¥1.00';
}

async function loadAccount() {
  if (!hasPhoneSession()) return;
  const account = await api('/api/gongde/account', { headers: { 'x-gongde-phone-session': phoneSession } });
  phoneVerified = true;
  ownsOfficialPass = Boolean(account.ownsOfficialPass);
  enablePaymentChannels();
}

function closeModal(modal, returnFocus) {
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  returnFocus.focus();
}

async function openPaymentModal() {
  if (selectedAssetIds().length < 1) return;
  paymentModal.hidden = false;
  document.body.classList.add('modal-open');
  selectedPaymentChannel = '';
  updatePackSelection();
  phoneVerified = hasPhoneSession();
  paymentChannels.forEach((item) => { item.disabled = true; item.classList.remove('selected'); });
  paymentSubmit.disabled = true;
  if (phoneVerified && !paymentTestMode) {
    try {
      await loadAccount();
      paymentStatus.textContent = localize('手机号资格已恢复，可以直接选择支付方式。', 'Your access has been restored. Choose a payment method.');
    } catch {
      phoneVerified = false;
      phoneSession = '';
      localStorage.removeItem('niuma-phone-session');
      localStorage.removeItem('niuma-phone-session-expires');
    }
  }
  if (!phoneVerified) phoneInput.focus();
}

const purchaseButton = document.querySelector('.purchase-button');
purchaseButton.addEventListener('click', openPaymentModal);
packChoices.forEach((choice) => choice.addEventListener('change', () => {
  if (selectedAssetIds().length > 10) choice.checked = false;
  updatePackSelection();
}));
updatePackSelection();
paymentModal.querySelectorAll('[data-payment-close]').forEach((node) => node.addEventListener('click', () => closeModal(paymentModal, purchaseButton)));

smsSend.addEventListener('click', async () => {
  if (!/^1[3-9]\d{9}$/.test(phoneInput.value.replace(/[\s-]/g, ''))) {
    paymentStatus.textContent = language === 'zh' ? '请输入正确的中国大陆手机号。' : 'Enter a valid mainland China mobile number.';
    return;
  }
  if (paymentTestMode) {
    paymentStatus.textContent = localize('测试验证码：123456，5 分钟内有效。', 'Test code: 123456, valid for 5 minutes.');
    return;
  }
  smsSend.disabled = true;
  try {
    const result = await api('/api/gongde/auth/sms/request', { method: 'POST', body: JSON.stringify({ phone: phoneInput.value }) });
    smsChallengeId = result.challengeId;
    paymentStatus.textContent = localize('验证码已发送，5 分钟内有效。', 'Verification code sent. It is valid for 5 minutes.');
    setTimeout(() => { smsSend.disabled = false; }, Math.max(60, result.retryAfterSeconds || 60) * 1000);
  } catch {
    smsSend.disabled = false;
    paymentStatus.textContent = localize('验证码暂时无法发送，请稍后再试。', 'Unable to send a code right now. Please try again later.');
  }
});

smsVerify.addEventListener('click', async () => {
  if (paymentTestMode) {
    if (smsCode.value !== '123456') {
      paymentStatus.textContent = localize('测试验证码不正确。', 'The test code is incorrect.');
      return;
    }
    phoneVerified = true;
    ownsOfficialPass = localStorage.getItem('niuma-test-official-pass') === '1';
  } else {
    if (!smsChallengeId) {
      paymentStatus.textContent = localize('请先发送验证码。', 'Send a verification code first.');
      return;
    }
    try {
      const result = await api('/api/gongde/auth/sms/verify', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneInput.value, challengeId: smsChallengeId, code: smsCode.value })
      });
      phoneSession = result.sessionToken;
      phoneSessionExpiresAt = Date.parse(result.expiresAt);
      localStorage.setItem('niuma-phone-session', phoneSession);
      localStorage.setItem('niuma-phone-session-expires', String(phoneSessionExpiresAt));
      await loadAccount();
    } catch {
      paymentStatus.textContent = localize('验证码无效或已经过期。', 'The code is invalid or has expired.');
      return;
    }
  }
  enablePaymentChannels();
  paymentStatus.textContent = ownsOfficialPass
    ? localize('手机号已验证：本批最多 10 个形象包，统一为 ¥0.20。', 'Phone verified: this batch of up to 10 packs costs ¥0.20 total.')
    : localize('手机号已验证：¥1 获得永久资格，并包含本批最多 10 个形象包。', 'Phone verified: ¥1 grants permanent access and includes this first batch of up to 10 packs.');
});

paymentChannels.forEach((button) => {
  button.addEventListener('click', () => {
    if (!phoneVerified) return;
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

async function downloadPack(pending) {
  const response = await fetch(`/api/gongde/orders/${pending.orderNo}/package`, { headers: { authorization: `Bearer ${pending.buyerToken}` } });
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

async function pollOrder(pending, statusNode) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const result = await api(`/api/gongde/orders/${pending.orderNo}`, { headers: { authorization: `Bearer ${pending.buyerToken}` } });
      if (result.order.state === 'FULFILLED') {
        sessionStorage.removeItem('niuma-pending-checkout');
        if (pending.purchaseKind === 'official-pass') {
          ownsOfficialPass = true;
          localStorage.setItem('niuma-test-official-pass', '1');
        }
        if (pending.purchaseKind !== 'support') await downloadPack(pending);
        statusNode.textContent = pending.purchaseKind === 'support'
          ? localize('赞赏成功，谢谢你的支持。', 'Support received. Thank you.')
          : localize('支付成功，所选形象包已经开始下载。', 'Payment complete. Your selected packs are downloading.');
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
  const headers = purchaseKind === 'support' ? {} : { 'x-gongde-phone-session': phoneSession };
  const assetIds = purchaseKind === 'support' ? [] : selectedAssetIds();
  if (purchaseKind !== 'support' && (assetIds.length < 1 || assetIds.length > 10)) throw new Error('invalid_asset_selection');
  const checkout = await api('/api/gongde/checkout', {
    method: 'POST', headers,
    body: JSON.stringify({ channel, purchaseKind, amountFen, assetIds })
  });
  const pending = { orderNo: checkout.orderNo, buyerToken: checkout.buyerToken, purchaseKind, assetIds: checkout.assetIds };
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
    if (!selectedPaymentChannel || !phoneVerified) return;
    if (!ownsOfficialPass) localStorage.setItem('niuma-test-official-pass', '1');
    paymentStatus.textContent = ownsOfficialPass
      ? localize(`模拟支付成功：已生成 ${selectedAssetIds().length} 个24小时有效的形象包。`, `Test payment succeeded: ${selectedAssetIds().length} packs are ready for 24 hours.`)
      : localize(`模拟支付成功：资格已绑定，首次 ${selectedAssetIds().length} 个形象包已生成。`, `Test payment succeeded: access is linked and ${selectedAssetIds().length} first-batch packs are ready.`);
    paymentSubmit.disabled = true;
  });
  applyLanguage();
} else {
  paymentSubmit.dataset.zh = '立即支付';
  paymentSubmit.dataset.en = 'Pay now';
  paymentSubmit.addEventListener('click', async () => {
    if (!selectedPaymentChannel || !phoneVerified) return;
    paymentSubmit.disabled = true;
    paymentStatus.textContent = localize('正在创建安全订单…', 'Creating a secure order…');
    try {
      await startCheckout({
        channel: selectedPaymentChannel,
        purchaseKind: ownsOfficialPass ? 'asset-delivery' : 'official-pass',
        statusNode: paymentStatus
      });
    } catch (error) {
      if (error.code === 'official_pass_already_owned') {
        ownsOfficialPass = true;
        enablePaymentChannels();
        paymentStatus.textContent = localize('已恢复永久资格，本批最多 10 个形象包统一为 ¥0.20，请再次确认支付。', 'Permanent access restored. This batch of up to 10 packs costs ¥0.20 total; confirm payment again.');
      } else {
        paymentStatus.textContent = localize('订单暂时无法创建，请稍后再试。', 'Unable to create the order right now. Please try again.');
      }
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
