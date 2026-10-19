import { readSelection } from '../free-api.js?v=locale-20261017';

const paidLink = document.getElementById('selection-claim');
const groupLink = document.getElementById('v4-group-claim');
const count = document.getElementById('selection-count');
const tr = text => window.NiuMaLocale?.translate(text) ?? text;
if (paidLink && groupLink && count) {
  const update = () => {
    const items = readSelection();
    const text = tr(items.length ? `付费下载 ¥${items.length}` : '付费下载');
    if (paidLink.textContent !== text) paidLink.textContent = text;
    groupLink.setAttribute('aria-disabled', String(!items.length));
    groupLink.tabIndex = items.length ? 0 : -1;
  };
  groupLink.addEventListener('click', event => { if (!readSelection().length) event.preventDefault(); });
  new MutationObserver(update).observe(count, { childList: true, characterData: true, subtree: true });
  update();
}

const route = document.getElementById('claim-route');
if (route) {
  const label = route.closest('label');
  const tabs = document.createElement('div');
  tabs.className = 'v4-route-tabs';
  tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '下载方式');
  for (const [value, text] of [['payment', '付费下载 · ¥1 / 个'], ['group', '群码免费领取']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text; button.dataset.route = value;
    button.setAttribute('aria-controls', value === 'group' ? 'group-panel' : 'payment-panel');
    button.addEventListener('click', () => {
      route.value = value; route.dispatchEvent(new Event('change', { bubbles: true })); sync();
    });
    tabs.append(button);
  }
  function sync() {
    for (const button of tabs.children) {
      const active = button.dataset.route === route.value;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    }
  }
  if (label) { label.before(tabs); label.hidden = true; }
  else route.before(tabs);
  route.addEventListener('change', sync);
  // Original claim initialization owns the route value and asynchronous states.
  requestAnimationFrame(sync);
  const group = document.getElementById('group-panel');
  if (group) new MutationObserver(sync).observe(group, { attributes: true, attributeFilter: ['hidden'] });
}

// Native links keep history, anchors and direct page access working without SPA
// routing. Respect existing installer handlers and never auto-start a download.
const heroDownload = document.querySelector('.hero-v4 .hero-actions .primary');
const otherSystem = document.querySelector('.v4-other-system');
if (heroDownload && otherSystem) {
  const windows = /Windows/i.test(navigator.userAgent), mac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  if (windows || mac) {
    heroDownload.textContent = `免费下载 ${windows ? 'Windows' : 'Mac'} 版 ↓`;
    otherSystem.textContent = `${windows ? 'Mac' : 'Windows'} 版 ↗`;
  }
}
