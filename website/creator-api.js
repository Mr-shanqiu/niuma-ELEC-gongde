const messages = {
  creator_metadata_only_update_unavailable: '仅文字更新的待审素材复用尚未由服务端确认。原作品保留；请上传原源包重新生成待审版本，不会把修改当作已发布。',
  creator_free_terms_unavailable: '当前免费条款尚未就绪，暂不能提交；旧收费授权不会被当作免费授权。',
  creator_free_downloads_disabled: '社区下载统一通过免费领取，请重新选择形象后继续。',
  creator_free_delivery_retired: '社区下载统一通过免费领取，请重新选择形象后继续。',
  creator_paid_checkout_unavailable: '请在社区选择形象，再通过统一领取页免费领取。',
  creator_paid_sales_not_ready: '社区付费下载暂未开放，仍可免费浏览和预览。',
  creator_network_unavailable: '网络暂时无法连接，已有选择不会因此移除，请稍后重试。',
  creator_response_invalid: '服务返回的信息暂时不完整，请稍后重试，不要重复提交。',
  creator_paid_delivery_unavailable: '本次作品暂时无法交付，请保留订单并稍后重试。',
  market_catalog_snapshot_invalid: '形象版本或授权已变化，请重新选择后再领取；权限未消费。',
  appearance_preview_outdated: '形象已有新版，请重新预览并选择后再领取；权限未消费。',
  creator_free_batch_too_large: '所选文件超过单批大小上限，请减少形象数量后再下载。',
  creator_free_batch_invalid: '这批选择不正确，请刷新并重新选择。',
  creator_republish_not_available: '只能恢复原来已审核的下架版本。被暂停的作品不能自行恢复，修改后的草稿需要重新送审。',
  creator_disabled: '创作者社区暂未开放，请稍后再来。',
  creator_configuration_unavailable: '社区正在维护，暂时无法提供服务。',
  creator_service_unavailable: '社区暂时无法连接，请稍后重试。',
  creator_auth_required: '登录已过期，请重新登录。',
  creator_login_failed: '用户名或密码不正确。',
  creator_phone_invalid: '手机号格式不正确，请填写服务支持的有效手机号。',
  creator_phone_login_invalid: '短信登录信息不完整或格式不正确，请为当前手机号重新获取验证码后再提交。',
  creator_remember_me_invalid: '保持登录选项格式不正确，请刷新页面后重试。',
  creator_terms_acceptance_required: '请先阅读并确认当前账号协议与隐私说明，再验证并登录。无需昵称。',
  creator_sms_code_invalid: '验证码不正确或已失效，请等待冷却结束后重新获取验证码再登录或绑定。',
  creator_sms_code_locked: '验证码尝试次数已达上限，请等待冷却结束后重新获取，不要继续尝试旧验证码。',
  creator_sms_challenge_invalid: '验证码请求无效或已过期，请为当前手机号重新获取验证码。',
  creator_sms_already_consumed: '该验证码已被消费，不能重复使用；若登录结果不明确，请先刷新恢复会话，否则重新获取验证码。',
  creator_sms_rate_limited: '验证码请求过于频繁，请等待页面倒计时及服务端冷却结束后再试。',
  creator_phone_auth_unavailable: '短信登录尚未开放或未就绪，请使用已有用户名账号入口；不会模拟发送验证码。',
  creator_sms_provider_unavailable: '短信服务暂时不可用，尚未确认发送成功；请按冷却提示稍后重试，已有账号入口仍保留。',
  creator_sms_send_outcome_unknown: '短信发送结果未知，不能视为发送成功；请等待冷却结束后重新获取，不要连续请求。',
  creator_recovery_failed: '用户名或恢复码不正确，或该账号已暂停。',
  creator_record_exists: '用户名或作品短名已存在，请换一个；重复上传的文件也可能已保存。',
  creator_rate_limited: '操作过于频繁，请稍后再试。',
  creator_auth_busy: '登录服务暂忙，请稍后再试。',
  creator_storage_busy: '素材存储暂忙，请稍后再试。',
  creator_upload_busy: '上传服务暂忙，请稍后再试。',
  creator_request_too_large: '文件过大，请压缩到 8 MB 以内。',
  creator_metadata_invalid: '请检查名称、介绍、标签和平台免费分发声明。',
  creator_sharing_acceptance_required: '请确认最新的平台免费分发声明后再提交审核；首版不提供创作者分成。',
  creator_ai_review_acceptance_required: '请刷新页面并确认 AI 内容审核授权后再提交。',
  creator_review_superseded: '本次审核已被较新版本取代，或作品已下架；不会自动覆盖当前版本或重新上架，请查看最新作品状态。',
  creator_review_render_failed: '审核预览渲染未完成，作品尚未放行；请稍后查看状态或等待复核，不要重复提交。',
  creator_review_response_invalid: '审核返回结果无法确认，作品尚未放行；请稍后查看状态或等待复核，不代表审核通过。',
  creator_review_provider_unavailable: '内容审核服务暂时不可用，作品尚未放行；请稍后重试或等待复核，不代表审核通过。',
  creator_paid_terms_required: '送审记录的收费条款尚未就绪，请在工作台查看并明确接受当前收费规则，不能沿用旧免费同意。',
  creator_version_not_ready: '这个版本目前不能再次送审，可能正在检查、待审核或已经通过。请查看实际版本状态与审核说明，不要重复提交。',
  creator_review_pending: '版本已进入待审核队列，请等待实际处理结果，不要重复送审。',
  creator_auto_review_pending: '自动审核尚在处理中，请保留当前版本并稍后刷新状态；尚不代表审核通过。',
  creator_auto_review_rejected: '自动审核未通过，请查看该版本记录中的具体原因，修正作品后重新上传或按工作台允许的流程送审。',
  creator_review_rejected: '该版本审核未通过，请查看记录中的拒绝原因，修正后再送审。',
  creator_work_suspended: '该作品已被管理员暂停，暂时不能修改或发布。',
  creator_version_changed: '作品版本已更新，请重新选择新版。',
  creator_work_not_found: '作品尚未公开或已下架。',
  creator_preview_unavailable: '真实预览暂时无法加载，请稍后再试。',
  creator_source_identity_invalid: '包内作品 ID 与当前投稿作品不一致，请按工作台要求重新封装。',
  creator_storage_not_private: '平台素材存储权限需要处理，文件没有公开或送审。',
  creator_pack_invalid: '投稿包格式不符合要求，请上传仅含 manifest.json 和声明 PNG 素材的 ZIP 形象包，不要包含脚本或可执行文件。',
  creator_manifest_invalid: 'manifest.json 的格式或字段不符合要求，请核对作品 ID、版本、画布、图层和动作字段。',
  creator_png_invalid: 'PNG 素材格式无效，请重新导出真实 PNG 文件，不要仅修改扩展名。',
  creator_zip_invalid: 'ZIP 形象包无法安全读取，请重新封装，避免损坏、加密、重复路径或多层目录。',
  creator_version_limit: '这个作品已达到版本数量上限，请先查看现有版本，不要继续重复上传。',
  creator_review_limit: '这个版本已达到送审次数上限，请查看审核记录和处理说明。',
  creator_source_integrity_failed: '素材完整性校验未通过，请保留作品记录并联系平台处理，不要把当前文件当作可交付版本。',
  market_selection_limit_exceeded: '每批必须选择 1 至 10 个不同形象，请调整选择后继续。',
  market_batch_too_large: '批次文件超过交付预算，请减少所选形象；数量和金额合规不代表文件大小一定合规。'
};

function safeField(value) {
  if (typeof value !== 'string' || value.length > 120 ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*(?:(?:\.[a-zA-Z0-9_]+)|(?:\[\d{1,3}\]))*$/u.test(value) ||
    /password|secret|token|recovery|credential|email|contact/iu.test(value)) return null;
  const root = value.split(/[.[]/u)[0];
  return ['manifest', 'schema_version', 'id', 'version', 'name_zh', 'name_en', 'titleZh', 'description',
    'creatorDouyinNumber', 'updateNote', 'tags', 'slug', 'author', 'publisher', 'review_id', 'canvas_width', 'canvas_height', 'preview',
    'plus_y', 'layers', 'image', 'frame', 'anchor', 'keyframes', 'interpolation', 't', 'x', 'y',
    'rotation', 'scale', 'scale_y', 'alpha', 'archive', 'files', 'png', 'zip', 'sharingTermsVersion',
    'acceptFreeDistribution'].includes(root) ? value : null;
}

export function friendlyError(error) {
  const code = error?.code ?? error?.message;
  let text = messages[code];
  if (!text && typeof code === 'string' && /^(?:creator_|pack_|market_)[a-z0-9_]+$/u.test(code)) {
    if (/budget|unpacked|decoded|dimension|too_large|compression_ratio|layer_limit|keyframe_limit/u.test(code)) {
      text = '形象包超过文件、解压、图片尺寸、解码内存或动作复杂度预算，请减少素材大小、图层或关键帧后重新封装。';
    } else if (/png|image/u.test(code)) {
      text = 'PNG 图片校验未通过，请核对真实格式、图片尺寸及 manifest 中引用的素材文件。';
    } else if (/zip|archive|path|symlink|duplicate_file|compression/u.test(code)) {
      text = 'ZIP 形象包结构不安全或无法读取，请移除加密、重复文件、目录穿越、链接及未声明文件后重新封装。';
    } else if (/manifest|schema|field|layer|keyframe|frame|anchor/u.test(code)) {
      text = '形象包字段或动作定义不符合要求，请核对 manifest.json 的类型、必填项、画布、图层和关键帧。';
    } else if (/source|pack/u.test(code)) {
      text = '投稿包格式或内容不符合要求，请核对作品身份、版本和 manifest.json / PNG / ZIP 封装规范。';
    }
  }
  text ??= '操作未完成。请检查文件与封装要求，或稍后重试。';
  const field = safeField(error?.field);
  return field ? `${text} 请检查字段：${field}。` : text;
}

export async function creatorRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', ...options,
      headers: { 'content-type': 'application/json', ...options.headers }
    });
  } catch {
    const error = new Error('creator_network_unavailable'); error.code = error.message; error.status = 0; throw error;
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error('creator_response_invalid'); error.code = error.message; error.status = response.status; throw error;
  }
  if (!response.ok) {
    const code = typeof data.error === 'string' && /^[a-z][a-z0-9_]{0,100}$/u.test(data.error) ? data.error : 'creator_service_unavailable';
    const error = new Error(code);
    error.code = code; error.status = response.status;
    const retryAfter = response.headers.get('retry-after');
    if (typeof retryAfter === 'string' && /^\d{1,5}$/u.test(retryAfter) && Number(retryAfter) > 0) {
      error.retryAfterSeconds = Number(retryAfter);
    }
    const field = safeField(data.field);
    if (field) error.field = field;
    throw error;
  }
  return data;
}

export function element(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export async function copyText(text, fallback) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    if (fallback) { fallback.hidden = false; fallback.value = text; fallback.focus(); fallback.select(); }
    throw new Error('copy_manually');
  }
}

export function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
