import { metadata, codePoints, normalizeText, promotionUsable, promotionShareText, withdrawCreatorWork, request as freeRequest, errorText } from './free-api.js';
import { creatorRequest, friendlyError, element, copyText, saveFile } from './creator-api.js?v=free-v2-20261008';
import { mountCreatorPreview } from './community-preview.js?v=paid-community-20261007';

const base = '/api/gongde/creators';
const byId = id => document.getElementById(id);
const states = { DRAFT: '草稿', READY: '可送审', PENDING_REVIEW: '审核中', APPROVED: '已通过',
  REJECTED: '已拒绝', PUBLISHED: '公开分享中', UNPUBLISHED: '已下架', SUSPENDED: '已暂停' };
let account = null, work = null, versions = [], selectedVersion = null, player = null;
let termsVersion = null, generation = 0, unsavedRecovery = false, available = false;
let reviewMode = 'disabled', reviewTimer = null, reviewWatch = 0;
let phoneReady = false, termsReady = false, phoneTimer = null;
let phoneChallenge = null, bindChallenge = null, phoneCooldownUntil = 0, bindCooldownUntil = 0;
let phoneSending = false, bindSending = false;
let studioBusy = false;

function setStudioBusy(value) {
  studioBusy = value;
  byId('creator-new-work').disabled = value;
  for (const id of ['creator-work-list', 'creator-version-list', 'creator-submit-section']) byId(id).inert = value;
}

function canSubmitVersion(version) {
  if (!termsReady) return false;
  return version?.state === 'READY' || version?.state === 'REJECTED' ||
    (version?.state === 'PENDING_REVIEW' && version.review?.acceptAiContentReview !== true);
}

function stopReviewWatch() { reviewWatch += 1; clearTimeout(reviewTimer); reviewTimer = null; }

function describeReview(version) {
  if (version.state === 'APPROVED') { message(work?.state === 'PUBLISHED' && work.publishedVersionId === version.versionId ? '审核通过且服务端确认上架，用户可凭码免费领取。' : '审核通过，正在等待服务端发布状态确认。'); void refreshPromotion(); return false; }
  if (version.state === 'REJECTED') { message(`未通过审核：${version.review?.reason || '请修改后重新送审。'}`, 'error'); return false; }
  if (version.review?.autoReview?.state === 'needs_review') {
    message(version.review.reason || '自动审核无法确认，作品未上架，已保留待复核。'); return false;
  }
  message(version.review?.reason || (reviewMode === 'automatic' ?
    '程序安全复核与 AI 内容审核正在处理中，通过后会自动上架。' :
    '投稿已保留。自动审核服务尚未就绪，作品不会未经审核上架。'));
  return version.state === 'PENDING_REVIEW';
}

async function refreshReviewResult(workId, versionId, stamp) {
  const response = await creatorRequest(`${base}/works/${encodeURIComponent(workId)}/versions`);
  const current = await creatorRequest(`${base}/works/${encodeURIComponent(workId)}`);
  if (stamp !== generation || work?.workId !== workId) return null;
  versions = response.versions;
  work.state = current.state; work.publishedVersionId = current.publishedVersionId;
  work.publishedMetadata = current.publishedMetadata;
  if (selectedVersion) selectedVersion = versions.find(version => version.versionId === selectedVersion.versionId) ?? null;
  drawVersions();
  toggle('creator-unpublish', work.state === 'PUBLISHED'); toggle('creator-share', work.state === 'PUBLISHED');
  toggle('creator-republish', work.state === 'UNPUBLISHED' && Boolean(work.publishedVersionId));
  byId('creator-submit').disabled = !byId('creator-submit-accept').checked || !byId('creator-submit-ai').checked || !byId('creator-work-form').elements.acceptFreeDistribution.checked || !player ||
    !canSubmitVersion(selectedVersion) || work.state === 'SUSPENDED';
  await refreshWorks();
  if (stamp !== generation || work?.workId !== workId) return null;
  return versions.find(version => version.versionId === versionId) ?? null;
}

function watchReview(workId, versionId) {
  stopReviewWatch(); const watch = reviewWatch, stamp = generation, deadline = Date.now() + 90000;
  const tick = async () => {
    if (watch !== reviewWatch || stamp !== generation || work?.workId !== workId) return;
    try {
      const version = await refreshReviewResult(workId, versionId, stamp);
      if (watch !== reviewWatch || !version || !describeReview(version)) return;
      if (Date.now() >= deadline) { message('审核仍在处理中，投稿已保存。可稍后点击“刷新审核结果”。'); return; }
    } catch (error) {
      if (watch !== reviewWatch) return;
      if (error.status === 401) { stopReviewWatch(); showSignedOut(); message('登录已过期，请重新登录查看已保存的投稿。'); return; }
      if (Date.now() >= deadline) { message('审核结果暂时无法读取，投稿仍保留；稍后刷新即可。'); return; }
    }
    if (watch === reviewWatch) reviewTimer = setTimeout(() => { void tick(); }, 4000);
  };
  reviewTimer = setTimeout(() => { void tick(); }, 1500);
}

function message(text, tone = '') {
  for (const id of ['creator-message', 'creator-phone-message']) {
    const node = byId(id);
    if (node) { node.textContent = text; node.dataset.tone = tone; }
  }
}
function toggle(id, visible) { byId(id).hidden = !visible; }
function formValues(form) { return Object.fromEntries(new FormData(form)); }

async function run(form, operation) {
  if (form.dataset.busy === 'true') return;
  const fieldset = form.querySelector('fieldset');
  const fields = formValues(form);
  form.dataset.busy = 'true'; fieldset.disabled = true; refreshPhoneControls();
  try { await operation(fields); }
  catch (error) {
    message(friendlyError(error), 'error');
    if (error.status === 401 && !String(error.code ?? error.message).startsWith('creator_sms_')) showSignedOut();
  } finally {
    delete form.dataset.busy;
    fieldset.disabled = form.id === 'creator-work-form' ? !available || !termsReady || work?.state === 'SUSPENDED' : false;
    refreshPhoneControls();
  }
}

function updatePhoneMode() {
  const form = byId('creator-phone-login'), first = form.elements.mode.value === 'new';
  toggle('creator-phone-registration', first);
  form.elements.acceptTerms.required = first;
  if (!first) form.elements.acceptTerms.checked = false;
  refreshPhoneControls();
}

function firstPhoneRegistrationValid(form) {
  if (form.elements.mode.value !== 'new') return true;
  if (!termsReady || !termsVersion) { message('当前条款尚未读取成功，不能创建账号。请刷新后阅读并确认；已有账号入口不受此项影响。', 'error'); return false; }
  if (!form.elements.acceptTerms.checked) {
    message('首次注册必须由你明确阅读并确认账号协议与隐私说明；验证手机号不代表版权或分发授权。', 'error'); return false;
  }
  return true;
}

function refreshPhoneControls() {
  clearTimeout(phoneTimer); phoneTimer = null;
  const now = Date.now(), login = byId('creator-phone-login'), bind = byId('creator-phone-bind');
  if (phoneChallenge && phoneChallenge.expiresAt <= now) { phoneChallenge = null; login.elements.code.value = ''; }
  if (bindChallenge && bindChallenge.expiresAt <= now) { bindChallenge = null; bind.elements.code.value = ''; }
  for (const binding of [false, true]) {
    const form = binding ? bind : login, sending = binding ? bindSending : phoneSending;
    const remaining = Math.max(0, Math.ceil(((binding ? bindCooldownUntil : phoneCooldownUntil) - now) / 1000));
    const challenge = binding ? bindChallenge : phoneChallenge;
    const active = form.dataset.busy === 'true';
    const send = byId(binding ? 'creator-phone-bind-send' : 'creator-phone-send');
    send.textContent = sending ? '正在请求发送…' : remaining ? `${remaining} 秒后可重新获取` : binding ? '获取绑定验证码' : '获取验证码';
    send.disabled = !phoneReady || sending || active || remaining > 0 || (binding && !account) || (!binding && (!termsReady || !form.elements.acceptTerms.checked));
    const submit = byId(binding ? 'creator-phone-bind-submit' : 'creator-phone-submit');
    submit.disabled = !phoneReady || sending || active ||
      !challenge || challenge.phone !== form.elements.phone.value.trim() || (binding && !account) ||
      (!binding && (!termsReady || !form.elements.acceptTerms.checked));
    if (!binding) {
      submit.textContent = active ? '正在验证并登录…' : form.elements.mode.value === 'new' ? '验证并进入工作台' : '验证码登录，进入工作台';
      submit.setAttribute('aria-busy', String(active));
    }
    form.querySelector('fieldset').disabled = active || sending || !phoneReady || (binding && !account);
  }
  if (phoneCooldownUntil > now || bindCooldownUntil > now || phoneChallenge || bindChallenge) {
    phoneTimer = setTimeout(refreshPhoneControls, 1000);
  }
}

async function sendPhoneCode(binding = false) {
  const form = byId(binding ? 'creator-phone-bind' : 'creator-phone-login');
  const cooldown = binding ? bindCooldownUntil : phoneCooldownUntil;
  if (!phoneReady || (binding && !account) || (binding ? bindSending : phoneSending) ||
    form.dataset.busy === 'true' || Date.now() < cooldown) return;
  if (!form.elements.phone.value.trim() || !form.elements.phone.reportValidity()) {
    message('请先填写有效手机号。', 'error'); return;
  }
  if (!binding && !firstPhoneRegistrationValid(form)) return;
  const phone = form.elements.phone.value.replace(/[\s-]/g, '');
  form.elements.phone.value = phone;
  if (!/^1[3-9][0-9]{9}$/.test(phone)) { message('请填写有效的中国大陆手机号。', 'error'); return; }
  if (binding) { bindSending = true; bindChallenge = null; } else { phoneSending = true; phoneChallenge = null; }
  form.elements.code.value = ''; refreshPhoneControls();
  try {
    const result = await creatorRequest(`${base}/phone/code`, { method: 'POST', body: JSON.stringify({ phone, acceptedAccountTermsVersion: termsVersion, requestId: crypto.randomUUID() }) });
    if (typeof result.challengeId !== 'string' || !result.challengeId ||
      !Number.isFinite(result.expiresInSeconds) || result.expiresInSeconds <= 0 ||
      !Number.isFinite(result.retryAfterSeconds) || result.retryAfterSeconds < 0) throw new Error('creator_response_invalid');
    const challenge = { id: result.challengeId, phone, verifyRequestId: crypto.randomUUID(), expiresAt: Date.now() + result.expiresInSeconds * 1000 };
    if (binding) {
      bindChallenge = challenge; bindCooldownUntil = Date.now() + Math.max(60, result.retryAfterSeconds) * 1000;
    } else {
      phoneChallenge = challenge; phoneCooldownUntil = Date.now() + Math.max(60, result.retryAfterSeconds) * 1000;
    }
    message('验证码发送请求已受理，请查收；有效期 5 分钟，至少 60 秒后可重新获取。');
  } catch (error) {
    const unknown = error.status === 0 || error.code === 'creator_sms_send_outcome_unknown' ||
      (error.code ?? error.message) === 'creator_response_invalid';
    const retry = Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds :
      error.status === 429 || unknown ? 60 : 0;
    if (retry > 0) {
      if (binding) bindCooldownUntil = Date.now() + Math.max(60, retry) * 1000;
      else phoneCooldownUntil = Date.now() + Math.max(60, retry) * 1000;
    }
    message(unknown ? '短信发送结果未确认，不能视为已发送；请等待冷却结束后重新获取，不要连续请求。' : friendlyError(error), 'error');
  } finally {
    if (binding) bindSending = false; else phoneSending = false;
    refreshPhoneControls();
  }
}

function showSignedOut() {
  stopReviewWatch();
  account = null; work = null; versions = []; selectedVersion = null; clearPromotion();
  player?.destroy(); player = null; generation += 1;
  toggle('creator-auth', true); toggle('creator-workspace', false); toggle('creator-account-bar', false); toggle('creator-promotion', false);
  bindChallenge = null; byId('creator-phone-bind').elements.code.value = ''; refreshPhoneControls();
}

function showRecovery(key, username) {
  unsavedRecovery = true;
  byId('creator-recovery-value').value = key;
  byId('creator-recovery-value').dataset.username = username;
  toggle('creator-recovery', true);
  byId('creator-recovery').scrollIntoView({ block: 'start', behavior: 'auto' });
}

async function showSignedIn(value) {
  account = value;
  toggle('creator-auth', false); toggle('creator-workspace', available); toggle('creator-account-bar', true);
  byId('creator-account-name').textContent = `${account.publicNumber || '作者'}的创作者工作台`;
  byId('creator-phone-bind').closest('details').hidden = account.phoneBound !== false;
  toggle('creator-promotion', true); clearPromotion(); void refreshPromotion();
  byId('creator-account-bar').tabIndex = -1; byId('creator-account-bar').focus();
  refreshPhoneControls();
  if (available) { await refreshWorks(); resetEditor(); }
}

async function refreshWorks() {
  const response = await creatorRequest(`${base}/works`);
  const container = byId('creator-work-list');
  container.replaceChildren();
  if (!response.works.length) container.append(element('p', '还没有作品，先创建一份投稿。', 'community-muted'));
  for (const entry of response.works) {
    const button = element('button', undefined, 'creator-work-item');
    button.type = 'button'; button.setAttribute('aria-pressed', String(entry.workId === work?.workId));
    button.append(element('b', entry.metadata.titleZh), element('small', states[entry.state] ?? entry.state));
    button.addEventListener('click', () => {
      if (!studioBusy) void loadWork(entry.workId).catch(error => message(friendlyError(error), 'error'));
    });
    container.append(button);
  }
}

function resetEditor() {
  if (studioBusy) return;
  stopReviewWatch();
  generation += 1; player?.destroy(); player = null;
  work = null; selectedVersion = null; versions = [];
  toggle('creator-update-note', false); byId('creator-work-form').elements.updateNote.required = false; byId('creator-work-form').elements.pack.required = true; byId('creator-submit-ai').checked = false;
  const form = byId('creator-work-form'); form.reset();
  form.elements.slug.disabled = false; form.querySelector('fieldset').disabled = !available || !termsReady;
  toggle('creator-slug-label', false); toggle('creator-upload-section', false); toggle('creator-submit-section', false);
  byId('creator-editor-title').textContent = '发布新作品';
  byId('creator-work-save').textContent = '校验并预览';
  byId('creator-version-list').replaceChildren(); byId('creator-preview-stage').replaceChildren();
  byId('creator-upload-message').textContent = '';
  toggle('creator-preview-stage', false); toggle('creator-preview-strike', false);
}

async function loadWork(workId) {
  stopReviewWatch();
  const stamp = ++generation;
  const current = await creatorRequest(`${base}/works/${encodeURIComponent(workId)}`);
  const response = await creatorRequest(`${base}/works/${encodeURIComponent(workId)}/versions`);
  if (stamp !== generation) return;
  player?.destroy(); player = null; selectedVersion = null;
  work = current; versions = response.versions;
  const form = byId('creator-work-form');
  form.elements.slug.value = work.slug; form.elements.slug.disabled = true;
  form.elements.titleZh.value = work.metadata.titleZh; form.elements.description.value = work.metadata.description;
  form.elements.tags.value = work.metadata.tags.join('，'); form.elements.creatorDouyinNumber.value = work.metadata.creatorDouyinNumber || ''; form.elements.acceptFreeDistribution.checked = false;
  toggle('creator-update-note', true); form.elements.updateNote.required = true; form.elements.pack.required = false; form.elements.updateNote.value = ''; updateCounters();
  const reviewing = versions.some(version => version.state === 'PENDING_REVIEW');
  if (reviewing) message('此作品已有待审版本。必须先撤回再修改文字或抖音号；旧公开版本保持不变。');
  form.elements.pack.value = '';
  form.querySelector('fieldset').disabled = form.dataset.busy === 'true' || !available || !termsReady || work.state === 'SUSPENDED' || reviewing;
  byId('creator-editor-title').textContent = '更新作品';
  byId('creator-work-save').textContent = '校验并预览';
  toggle('creator-slug-label', false); toggle('creator-upload-section', true); toggle('creator-submit-section', true);
  toggle('creator-unpublish', work.state === 'PUBLISHED'); toggle('creator-share', work.state === 'PUBLISHED');
  toggle('creator-republish', work.state === 'UNPUBLISHED' && Boolean(work.publishedVersionId));
  byId('creator-share').href = work.appearanceNumber ? `appearance.html?number=${encodeURIComponent(work.appearanceNumber)}` : `community.html?work=${encodeURIComponent(work.workId)}`;
  byId('creator-preview-stage').replaceChildren(); toggle('creator-preview-stage', false); toggle('creator-preview-strike', false);
  byId('creator-submit').disabled = true; byId('creator-submit-accept').checked = false; byId('creator-submit-ai').checked = false;
  drawVersions(); await refreshWorks();
}

function drawVersions() {
  const container = byId('creator-version-list'); container.replaceChildren();
  for (const version of versions) {
    const row = element('div', undefined, 'creator-version');
    const text = element('div');
    text.append(element('b', `版本 ${version.versionLabel}`), element('p', states[version.state] ?? version.state, 'community-muted'));
    if (version.review?.reason) text.append(element('p', `审核说明：${version.review.reason}`, 'community-message'));
    if (version.state === 'PENDING_REVIEW' && version.review?.acceptAiContentReview !== true) {
      text.append(element('p', '该历史投稿尚未授权 AI 内容审核。查看原版本预览并勾选确认后，可直接补充授权，无需重新上传。', 'community-message'));
    }
    const button = element('button', '查看真实预览', 'community-button'); button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await chooseVersion(version); }
      catch (error) { message(friendlyError(error), 'error'); }
      finally { button.disabled = false; }
    });
    row.append(text, button);
    if (version.state === 'PENDING_REVIEW') {
      const withdraw = element('button', '撤回并修改', 'community-button'); withdraw.type = 'button';
      withdraw.addEventListener('click', async () => {
        if (studioBusy || !work || !confirm('撤回当前待审版本并重新编辑？旧公开版本继续保留，旧审核结果不再生效。')) return;
        const workId = work.workId; withdraw.disabled = true; setStudioBusy(true); stopReviewWatch();
        try {
          await withdrawCreatorWork(workId, creatorRequest);
          if (work?.workId !== workId) return;
          await loadWork(workId);
          message('服务器已确认撤回。可修改文字、本人抖音号或素材后重新送审；原公开版本未被替换。');
        } catch (error) { message(friendlyError(error), 'error'); }
        finally { setStudioBusy(false); withdraw.disabled = false; }
      });
      row.append(withdraw);
    }
    container.append(row);
  }
}

async function chooseVersion(version) {
  const stamp = ++generation;
  player?.destroy(); player = null; selectedVersion = null;
  toggle('creator-preview-stage', true); toggle('creator-preview-strike', false);
  byId('creator-preview-stage').textContent = '正在读取真实素材…';
  byId('creator-submit').disabled = true; byId('creator-submit-accept').checked = false; byId('creator-submit-ai').checked = false;
  const result = await mountCreatorPreview(byId('creator-preview-stage'), version);
  if (stamp !== generation) { result.destroy(); return; }
  player = result; selectedVersion = version;
  toggle('creator-preview-strike', true);
  byId('creator-upload-message').textContent = `正在查看 ${version.versionLabel} · ${states[version.state] ?? version.state}`;
}

byId('creator-login').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  void run(form, async fields => {
    const result = await creatorRequest(`${base}/login`, { method: 'POST', body: JSON.stringify({
      username: fields.username, password: fields.password, rememberMe: form.elements.rememberMe.checked
    }) });
    form.elements.password.value = ''; await showSignedIn(result.account); message('已登录。下载制作指南包后，可发布新作品或从“我的作品”上传更新。');
  });
});
byId('creator-phone-login').elements.acceptTerms.addEventListener('change', refreshPhoneControls);
byId('creator-phone-send').addEventListener('click', () => { void sendPhoneCode(false); });
byId('creator-phone-bind-send').addEventListener('click', () => { void sendPhoneCode(true); });
for (const binding of [false, true]) {
  const form = byId(binding ? 'creator-phone-bind' : 'creator-phone-login');
  form.elements.phone.addEventListener('input', () => {
    if (binding) bindChallenge = null; else phoneChallenge = null;
    form.elements.code.value = ''; refreshPhoneControls();
  });
}
byId('creator-phone-login').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  if (!phoneReady || !firstPhoneRegistrationValid(form) || !form.reportValidity()) return;
  const challenge = phoneChallenge;
  if (!challenge || challenge.expiresAt <= Date.now() || challenge.phone !== form.elements.phone.value.trim()) {
    message('请为当前手机号重新获取有效验证码。', 'error'); return;
  }
  void run(form, async fields => {
    const first = fields.mode === 'new';
    const body = { phone: fields.phone.trim(), challengeId: challenge.id, code: fields.code.trim(), rememberMe: form.elements.rememberMe.checked };
    if (first) Object.assign(body, { acceptTerms: true, termsVersion });
    body.requestId = challenge.verifyRequestId; body.acceptedAccountTermsVersion = termsVersion;
    let result;
    try { result = await creatorRequest(`${base}/phone/login`, { method: 'POST', body: JSON.stringify(body) }); }
    catch (error) {
      if (error.code === 'creator_terms_acceptance_required') {
        form.elements.acceptTerms.checked = false;
        form.elements.mode.value = 'new'; updatePhoneMode();
        message('该手机号尚未注册，当前未登录。请阅读并确认验证码下方的授权条款，再重新获取验证码，点击“验证并进入工作台”。', 'error');
        byId('creator-phone-registration').scrollIntoView({ block: 'center', behavior: 'auto' });
        return;
      }
      if (error.status === 0 || error.code === 'creator_response_invalid') {
        try { const restored = await creatorRequest(`${base}/session`); await showSignedIn(restored.account); phoneChallenge = null; form.elements.code.value = ''; message('已通过服务器会话确认登录。'); } catch { message('登录结果尚未确认，请先刷新页面恢复会话；不要重复提交同一个验证码。', 'error'); } return;
      }
      throw error;
    }
    phoneChallenge = null; form.elements.code.value = ''; form.elements.phone.value = ''; form.elements.acceptTerms.checked = false;
    await showSignedIn(result.account);
    byId('creator-account-bar').scrollIntoView({ block: 'start', behavior: 'auto' });
    message(`${result.created ? '账号已按本次明确确认的条款创建。' : '已登录。'}${result.rememberMe === true ? '已启用保持登录 30 天。' : '使用浏览器会话，最多 8 小时。'}作品免费分发与 AI 审核授权仍需分别确认。`);
  });
});
byId('creator-phone-bind').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  if (!account || !phoneReady || !form.reportValidity()) return;
  const challenge = bindChallenge;
  if (!challenge || challenge.expiresAt <= Date.now() || challenge.phone !== form.elements.phone.value.trim()) {
    message('请为要绑定的手机号重新获取有效验证码。', 'error'); return;
  }
  void run(form, async fields => {
    bindChallenge = null; form.elements.code.value = '';
    try {
      const result = await creatorRequest(`${base}/phone/bind`, { method: 'POST', body: JSON.stringify({
        phone: fields.phone.trim(), challengeId: challenge.id, code: fields.code.trim()
      }) });
      if (result.ok !== true || result.phoneBound !== true) throw new Error('creator_response_invalid');
      form.elements.phone.value = '';
      byId('creator-phone-bind-status').textContent = '本次绑定已确认成功；原账号与作品归属保留。';
      message('手机已显式绑定到当前账号，没有合并账号或迁移作品。');
    } catch (error) {
      if (error.status === 409) { message('手机绑定发生冲突，未更改账号或作品归属。请确认手机与账号关系；再次尝试需重新获取验证码。', 'error'); return; }
      if (error.status === 0 || (error.code ?? error.message) === 'creator_response_invalid') {
        message('绑定结果尚未确认，不要重复提交同一个验证码；请稍后确认绑定结果或重新登录。', 'error'); return;
      }
      throw error;
    }
  });
});
byId('creator-recover').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  void run(form, async fields => {
    const result = await creatorRequest(`${base}/recover`, { method: 'POST', body: JSON.stringify(fields) });
    form.elements.password.value = ''; form.elements.recoveryKey.value = '';
    showSignedOut(); showRecovery(result.recoveryKey, fields.username); message('密码已重置，旧恢复码失效。保存新恢复码后重新登录。');
  });
});
byId('creator-logout').addEventListener('click', async () => {
  try { await creatorRequest(`${base}/logout`, { method: 'POST', body: '{}' }); showSignedOut(); message('已退出登录。'); }
  catch (error) { message(friendlyError(error), 'error'); }
});
byId('creator-recovery-copy').addEventListener('click', async () => {
  try { await copyText(byId('creator-recovery-value').value, byId('creator-recovery-value')); message('恢复码已复制，请保存到自己的私密位置。'); }
  catch { message('恢复码已选中，请手动复制。'); }
});
byId('creator-recovery-export').addEventListener('click', () => {
  const field = byId('creator-recovery-value');
  saveFile(new Blob([`牛马电子功德创作者账号恢复信息\n用户名：${field.dataset.username}\n恢复码：${field.value}\n请私密保存，不要发送给他人。\n`], { type: 'text/plain;charset=utf-8' }), 'niuma-creator-recovery.txt');
});
byId('creator-recovery-saved').addEventListener('click', () => {
  unsavedRecovery = false; byId('creator-recovery-value').value = ''; delete byId('creator-recovery-value').dataset.username;
  toggle('creator-recovery', false); message('恢复码已从页面清除，请开始投稿。');
});
byId('creator-new-work').addEventListener('click', resetEditor);
byId('creator-work-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  if (studioBusy || form.dataset.busy === 'true' || !account || !available || !termsReady || work?.state === 'SUSPENDED') return;
  if (!form.reportValidity() || !form.elements.acceptFreeDistribution.checked) return;
  const file = form.elements.pack.files[0];
  if ((!file && !work) || (file && (!file.name.endsWith('.nmgpack') || file.size > 8 * 1024 * 1024))) {
    message('请选择不超过 8 MiB 的 .nmgpack 文件。', 'error'); return;
  }
  if (!form.elements.titleZh.value.trim() || !form.elements.description.value.trim()) {
    message('请填写作品名称和一句话介绍。', 'error'); return;
  }
  let validated;
  try { validated = metadata({ ...formValues(form), isUpdate: Boolean(work) }); } catch (error) { message(error.message, 'error'); return; }
  if (versions.some(version => version.state === 'PENDING_REVIEW')) { message('请先撤回待审版本，再修改并送审。', 'error'); return; }
  void run(form, async fields => {
    setStudioBusy(true); stopReviewWatch();
    try {
      const data = { ...validated, sharingTermsVersion: termsVersion, acceptFreeDistribution: true }; 
      const path = work ? `${base}/works/${encodeURIComponent(work.workId)}` : `${base}/works`;
      const result = await creatorRequest(path, { method: work ? 'PATCH' : 'POST', body: JSON.stringify(data) });
      if (typeof result.workId !== 'string' || !result.workId) throw new Error('creator_response_invalid');
      work = { ...work, ...result };
      const workId = work.workId;
      byId('creator-editor-title').textContent = '更新作品';
      toggle('creator-upload-section', true);
      let version;
      if (file) version = await uploadWorkPackage(file, workId);
      else {
        if (!result.draftVersionId) throw new Error('creator_metadata_only_update_unavailable');
        const response = await creatorRequest(`${base}/works/${encodeURIComponent(workId)}/versions`);
        version = response.versions.find(entry => entry.versionId === result.draftVersionId);
        if (!version) throw new Error('creator_response_invalid');
      }
      if (work?.workId !== workId) return;
      await loadWork(workId);
      if (work?.workId !== workId) return;
      await chooseVersion(version);
      message('文件已检查并保存。请确认真实预览，明确勾选免费分发与 AI 内容审核授权后再送审；新版本通过前，原公开版本保持不变。');
    } catch (error) {
      if (work) {
        toggle('creator-upload-section', true);
        byId('creator-upload-message').textContent = '本次校验或预览未完成，作品已保留。可选择文件重试，无需重新创建作品；原公开版本未被替换。';
        await refreshWorks().catch(() => {});
      }
      throw error;
    } finally { setStudioBusy(false); }
  });
});
async function uploadWorkPackage(file, workId) {
    toggle('creator-upload-progress', true); byId('creator-upload-progress').value = 0;
    byId('creator-upload-message').textContent = '正在上传，请不要离开页面。';
    try {
      const version = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${base}/works/${encodeURIComponent(workId)}/upload`);
        xhr.setRequestHeader('content-type', 'application/octet-stream'); xhr.withCredentials = true; xhr.timeout = 120000;
        xhr.upload.onprogress = event => { if (event.lengthComputable) byId('creator-upload-progress').value = Math.round(event.loaded / event.total * 100); };
        xhr.upload.onload = () => { byId('creator-upload-message').textContent = '上传完成，正在安全检查、清理图片附加数据并保存素材…'; };
        xhr.onload = () => {
          let result;
          try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('creator_service_unavailable')); return; }
          if (xhr.status < 200 || xhr.status >= 300) {
            const error = new Error(typeof result.error === 'string' ? result.error : 'creator_service_unavailable');
            error.code = error.message; error.status = xhr.status;
            if (typeof result.field === 'string' && /^[a-zA-Z0-9_.\[\]-]{1,120}$/.test(result.field)) error.field = result.field;
            reject(error);
          }
          else resolve(result);
        };
        xhr.onerror = () => reject(new Error('creator_service_unavailable'));
        xhr.ontimeout = () => reject(new Error('creator_service_unavailable'));
        xhr.send(file);
      });
      return version;
    } finally { toggle('creator-upload-progress', false); }
}
byId('creator-preview-strike').addEventListener('click', () => player?.strike());
function updateSubmitConsent() {
  byId('creator-submit').disabled = !byId('creator-submit-accept').checked || !byId('creator-submit-ai').checked || !byId('creator-work-form').elements.acceptFreeDistribution.checked || !player ||
    !canSubmitVersion(selectedVersion) || work?.state === 'SUSPENDED';
}
for (const checkbox of [byId('creator-submit-accept'), byId('creator-submit-ai'), byId('creator-work-form').elements.acceptFreeDistribution]) checkbox.addEventListener('change', updateSubmitConsent);
byId('creator-submit').addEventListener('click', async () => {
  const button = byId('creator-submit'); button.disabled = true;
  try {
    if (!work || !selectedVersion || !player || !byId('creator-submit-accept').checked || !byId('creator-submit-ai').checked || !byId('creator-work-form').elements.acceptFreeDistribution.checked) return;
    const workId = work.workId, versionId = selectedVersion.versionId;
    const result = await creatorRequest(`${base}/works/${encodeURIComponent(workId)}/submit`, { method: 'POST',
      body: JSON.stringify({ versionId, acceptFreeDistribution: true, acceptAiContentReview: true, sharingTermsVersion: termsVersion, creatorDouyinNumber: work.metadata?.creatorDouyinNumber ?? null }) });
    if (typeof result.reviewMode === 'string') reviewMode = result.reviewMode;
    if (work?.workId !== workId) return;
    await loadWork(workId);
    if (work?.workId !== workId) return;
    const version = versions.find(entry => entry.versionId === versionId);
    if (version) describeReview(version);
    if (reviewMode === 'automatic') watchReview(workId, versionId);
  } catch (error) { message(friendlyError(error), 'error'); }
});
byId('creator-review-refresh').addEventListener('click', async () => {
  if (!work) return;
  const button = byId('creator-review-refresh'); button.disabled = true;
  const target = selectedVersion ?? versions.find(version => version.state === 'PENDING_REVIEW') ?? versions[0];
  try {
    if (!target) { message('尚未上传可审核的版本。'); return; }
    const version = await refreshReviewResult(work.workId, target.versionId, generation);
    if (version && describeReview(version) && reviewMode === 'automatic') watchReview(work.workId, target.versionId);
  } catch (error) { message(friendlyError(error), 'error'); }
  finally { button.disabled = false; }
});
byId('creator-unpublish').addEventListener('click', async () => {
  const button = byId('creator-unpublish'); button.disabled = true;
  try {
    await creatorRequest(`${base}/works/${encodeURIComponent(work.workId)}/unpublish`, { method: 'POST', body: '{}' });
    await loadWork(work.workId); message('已下架，新用户不再能获取；已导入的合法副本不回收。');
  } catch (error) { message(friendlyError(error), 'error'); }
  finally { button.disabled = false; }
});
byId('creator-republish').addEventListener('click', async () => {
  const button = byId('creator-republish'); button.disabled = true;
  try {
    await creatorRequest(`${base}/works/${encodeURIComponent(work.workId)}/republish`, { method: 'POST', body: '{}' });
    await loadWork(work.workId); message('原来的已审核版本已重新公开。草稿修改没有对外发布，如需更新请重新送审。');
  } catch (error) { message(friendlyError(error), 'error'); }
  finally { button.disabled = false; }
});
addEventListener('beforeunload', event => { if (unsavedRecovery) { event.preventDefault(); event.returnValue = ''; } });
addEventListener('pagehide', () => {
  stopReviewWatch(); player?.destroy(); byId('creator-recovery-value').value = '';
  clearTimeout(phoneTimer); phoneTimer = null; phoneChallenge = null; bindChallenge = null;
  for (const id of ['creator-phone-login', 'creator-phone-bind']) {
    byId(id).elements.phone.value = ''; byId(id).elements.code.value = '';
  }
});
addEventListener('pageshow', event => { if (event.persisted) { updatePhoneMode(); void start(); } });

async function start() {
  updatePhoneMode();
  try {
    const session = await creatorRequest(`${base}/session`);
    await showSignedIn(session.account); message('已通过安全 Cookie 恢复登录。');
  } catch (error) {
    showSignedOut(); message(error.status === 401 ? '请选择手机号登录或已有用户名账号入口；首次注册必须明确确认当前条款。' :
      '会话暂时无法确认，可稍后重试；账号入口仍保留，尚不代表已登录。', error.status === 401 ? '' : 'error');
  }
  const phoneTask = (async () => {
    try {
      const status = await creatorRequest(`${base}/phone/status`);
      phoneReady = status.enabled === true && status.ready === true;
      const reasons = {
        disabled: '短信登录尚未开放。', configuration_unavailable: '短信服务配置尚未就绪，不会模拟发送验证码。',
        schema_unavailable: '短信账号数据结构尚未就绪，暂不能发送或登录。',
        state_unavailable: '短信登录状态暂不可用，请稍后再试。'
      };
      byId('creator-phone-status').textContent = phoneReady ? '短信登录已就绪。验证码用于验证手机，不代签版权或分发授权。' :
        `${reasons[status.reason] ?? '短信登录尚未就绪。'}已有用户名账号入口仍保留。`;
      byId('creator-phone-bind-status').textContent = phoneReady ? '仅未绑定手机的旧账号需要迁移；手机登录者无需重复绑定。' :
        '手机绑定暂未开放或未就绪；原账号和作品继续保留。';
    } catch (error) {
      phoneReady = false;
      byId('creator-phone-status').textContent = `短信登录状态未能确认：${friendlyError(error)} 已有用户名账号入口仍保留。`;
      byId('creator-phone-bind-status').textContent = '手机绑定能力未能确认，暂不请求验证码。';
    } finally {
      if (!phoneReady) byId('creator-legacy-entry').open = true;
      refreshPhoneControls();
    }
  })();
  const termsTask = (async () => {
    try {
      const terms = await creatorRequest(`${base}/terms`);
      if (typeof terms.version !== 'string' || !terms.version.trim() || typeof terms.text !== 'string' || !terms.text.trim()) {
        throw new Error('creator_paid_terms_unavailable');
      }
      termsVersion = terms.version; termsReady = true;
      if (/收费|付费|统一价格/.test(terms.text)) throw new Error('creator_free_terms_unavailable');
      byId('creator-terms').textContent = terms.text;
    } catch {
      termsVersion = null; termsReady = false;
      byId('creator-terms').textContent = '当前条款暂未读取成功，不能确认首次注册；已有账号登录不需要重新注册。';

    } finally {
      refreshPhoneControls();
      const form = byId('creator-work-form');
      form.querySelector('fieldset').disabled = form.dataset.busy === 'true' || !available || !termsReady || work?.state === 'SUSPENDED';
    }
  })();
  const workspaceTask = (async () => {
    try {
      const status = await creatorRequest('/api/gongde/community/status');
      reviewMode = typeof status.reviewMode === 'string' ? status.reviewMode : 'disabled';
      available = status.enabled === true && status.ready === true;
      if (!available) { toggle('creator-workspace', false); message('投稿服务暂未开放或未就绪；账号入口仍保留，不代表投稿或免费领取已开放。'); return; }
      if (account) { await refreshWorks(); resetEditor(); toggle('creator-workspace', true); }
    } catch (error) { available = false; toggle('creator-workspace', false); message(friendlyError(error), 'error'); }
  })();
  await Promise.allSettled([phoneTask, termsTask, workspaceTask]);
}
void start();

function updateCounters(){const form=byId('creator-work-form');byId('creator-title-count').textContent=codePoints(form.elements.titleZh.value)+'/20';byId('creator-description-count').textContent=codePoints(form.elements.description.value)+'/40';}
for(const name of ['titleZh','description'])byId('creator-work-form').elements[name].addEventListener('input',updateCounters);
let promotion=null, promotionTimer=null, promotionEpoch=0, promotionLoading=false;
function clearPromotion(){
  promotionEpoch+=1;clearTimeout(promotionTimer);promotionTimer=null;promotion=null;
  byId('creator-promotion-code').textContent='';byId('creator-promotion-share-text').value='';byId('creator-promotion-share-text').hidden=true;
  byId('creator-promotion-copy').disabled=true;byId('creator-promotion-share').disabled=true;
}
function schedulePromotion(){
  clearTimeout(promotionTimer);promotionTimer=null;if(!account)return;
  const until=Date.parse(promotion?.expiresAt)-Date.now();
  const delay=Number.isFinite(until)&&until>0?Math.min(30000,until+1):30000;
  promotionTimer=setTimeout(()=>{byId('creator-promotion-copy').disabled=true;byId('creator-promotion-share').disabled=true;void refreshPromotion();},delay);
}
async function refreshPromotion(){
  if(!account||promotionLoading)return;
  const owner=account,stamp=promotionEpoch;promotionLoading=true;
  byId('creator-promotion-copy').disabled=true;byId('creator-promotion-share').disabled=true;
  try{
    const value=await freeRequest('/creator/promotion');
    if(account!==owner||stamp!==promotionEpoch)return;
    promotion={...value,shareText:promotionShareText(value)};const usable=promotionUsable(value);
    byId('creator-promotion-code').textContent=usable?value.code:'';
    byId('creator-promotion-state').textContent=usable?'当前推广码已由服务端确认，可由本人和其他持码人重复使用；每 30 秒刷新，到期立即重新读取。':'推广码尚未激活或暂不可用。首个独立新作品通过审核且发布后激活。';
    byId('creator-promotion-details').textContent='有效贡献 '+(value.contributionCount??'未确认')+' 件 · 每批上限 '+(value.maxItems??'未确认')+' 个 · 不扣次数、不共享余额'+(value.expiresAt?' · 换码时间 '+new Date(value.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'');
    byId('creator-promotion-copy').disabled=!usable;
    byId('creator-promotion-share').disabled=!usable||!promotion.shareText;
    byId('creator-promotion-share-text').value=usable?promotion.shareText:'';
    byId('creator-promotion-share-text').hidden=!usable||!byId('creator-promotion-share-text').value;
  }catch(error){
    if(account!==owner||stamp!==promotionEpoch)return;
    promotion=null;byId('creator-promotion-code').textContent='';byId('creator-promotion-share-text').value='';byId('creator-promotion-share-text').hidden=true;
    byId('creator-promotion-state').textContent=errorText(error);
  }finally{
    promotionLoading=false;
    if(account&&(account!==owner||stamp!==promotionEpoch))void refreshPromotion();else schedulePromotion();
  }
}
byId('creator-promotion-refresh').onclick=()=>void refreshPromotion();
for(const[id,field]of[['creator-promotion-copy','code'],['creator-promotion-share','shareText']])byId(id).onclick=async()=>{
  // A sleeping tab may miss timers: recheck the boundary immediately before copying.
  if(!account||!promotionUsable(promotion)){
    byId('creator-promotion-copy').disabled=true;byId('creator-promotion-share').disabled=true;
    message('推广码已到期或状态未确认，正在读取新状态；本次没有复制旧码。');await refreshPromotion();return;
  }
  const value=promotion[field];if(typeof value!=='string'||!value)return;
  try{await navigator.clipboard.writeText(value);message('已复制。');}
  catch{const fallback=field==='shareText'?byId('creator-promotion-share-text'):byId('creator-promotion-code');
    if(field==='shareText'){fallback.hidden=false;fallback.focus();fallback.select();}
    else{const range=document.createRange();range.selectNodeContents(fallback);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}
    message('无法自动复制，文字已选中，请手动复制。');
  }
};
addEventListener('pagehide',()=>{clearTimeout(promotionTimer);promotionTimer=null;});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&account){clearTimeout(promotionTimer);void refreshPromotion();}});
