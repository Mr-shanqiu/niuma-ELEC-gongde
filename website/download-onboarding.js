// This is a usage guide, not an installation detector or a payment state machine.
const clients = {
  '/niuma-merit-macos-0.9.4.dmg': {
    platform: 'Mac', path: 'https://download.gongde.zqscreen.cn/niuma-merit-macos-0.9.4.dmg',
    filename: '01-牛马电子功德-Mac安装包-0.9.4.dmg'
  },
  '/niuma-merit-windows-0.9.4-setup.exe': {
    platform: 'Windows', path: 'https://download.gongde.zqscreen.cn/niuma-merit-windows-0.9.4-setup.exe',
    filename: '01-牛马电子功德-Windows安装包-0.9.4.exe'
  },
  '/niuma-merit-macos-0.9.3.dmg': {
    platform: 'Mac', path: './client-download/macos.dmg',
    filename: '01-牛马电子功德-Mac安装包-0.9.3.dmg'
  },
  '/niuma-merit-windows-0.9.3-setup.exe': {
    platform: 'Windows', path: './client-download/windows.exe',
    filename: '01-牛马电子功德-Windows安装包-0.9.3.exe'
  }
};

function nameCurrentInstallerLinks() {
  const list = document.getElementById('installer-list');
  if (!list) return;
  const enhance = () => {
    for (const link of list.querySelectorAll('a[href]')) {
      if (link.dataset.onboardingNamed === 'true') continue;
      let url;
      try { url = new URL(link.href); } catch { continue; }
      if (url.origin !== 'https://download.gongde.zqscreen.cn') continue;
      const client = clients[url.pathname];
      if (!client) continue;
      link.dataset.onboardingNamed = 'true';
      // Fixed same-origin routes preserve the normal attachment fallback.
      // Keep checksum metadata on links; transfer files only on an explicit click.
      if (location.protocol === 'https:' || location.protocol === 'http:') {
        const target = new URL(client.path, document.baseURI);
        if (/^[a-f0-9]{64}$/i.test(link.dataset.installerSha256 || '')) target.searchParams.set('sha256', link.dataset.installerSha256);
        link.href = target.href;
      }
      link.download = client.filename;
      link.title = `01 · 下载 ${client.platform} 安装包`;
      link.textContent = `01 · 下载 ${client.platform} 安装包`;
      const note = document.createElement('span');
      note.className = 'onboarding-file-name';
      note.textContent = `文件名：${client.filename}`;
      link.after(note);
    }
  };
  enhance();
  new MutationObserver(enhance).observe(list, { childList: true, subtree: true });
}

function addAppearanceInstructions() {
  if (document.body.dataset.downloadGuide !== 'appearance') return;
  const host = document.getElementById('payment-panel') || document.querySelector('main .flow-panel');
  if (!host) return;
  const guide = document.createElement('section');
  guide.className = 'journey-download-hint'; guide.hidden = true;
  guide.setAttribute('aria-label', '找到下载文件并导入');
  guide.innerHTML = '<h2>去哪里找刚下载的文件？</h2><p class="journey-filename"></p><ol><li><strong>查看浏览器右上角的下载记录</strong><p>确认下载已完成。通常保存在电脑的“下载”文件夹；如果你选择了其他位置，以浏览器记录为准。</p></li><li><strong>双击形象包，导入客户端</strong><p>已安装牛马电子功德？直接打开形象包，无需解压，再到“更换形象”中选中它。</p></li></ol><div class="journey-finish-actions"></div><p class="journey-finish-note">确认文件已保存后再点击“完成”，完成后将关闭本次下载入口。</p><details><summary>找不到文件，或者下载失败？</summary><p>点击浏览器下载图标，查看进度或拦截提示。找到对应记录，选择“在文件夹中显示”；Mac 通常是“在 Finder 中显示”。失败时请重试本批下载，不要重新付款。</p></details><details><summary>还没安装客户端？</summary><p>先安装免费的客户端，再打开形象包。已有客户端的用户无需重复安装。</p><p><a href="download.html" target="_blank" rel="noopener noreferrer">下载客户端（新标签页）</a> · <a href="install.html#appearance-import" target="_blank" rel="noopener noreferrer">查看安装与导入图解</a></p></details>';
  host.append(guide);
  document.addEventListener('niuma-download-started', event => {
    const filename = event.detail?.filename;
    guide.querySelector('.journey-filename').textContent = typeof filename === 'string' ? '本次文件：' + filename : '请在下载记录中查找刚下载的形象包。';
    const finish = document.getElementById('payment-complete') || document.getElementById('delivery-complete');
    if (finish) guide.querySelector('.journey-finish-actions').append(finish);
    guide.hidden = false;
    guide.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  });
  document.addEventListener('niuma-download-completed', () => { guide.hidden = true; });
}

nameCurrentInstallerLinks();
addAppearanceInstructions();
