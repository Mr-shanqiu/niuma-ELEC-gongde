import { readSelection, writeSelection } from '../free-api.js?v=locale-20261017';
import { currentPayment } from '../payment-flow.js?v=locale-20261017';
const $ = id => document.getElementById(id);
const tr = text => window.NiuMaLocale?.translate(text) ?? text;
const sourceText = element => window.NiuMaLocale?.sourceText(element) ?? element?.textContent ?? '';
const el = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
function hasPayment() { try { return Boolean(currentPayment()); } catch { return true; } }
function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); });
}
const paidLink = $('selection-claim');
if (paidLink) {
  const dialog = el('dialog', undefined, 'journey-dialog');
  dialog.setAttribute('aria-labelledby', 'journey-confirm-title');
  const inner = el('div', undefined, 'journey-dialog-inner');
  const header = el('div', undefined, 'journey-dialog-heading');
  const heading = el('h2', '确认你的选择'); heading.id = 'journey-confirm-title';
  const close = el('button', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭确认窗口'); close.onclick = () => dialog.close();
  header.append(heading, close);
  const list = el('div'), total = el('p', '', 'journey-confirm-total');
  const note = el('p', '本次购买用于下载所选形象，已保存的文件可永久使用。', 'journey-muted');
  const proceed = el('button', '', 'primary'); proceed.type = 'button';
  const back = el('button', '继续挑选', 'journey-link'); back.type = 'button'; back.onclick = () => dialog.close();
  const actions = el('div', undefined, 'journey-confirm-actions'); actions.append(proceed, back);
  inner.append(header, list, total, note, actions); dialog.append(inner); document.body.append(dialog); closeOnBackdrop(dialog);
  function draw() {
    const selected = readSelection(); list.replaceChildren();
    for (const item of selected) {
      const row = el('div', undefined, 'journey-confirm-item');
      const thumb = el('span', String(item.title || '形象').slice(0, 1), 'journey-thumbnail'); thumb.setAttribute('aria-hidden', 'true');
      const card = [...document.querySelectorAll('[data-appearance-number]')].find(value => value.dataset.appearanceNumber === String(item.number));
      const canvas = card?.querySelector('canvas'), source = card?.querySelector('.library-preview img');
      try {
        const src = canvas ? canvas.toDataURL() : source?.src;
        if (src) { const image = el('img'); image.src = src; image.alt = ''; thumb.replaceChildren(image); }
      } catch { /* Keep the title initial when a cover cannot be reused. */ }
      const remove = el('button', '移除', 'journey-link'); remove.type = 'button'; remove.setAttribute('aria-label', '移除' + item.title);
      remove.disabled = hasPayment();
      remove.onclick = () => { if (hasPayment()) return; writeSelection(readSelection().filter(value => String(value.number) !== String(item.number))); document.dispatchEvent(new CustomEvent('niuma-selection-change')); draw(); };
      row.append(thumb, el('strong', item.title), el('span', '¥1', 'journey-muted'), remove); list.append(row);
    }
    total.textContent = `共 ${selected.length} 个形象，合计 ¥${selected.length}`;
    proceed.textContent = `确认，去付款 ¥${selected.length}`; proceed.disabled = !selected.length;
    if (!selected.length) list.append(el('p', '还没有选择形象，返回图库挑选吧。'));
  }
  paidLink.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || hasPayment()) return;
    event.preventDefault(); if (!readSelection().length) return; draw(); dialog.showModal();
  });
  proceed.onclick = () => { if (readSelection().length) location.assign(paidLink.href); };
}
const route = $('claim-route');
if (route && document.body.dataset.journey === 'checkout') {
  let downloadStarted = false;
  const dialog = $('journey-selection'); closeOnBackdrop(dialog);
  $('journey-view-selection').onclick = () => dialog.showModal();
  dialog.querySelector('[data-close-selection]').onclick = () => dialog.close();
  const sync = () => {
    const isGroup = route.value === 'group';
    const title = document.body.dataset.journeyCompleted === 'true' ? '小伙伴已到手'
      : isGroup ? '输入群码，免费领回家'
      : downloadStarted ? '下一步，找到刚下载的文件' : '支付本次形象下载';
    if ($('journey-heading').textContent !== tr(title)) $('journey-heading').textContent = tr(title);
    const text = tr(`共 ${readSelection().length} 个形象`);
    if ($('journey-count').textContent !== text) $('journey-count').textContent = text;
    const change = isGroup ? '不进群，直接付费' : '改用群码免费领取';
    if ($('journey-switch-route').textContent !== tr(change)) $('journey-switch-route').textContent = tr(change);
    // The existing action remains the authority. Only conceal its initial,
    // unavailable duplicate while the verification form is the primary action.
    const claim = $('claim-create');
    const claimText = sourceText(claim);
    claim.hidden = claim.disabled && !claimText.startsWith('正在') && !claimText.startsWith('继续');
  };
  $('journey-switch-route').onclick = () => { route.value = route.value === 'group' ? 'payment' : 'group'; route.dispatchEvent(new Event('change', { bubbles: true })); sync(); };
  route.addEventListener('change', sync);
  const observer = new MutationObserver(sync);
  observer.observe($('selection-count'), { childList: true, characterData: true, subtree: true });
  observer.observe($('group-panel'), { attributes: true, attributeFilter: ['hidden'] });
  observer.observe($('claim-create'), { childList: true, attributes: true, attributeFilter: ['disabled'] });
  sync();
  document.addEventListener('niuma-download-started', () => { downloadStarted = true; sync(); });
  document.addEventListener('niuma-download-completed', () => {
    document.body.dataset.journeyCompleted = 'true'; $('journey-completed').hidden = false;
    $('journey-heading').textContent = '小伙伴已到手';
    $('journey-completed').scrollIntoView({ block: 'center', behavior: 'auto' });
  });
}
