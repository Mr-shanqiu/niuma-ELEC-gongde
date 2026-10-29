(() => {
  const install = document.querySelector('[data-copy-skill]');
  if (install) install.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(document.querySelector('[data-skill-command]').value); install.textContent = '已复制安装命令'; }
    catch { const text = document.querySelector('[data-skill-command]'); text.focus(); text.select(); install.textContent = '请手动复制安装命令'; }
  });
  const button = document.querySelector('[data-copy-group-confirmation]');
  if (!button) return;
  button.addEventListener('click', async () => {
    const text = document.querySelector('[data-group-confirmation-text]');
    text.hidden = false;
    try { await navigator.clipboard.writeText(text.value); button.textContent = '已复制，和作品一起发给群管理员'; }
    catch { text.focus(); text.select(); button.textContent = '请手动复制下方文字'; }
  });
})();
