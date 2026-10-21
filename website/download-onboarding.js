// This is a usage guide, not an installation detector or a payment state machine.
//
// It used to rename the download buttons here too, through a path-to-filename
// table. That table's keys never matched the published installer URLs, so the
// branch never ran; and because a cross-origin download attribute cannot set a
// filename anyway, the real name comes from the download host's
// Content-Disposition. Removing it changes nothing users see, and avoids
// pointing at a non-existent route if an older release ever returns to the
// current list.

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

addAppearanceInstructions();
