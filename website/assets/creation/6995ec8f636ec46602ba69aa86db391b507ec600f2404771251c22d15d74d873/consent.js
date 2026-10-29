(() => {
  const form = document.querySelector('[data-submission-confirm]');
  if (!form) return;
  const file = form.querySelector('input[type=file]');
  const consent = form.querySelector('input[type=checkbox]');
  const button = form.querySelector('[data-confirm-copy]');
  const output = form.querySelector('textarea');
  const status = form.querySelector('[role=status]');
  let generation = 0;
  function reset() {
    generation++;
    output.value = ''; output.hidden = true;
    button.disabled = !consent.checked || !file.files.length;
    status.textContent = '文件仅在本机计算摘要，不会上传。确认文字需由你发送给群管理员。';
  }
  file.addEventListener('change', reset); consent.addEventListener('change', reset);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const selected = file.files[0];
    if (!consent.checked || !selected) return;
    const current = ++generation; button.disabled = true;
    if (!selected.name.toLowerCase().endsWith('.nmgpack') || selected.size > 8 * 1024 * 1024 || selected.size === 0) {
      status.textContent = '请选择非空的 .nmgpack 作品包（不超过 8 MiB）。';
      button.disabled = false; return;
    }
    status.textContent = '正在本机生成确认文字…';
    try {
      const digest = await crypto.subtle.digest('SHA-256', await selected.arrayBuffer());
      if (current !== generation || !consent.checked) return;
      const sha = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
      const text = `本人有权提交本次作品：${selected.name}\n文件 SHA-256：${sha}\n本人已阅读并同意《牛马电子功德免费投稿与使用授权协议》2026-10-29-1（https://gongde.zqscreen.cn/support.html#submission-terms），确认非独占无偿授权、投稿及必要适配版免费、无默认收费二创授权、权利承诺及双方依法承担各自责任。公开署名与素材来源、许可说明随本次投稿提供。\n请以本消息所附的同一份文件为准；本确认不自动适用于其他作品或后续版本。`;
      output.value = text; output.hidden = false;
      try {
        await navigator.clipboard.writeText(text);
        if (current === generation) status.textContent = '已复制。请将确认文字、同一作品文件、预览和素材来源说明一起发给群管理员；网页尚未提交投稿。';
      } catch {
        if (current === generation) { output.focus(); output.select(); status.textContent = '确认文字已生成，浏览器未允许自动复制。请手动复制下方文字并与作品一起发送；网页尚未提交投稿。'; }
      }
    } catch {
      if (current === generation) status.textContent = '未能生成文件摘要，请重新选择文件后重试。';
    } finally { if (current === generation) button.disabled = !consent.checked || !file.files.length; }
  });
  document.querySelector('[data-copy-skill]').addEventListener('click', async event => {
    const target = event.currentTarget;
    const text = 'npx skills add Mr-shanqiu/gongde-appearance-pack --skill gongde-appearance-pack';
    try { await navigator.clipboard.writeText(text); target.textContent = '已复制安装命令'; }
    catch { document.querySelector('[data-skill-command]').focus(); document.querySelector('[data-skill-command]').select(); target.textContent = '请手动复制安装命令'; }
  });
})();
