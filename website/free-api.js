export const API = '/api/gongde/v2';
export const SELECTION_KEY = 'niuma-free-selection-v2';
export const CONFIRMATION_KEY = 'niuma-free-confirmation-v2';
export const MAX_ITEMS = 10;
export const MAX_BYTES = 16 * 1024 * 1024;
export const PERMANENT_NOTE = '下载后可长期保存，随时导入，永久离线使用';

export const normalizeText = value => String(value ?? '').normalize('NFC').trim();
export const codePoints = value => [...normalizeText(value)].length;
export const validNumber = value => /^\d{6,9}$/.test(String(value)) && Number(value) >= 100001 && Number(value) <= 999999999;
export const safeDownloadUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};
export function validAccess(value, now = Date.now()) {
  return value && ['GROUP', 'CREATOR'].includes(value.kind) && value.authorized !== false && value.valid !== false &&
    !['EXPIRED', 'PAUSED', 'INVALID', 'NONE', 'REVOKED'].includes(value.state) &&
    Number.isInteger(value.maxItems) && value.maxItems >= 1 && value.maxItems <= MAX_ITEMS && Date.parse(value.expiresAt) > now;
}
export function validateSelection(items, limit = MAX_ITEMS) {
  if (!Array.isArray(items) || !items.length || new Set(items.map(item => String(item.number))).size !== items.length) return '每批需选择不同形象，请检查选择。';
  if (items.length > Math.min(limit, MAX_ITEMS)) return `当前每批最多 ${Math.min(limit, MAX_ITEMS)} 个，请调整选择；不会自动删除。`;
  if (items.some(item => !validNumber(item.number) || typeof item.catalogRevision !== 'string' || !item.catalogRevision || item.canClaim !== true)) return '作品版本或领取状态未能确认，请返回形象库重新选择。';
  if (items.some(item => !Number.isSafeInteger(item.deliveryBytesUpperBound) || item.deliveryBytesUpperBound < 0)) return '所选文件大小暂时无法确认，请刷新形象状态。';
  if (items.reduce((sum, item) => sum + item.deliveryBytesUpperBound, 0) > MAX_BYTES) return '文件总大小超过 16 MiB，请减少形象后分批领取。';
  return null;
}
export function readSelection(storage = sessionStorage) {
  try {
    const items = JSON.parse(storage.getItem(SELECTION_KEY) || '[]');
    return Array.isArray(items) ? items.filter(item => validNumber(item?.number)).slice(0, MAX_ITEMS) : [];
  } catch { return []; }
}
export function writeSelection(items, storage = sessionStorage) {
  storage.setItem(SELECTION_KEY, JSON.stringify(items));
}
export function confirmation(items, storage = sessionStorage, createId = () => crypto.randomUUID()) {
  const digest = JSON.stringify(items.map(({ number, catalogRevision }) => ({ number, catalogRevision })));
  let previous;
  try { previous = JSON.parse(storage.getItem(CONFIRMATION_KEY) || 'null'); } catch { /* New confirmation. */ }
  if (previous?.digest === digest && typeof previous.key === 'string') return previous;
  const value = { key: createId(), digest };
  storage.setItem(CONFIRMATION_KEY, JSON.stringify(value));
  return value;
}
export function pendingConfirmation(items, storage = sessionStorage) {
  try {
    const value = JSON.parse(storage.getItem(CONFIRMATION_KEY) || 'null');
    const digest = JSON.stringify(items.map(({ number, catalogRevision }) => ({ number, catalogRevision })));
    return value?.sent === true && typeof value.key === 'string' && value.key && value.digest === digest ? value : null;
  } catch { return null; }
}
export function clearConfirmation(storage = sessionStorage) { storage.removeItem(CONFIRMATION_KEY); }
export function promotionUsable(value, now = Date.now()) {
  return Boolean(value && typeof value.code === 'string' && value.code && value.active !== false &&
    value.status === 'ACTIVE' && value.accountState === 'ACTIVE' && value.redemptionEnabled === true &&
    !['PAUSED', 'SUSPENDED', 'EXPIRED', 'INACTIVE', 'REVOKED'].includes(value.state) &&
    Number.isInteger(value.maxItems) && value.maxItems > 0 && value.maxItems <= MAX_ITEMS && Date.parse(value.expiresAt) > now);
}
export function promotionShareText(value) {
  if (!promotionUsable(value)) return '';
  const expiresAt = new Date(value.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  return `牛马电子功德的基础木鱼直接免费下载。更多桌面形象可用我的推广码免费领取：${value.code}，每批最多 ${value.maxItems} 个，可重复使用，不扣次数。此码有效至北京时间 ${expiresAt}，已下载形象可长期保存、随时导入。官网：https://gongde.zqscreen.cn/`;
}
export function reportFields(fields) {
  const category = fields.category;
  const description = normalizeText(fields.description), evidenceText = normalizeText(fields.evidenceText), contact = normalizeText(fields.contact);
  const fail = (field, message) => { const error = new Error(message); error.field = field; throw error; };
  if (!['copyright', 'harmful', 'malicious', 'other'].includes(category)) fail('category', '请选择侵权、违法有害、恶意内容或其他。');
  if (codePoints(description) < 10 || codePoints(description) > 1000) fail('description', '问题说明需为 10 至 1000 个字。');
  if (codePoints(evidenceText) > 1000) fail('evidenceText', '证据说明最多 1000 个字，不接收附件或自动访问链接。');
  if (codePoints(contact) > 120) fail('contact', '选填联系方式最多 120 个字。');
  return { category, description, ...(evidenceText ? { evidenceText } : {}), ...(contact ? { contact } : {}) };
}
export async function withdrawCreatorWork(workId, send) {
  const result = await send(`/api/gongde/creators/works/${encodeURIComponent(workId)}/withdraw`, { method: 'POST', body: '{}' });
  if (result?.ok !== true) throw new Error('creator_response_invalid');
  return result;
}
export function metadata(fields) {
  const titleZh = normalizeText(fields.titleZh), description = normalizeText(fields.description);
  const tags = [...new Set(String(fields.tags ?? '').split(/[,，、]/).map(normalizeText).filter(Boolean))];
  const creatorDouyinNumber = normalizeText(fields.creatorDouyinNumber) || null;
  const updateNote = normalizeText(fields.updateNote);
  const singleLine = value => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
  if (!singleLine(titleZh) || codePoints(titleZh) < 1 || codePoints(titleZh) > 20) throw new Error('作品名称应为 1 至 20 个字的单行文字。');
  if (!singleLine(description) || codePoints(description) < 1 || codePoints(description) > 40) throw new Error('一句话介绍应为 1 至 40 个字的单行文字。');
  if (tags.length > 3 || tags.some(tag => !singleLine(tag) || codePoints(tag) > 8)) throw new Error('最多 3 个不同标签，每个 1 至 8 个字。');
  if (creatorDouyinNumber && !/^[A-Za-z0-9_.-]{1,32}$/.test(creatorDouyinNumber)) throw new Error('我的抖音号只接受 1 至 32 位字母、数字、下划线、短横线或点，不填写链接。');
  if (fields.isUpdate && (!singleLine(updateNote) || codePoints(updateNote) < 1 || codePoints(updateNote) > 80)) throw new Error('请填写 1 至 80 个字的单行更新说明。');
  return { titleZh, description, creatorDouyinNumber, tags, ...(fields.isUpdate ? { updateNote } : {}) };
}
const errors = {
  access_code_invalid: '领取码不正确，请检查后重试。',
  access_code_expired: '领取码已更新，请从粉丝群或分享者处获取最新码。',
  access_code_paused: '此领取码暂不可用，请联系分享者或使用群权益码。',
  access_required: '请先输入有效领取码。',
  access_service_unavailable: '暂时无法验证，已选形象仍保留。',
  batch_too_large: '文件总大小超过 16 MiB，请减少形象后分批领取。',
  selection_limit_exceeded: '当前码权限已变化，请刷新状态并调整选择；不会自动删除。',
  catalog_revision_conflict: '形象版本已更新，请重新预览并确认选择。',
  catalog_revision_changed: '形象版本已更新，请重新预览并确认选择。',
  claim_not_found: '该领取记录不存在或无法访问，请在原浏览器打开。',
  claim_expired: '本站本批重下载入口已到期，已下载文件仍可随时导入。',
  claim_blocked: '包含暂不可分发的作品，本次不能下载。',
  claim_service_unavailable: '交付服务暂不可用，原领取记录仍保留。'
};
export function errorText(error) {
  if (error?.status === 429) return `操作过于频繁，请等待 ${error.retryAfterSeconds || 60} 秒后重试；权限没有被消费。`;
  if ([401, 404].includes(error?.status) && String(error?.path).startsWith('/claims/')) return errors.claim_not_found;
  return errors[error?.code] || error?.userMessage || '服务暂时无法连接或返回的信息不完整，请稍后重试；已有选择与记录仍保留。';
}
export async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000), ...options,
      headers: { 'content-type': 'application/json', ...options.headers } });
  } catch { const error = new Error('network_unavailable'); error.path = path; throw error; }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || `http_${response.status}`);
    Object.assign(error, { code: body?.error, userMessage: typeof body?.message === 'string' ? body.message : null,
      status: response.status, path, retryAfterSeconds: Number(response.headers.get('Retry-After')) || 0 });
    throw error;
  }
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'data')) throw new Error('response_invalid');
  return body.data;
}
export const post = (path, body = {}, headers = {}) => request(path, { method: 'POST', body: JSON.stringify(body), headers });
