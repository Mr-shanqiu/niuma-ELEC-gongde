// Homepage feature carousel. Presentation only: it never touches the library,
// the download route or any business module.
(() => {
  'use strict';
  const stage = document.querySelector('[data-feature-stage]');
  if (!stage) return;

  const panels = [...stage.querySelectorAll('[data-feature-panel]')];
  const tabs = [...stage.querySelectorAll('[data-feature-tab]')];
  const pauseButton = stage.querySelector('[data-feature-pause]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const order = panels.map(panel => panel.dataset.featurePanel);
  let index = 0;
  let timer = 0;
  // Any deliberate interaction stops the carousel until the user resumes it.
  let paused = reduced.matches;
  // Hover or focus pauses temporarily; a deliberate pause outlives them.
  let manualPause = reduced.matches;
  let visible = false;

  function show(next, { focusTab = false } = {}) {
    index = (next + panels.length) % panels.length;
    const key = order[index];
    // Stack the deck: the active panel in front, the next two receding behind
    // it, so the depth itself shows there are more pages than the one on top.
    const behind1 = order[(index + 1) % order.length];
    const behind2 = order[(index + 2) % order.length];
    panels.forEach(panel => {
      const panelKey = panel.dataset.featurePanel;
      panel.classList.toggle('is-active', panelKey === key);
      panel.classList.toggle('is-behind-1', panelKey === behind1);
      panel.classList.toggle('is-behind-2', panelKey === behind2);
    });
    tabs.forEach(tab => {
      const active = tab.dataset.featureTab === key;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focusTab) tab.focus();
    });
    loadDeckImages();
    stopDemo();
    if (key === 'count') startDemo();
  }

  // Panels sit stacked in one grid cell, so even a `loading="lazy"` image
  // inside them is geometrically in the viewport from the first paint — lazy
  // loading never deferred anything. Giving the hidden cards their real
  // address only once they join the deck keeps the first screen to the hero
  // art, without changing what a visitor sees when a card turns up: by the
  // time it reaches the back layer its picture is already on its way.
  const deckImages = [...stage.querySelectorAll('img[data-src]')];
  function loadDeckImages() {
    for (const image of deckImages) {
      const panel = image.closest('[data-feature-panel]');
      if (!panel || panel.classList.contains('is-active') ||
        panel.classList.contains('is-behind-1') || panel.classList.contains('is-behind-2')) {
        if (image.dataset.src) { image.src = image.dataset.src; image.removeAttribute('data-src'); }
      }
    }
  }

  function stopDemo() {
    document.querySelectorAll('[data-feature-panel] [data-pack-preview]').forEach(preview => {
      preview.closest('.counter-demo')?.classList.remove('striking');
      preview.appearancePlayer?.stop?.();
    });
  }

  function startDemo() {
    const preview = stage.querySelector('[data-feature-panel="count"] [data-pack-preview]');
    if (!preview || !preview.appearancePlayer) return;
    if (visible && !document.hidden && !reduced.matches) preview.appearancePlayer.play?.();
  }

  function tick() {
    if (paused || !visible || document.hidden) return;
    show(index + 1);
  }

  function schedule() {
    clearInterval(timer);
    timer = 0;
    if (paused || !visible || document.hidden || reduced.matches) return;
    timer = setInterval(tick, 7000);
  }

  function setPaused(next) {
    paused = next;
    if (pauseButton) {
      pauseButton.textContent = paused ? '继续' : '暂停';
      pauseButton.setAttribute('aria-pressed', String(paused));
    }
    schedule();
  }

  function userActed() {
    manualPause = true;
    setPaused(true);
    schedule();
  }

  tabs.forEach((tab, position) => {
    tab.addEventListener('click', () => {
      show(position);
      userActed();
    });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      show(index + step, { focusTab: true });
      userActed();
    });
  });

  // Clicking a receding card brings that card forward. The deck already shows
  // which page is which, so clicking it should work the same as its tab.
  panels.forEach((panel, position) => {
    panel.addEventListener('click', event => {
      if (position === index) return;
      // Controls inside a card keep their own job; only the card surface flips.
      if (event.target.closest('button, a, input, select, textarea, summary, label')) return;
      show(position);
      userActed();
    });
  });

  stage.querySelector('[data-feature-prev]')?.addEventListener('click', () => { show(index - 1); userActed(); });
  stage.querySelector('[data-feature-next]')?.addEventListener('click', () => { show(index + 1); userActed(); });
  pauseButton?.addEventListener('click', () => {
    manualPause = true;
    setPaused(!paused);
  });

  // The demo page's own interactions also pause the carousel.
  stage.querySelectorAll('[data-feature-panel="count"] .counter-demo, [data-feature-panel="count"] .strike-button')
    .forEach(node => node.addEventListener('pointerdown', userActed, { passive: true }));

  // Mouse or keyboard focus inside the stage pauses while it stays there.
  // Mouse hover waits a beat first: pausing the instant the pointer enters the
  // hero meant the carousel almost never ran for anyone.
  let hoverTimer = 0;
  stage.addEventListener('pointerenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => setPaused(true), 2500);
  });
  stage.addEventListener('pointerleave', () => {
    clearTimeout(hoverTimer);
    if (!manualPause) setPaused(false);
  });
  stage.addEventListener('focusin', () => setPaused(true));

  const observer = new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting === true;
    schedule();
  }, { threshold: 0.25 });
  observer.observe(stage);

  document.addEventListener('visibilitychange', schedule);
  reduced.addEventListener('change', () => { manualPause = reduced.matches; setPaused(reduced.matches); });
  addEventListener('pagehide', () => { clearInterval(timer); timer = 0; });

  // A local demonstration: explicit buttons only, no global input collection or persistence.
  const visibilityPanel = stage.querySelector('[data-feature-panel="visibility"]');
  const visibilityToggle = visibilityPanel?.querySelector('[data-visibility-toggle]');
  visibilityToggle?.addEventListener('click', () => {
    const hidden = visibilityToggle.getAttribute('aria-pressed') !== 'true';
    visibilityToggle.setAttribute('aria-pressed', String(hidden));
    visibilityToggle.textContent = hidden ? '恢复显示' : '隐藏形象';
    const art = visibilityPanel.querySelector('[data-visibility-art]');
    art.classList.toggle('is-concealed', hidden);
    art.setAttribute('aria-hidden', String(hidden));
    visibilityPanel.querySelector('[data-visibility-status]').textContent = hidden
      ? '已隐藏形象，试试计数 +1（展示示意）' : '展示示意，不读取键盘输入';
    userActed();
  });
  visibilityPanel?.querySelector('[data-visibility-increment]')?.addEventListener('click', () => {
    const count = visibilityPanel.querySelector('[data-visibility-count]');
    count.textContent = String(Number(count.textContent) + 1);
    userActed();
  });

  // The fourth card is a locked teaser until the visitor earns it. Until then
  // the card still exists in the deck, so the carousel keeps its four-page
  // shape: hiding it would have made the deck look like it lost a feature.
  const easterPanel = stage.querySelector('[data-feature-panel="bubble"]');
  const veil = easterPanel?.querySelector('[data-easter-veil]');
  const content = easterPanel?.querySelector('[data-easter-content]');
  const easterHeading = easterPanel?.querySelector('[data-easter-heading]');
  const easterDesc = easterPanel?.querySelector('[data-easter-desc]');
  const EASTER_KEY = 'niuma-bubble-easter-v1';
  const EASTER_GOAL = 60;
  let revealed = false;

  const bubbleLines = [
    '差不多得了，老板买车又不写你名字。',
    '你负责一骑绝尘，工资负责原地等你。',
    '工资是包月，不是把你整个人买断。',
    '别拿一份工资，体验全公司的人生。',
  ];
  let bubbleIndex = 0;
  const bubbleButton = easterPanel?.querySelector('[data-bubble-next]');
  const bubbleLine = easterPanel?.querySelector('[data-bubble-line]');
  bubbleButton?.addEventListener('click', () => {
    bubbleIndex = (bubbleIndex + 1) % bubbleLines.length;
    // The screenshot is the client's real bubble; the line under it is what the
    // button advances, so the control does something visible.
    if (bubbleLine) bubbleLine.textContent = bubbleLines[bubbleIndex];
    userActed();
  });

  function unlock() {
    revealed = true;
    easterPanel?.classList.add('is-revealed');
    if (veil) veil.hidden = true;
    if (content) content.hidden = false;
    if (easterHeading) easterHeading.textContent = '忙成这样，工资一定很高吧。';
    if (bubbleLine) bubbleLine.textContent = bubbleLines[0];
    if (easterDesc) easterDesc.textContent = '持续忙碌或操作密集时，它偶尔冒一句损友式关心。平日会嘴欠，节日也有专属台词，同一句七天内不重复。';
  }
  // A visitor who already earned it in this session sees the real card on load.
  let activity = 0;
  try { activity = Number(sessionStorage.getItem(EASTER_KEY)) || 0; } catch { /* Storage off. */ }
  if (activity >= EASTER_GOAL) unlock();

  // Sustained activity is the trigger: typing, scrolling and clicking are the
  // same signals the desktop app counts, so the reward matches the product's
  // own idea of a hard day. Progress lives in sessionStorage so a reload during
  // one long session keeps the accumulated effort.
  let lastKey = 0;
  let scrollTicks = 0;
  const bump = amount => {
    if (revealed) return;
    activity = Math.min(EASTER_GOAL, activity + amount);
    try { sessionStorage.setItem(EASTER_KEY, String(activity)); } catch { /* Storage off. */ }
    if (activity >= EASTER_GOAL) { unlock(); stopWatching(); }
  };
  const onKey = event => {
    // Held-key repeat and modifier-only presses are not effort.
    if (event.repeat || ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    const now = Date.now();
    if (now - lastKey < 40) return;
    lastKey = now;
    bump(1);
  };
  const onScroll = () => {
    // Wheel and trackpad fire in bursts; count a burst, not every event.
    scrollTicks += 1;
    if (scrollTicks % 12 === 0) bump(1);
  };
  const onClick = event => {
    // Form controls and links are the visitor doing something specific, not the
    // "still working" signal this rewards.
    if (event.target.closest('input, textarea, select, a, button, summary')) return;
    bump(1);
  };
  addEventListener('keydown', onKey, { passive: true });
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('click', onClick, { passive: true });
  function stopWatching() {
    removeEventListener('keydown', onKey);
    removeEventListener('scroll', onScroll);
    removeEventListener('click', onClick);
  }
  addEventListener('pagehide', stopWatching);

  if (pauseButton) {
    pauseButton.textContent = paused ? '继续' : '暂停';
    pauseButton.setAttribute('aria-pressed', String(paused));
  }
  show(0);
  schedule();
})();
