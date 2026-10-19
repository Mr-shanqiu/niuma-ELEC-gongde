// Local illustrations only: no installation detection, download or permission request.
const english = document.documentElement.lang === 'en';
const main = document.querySelector('.install-guide');
if (main && english) {
  for (const node of main.querySelectorAll('[data-guide-en]')) node.textContent = node.dataset.guideEn;
  for (const node of main.querySelectorAll('[data-guide-en-label]')) node.setAttribute('aria-label', node.dataset.guideEnLabel);
  const heading = main.querySelector('h1');
  if (heading) document.title = `${heading.textContent} | NiuMa Merit`;
}
const viewers = [...document.querySelectorAll('[data-step-viewer]')].map(host => {
  const position = new Map();
  const previous = host.querySelector('[data-step-prev]');
  const next = host.querySelector('[data-step-next]');
  const progress = host.querySelector('.step-progress');
  // Each viewer owns only its direct series; there are no nested slide controls.
  const groups = [...host.querySelectorAll('[data-series]')];
  function render(series = groups.find(group => !group.hidden)?.dataset.series) {
    const group = groups.find(item => item.dataset.series === series) || groups[0];
    groups.forEach(item => { item.hidden = item !== group; });
    const slides = [...group.querySelectorAll('[data-step]')];
    const index = Math.max(0, Math.min(position.get(series) || 0, slides.length - 1));
    position.set(series, index);
    slides.forEach((slide, i) => { slide.hidden = i !== index; });
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    progress.textContent = english ? `Step ${index + 1} of ${slides.length}` : `第 ${index + 1} 步 / 共 ${slides.length} 步`;
    host.dataset.activeSeries = group.dataset.series;
    host.dataset.activeStep = String(index + 1);
    requestAnimationFrame(resize);
  }
  function move(delta) {
    const series = host.dataset.activeSeries;
    const slides = groups.find(item => item.dataset.series === series).querySelectorAll('[data-step]');
    position.set(series, Math.max(0, Math.min((position.get(series) || 0) + delta, slides.length - 1)));
    render(series);
  }
  function resize() {
    for (const visual of host.querySelectorAll('.guide-visual')) {
      if (!visual.clientWidth) continue;
      const artwork = visual.querySelector('.system-scene > :first-child');
      const scale = Math.min((visual.clientWidth - 32) / artwork.offsetWidth, (visual.clientHeight - 24) / artwork.offsetHeight);
      visual.style.setProperty('--scene-scale', Math.min(scale, 1.07));
    }
  }
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  // Arrow keys operate only after focus enters this guide, never globally.
  host.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
  });
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(host);
  else window.addEventListener('resize', resize);
  render();
  return { host, render };
});
const platformButtons = [...document.querySelectorAll('[data-platform]')];
function choosePlatform(platform) {
  platformButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.platform === platform)));
  viewers.find(viewer => viewer.host.querySelector(`[data-series="${platform}"]`))?.render(platform);
}
platformButtons.forEach(button => button.addEventListener('click', () => choosePlatform(button.dataset.platform)));
if (platformButtons.length) {
  const requested = new URLSearchParams(location.search).get('os');
  choosePlatform(['mac', 'windows'].includes(requested) ? requested : /Windows/i.test(navigator.userAgent) ? 'windows' : 'mac');
}
