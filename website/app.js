import { library, developer } from './free-flow.js?v=locale-20261017';
// The shared locale entry owns language across every public page.
const stage = document.querySelector('.counter-demo'), total = document.getElementById('demo-total');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let heroVisible = false, interval = 0;
function strike() {
  stage.classList.remove('striking'); void stage.offsetWidth; stage.classList.add('striking');
  stage.querySelector('[data-pack-preview]')?.appearancePlayer?.strike();
  total.textContent = String(Number(total.textContent) + 1);
}
function updateDemo() {
  clearInterval(interval); interval = 0;
  if (heroVisible && !document.hidden && !reducedMotion.matches) interval = setInterval(strike, 4200);
  else { stage.classList.remove('striking'); stage.querySelector('[data-pack-preview]')?.appearancePlayer?.stop?.(); }
}
document.querySelector('.strike-button').addEventListener('click', strike);
stage.addEventListener('click', strike);
stage.addEventListener('keydown', event => { if (event.target === stage && ['Enter', ' '].includes(event.key)) { event.preventDefault(); strike(); } });
window.NiuMaAppearance.load(stage.querySelector('[data-pack-preview]')).catch(() => { stage.querySelector('[data-pack-preview]').textContent = '演示暂时无法加载，请刷新。'; });
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
