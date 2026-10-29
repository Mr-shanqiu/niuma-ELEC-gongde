import { library, developer } from './free-flow.js?v=renderer-20261021';
// The shared locale entry owns language across every public page.
const stage = document.querySelector('.counter-demo'), total = document.getElementById('demo-total');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let heroVisible = false, interval = 0;
// The hero paints its still first, then upgrades to the live player when the
// visitor interacts. Without this the first screen waits for the two full-size
// artwork files (about 550 KB) before showing anything at all.
const packPreview = stage.querySelector('[data-pack-preview]');
const stillReady = (async () => {
  const initial = packPreview.querySelector('img[data-hero-cover]');
  if (initial) { try { await initial.decode(); return true; } catch { /* Retry through the checked loader. */ } }
  if (!window.NiuMaAppearance?.cover) return false;
  try {
    const blob = await window.NiuMaAppearance.cover('woodfish');
    if (!blob) return false;
    const image = document.createElement('img');
    const url = URL.createObjectURL(blob);
    image.alt = '客户端木鱼原始动作'; image.decoding = 'async'; image.src = url;
    await image.decode();
    if (packPreview.appearancePlayer) { URL.revokeObjectURL(url); return true; }
    packPreview.replaceChildren(image);
    packPreview.dataset.previewState = 'cover';
    return true;
  } catch { return false; }
})();
let heroPlayer = null, heroLoading = null;
async function ensurePlayer() {
  if (heroPlayer) return heroPlayer;
  if (!window.NiuMaAppearance?.load) return null;
  if (!heroLoading) heroLoading = window.NiuMaAppearance.load(packPreview)
    .then(player => { heroPlayer = player; return player; })
    .catch(() => null).finally(() => { heroLoading = null; });
  return heroLoading;
}
function strike() {
  stage.classList.remove('striking'); void stage.offsetWidth; stage.classList.add('striking');
  total.textContent = String(Number(total.textContent) + 1);
  if (heroPlayer) heroPlayer.strike();
  else void ensurePlayer().then(player => player?.strike());
}
function updateDemo() {
  clearInterval(interval); interval = 0;
  if (heroVisible && !document.hidden && !reducedMotion.matches) interval = setInterval(strike, 4200);
  else { stage.classList.remove('striking'); heroPlayer?.stop?.(); }
}
document.querySelector('.strike-button').addEventListener('click', strike);
stage.addEventListener('click', strike);
stage.addEventListener('keydown', event => { if (event.target === stage && ['Enter', ' '].includes(event.key)) { event.preventDefault(); strike(); } });
// A still that never loads still leaves something honest on screen; the live
// player is only fetched on the first interaction.
void stillReady.then(ready => {
  if (!ready && !packPreview.childElementCount) packPreview.textContent = '演示暂时无法加载，请刷新。';
});
const heroObserver = new IntersectionObserver(entries => { heroVisible = entries[0]?.isIntersecting === true; updateDemo(); });
heroObserver.observe(stage);
document.addEventListener('visibilitychange', updateDemo); reducedMotion.addEventListener('change', updateDemo);
addEventListener('pagehide', event => { clearInterval(interval); interval = 0; if (!event.persisted) heroObserver.disconnect(); });
addEventListener('pageshow', updateDemo);
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); }
}, { threshold: .12 });
document.querySelectorAll('.reveal').forEach(node => observer.observe(node));
developer(); void library();
