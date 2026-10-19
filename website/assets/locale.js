/* Shared, local-only website language layer. Never translates credentials or URLs. */
(() => {
  'use strict';
  const key = 'niuma-site-language';
  const params = new URLSearchParams(location.search);
  let stored = 'zh';
  try { stored = localStorage.getItem(key) || 'zh'; } catch { /* Storage is optional. */ }
  const explicit = params.get('lang');
  const language = ['en', 'zh'].includes(explicit) ? explicit : stored === 'en' ? 'en' : 'zh';
  if (explicit === 'en' || explicit === 'zh') {
    try { localStorage.setItem(key, language); } catch { /* URL still selects the language. */ }
  }
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  const dictionary = Object.assign({}, window.NiuMaEnglishPages,
    window.NiuMaEnglishFlow, window.NiuMaEnglishGallery);
  const hasChinese = value => /[\u3400-\u9fff]/u.test(value);
  function searchQuery(value) {
    if (language !== 'en') return value;
    const query = String(value).trim().toLowerCase();
    const aliases = [
      [/^(?:(?:pecking|little) )?chick(?:en)?$/, '小鸡'],
      [/^(?:jackpot|wealth button|rich button)$/, '暴富'],
      [/^(?:sweet )?kiss$/, '甜蜜亲亲'],
      [/^(?:pecking )?woodpecker$/, '啄木鸟'],
      [/^(?:lucky )?cat$/, '招财猫'],
      [/^(?:belly.patting )?sea lion$/, '海狮'],
      [/^(?:treasure (?:bowl|basin))$/, '聚宝盆'],
      [/^(?:order )?charm$/, '爆单符'],
      [/^(?:puffing )?frog$/, '青蛙'],
      [/^(?:hopping )?jiangshi$/, '小僵尸'],
      [/^(?:(?:golden|coin.spitting|coin) )?toad$/, '金蟾'],
      [/^(?:tilting )?shiba$/, '柴犬'],
      [/^(?:god of wealth|gold ingot)$/, '财神'],
      [/^hamster(?: wheel)?$/, '仓鼠'],
      [/^(?:clock out|off.work button)$/, '下班'],
    ];
    return aliases.find(([pattern]) => pattern.test(query))?.[1] ?? value;
  }
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const templates = Object.entries(dictionary).filter(([source]) => /\{\d+\}/.test(source))
    .sort((a, b) => b[0].replace(/\{\d+\}/g, '').length - a[0].replace(/\{\d+\}/g, '').length)
    .map(([source, target]) => {
      const slots = [];
      let expression = '', last = 0;
      for (const match of source.matchAll(/\{(\d+)\}/g)) {
        expression += escape(source.slice(last, match.index)) + '([\\s\\S]+?)';
        slots.push(match[1]); last = match.index + match[0].length;
      }
      return { pattern: new RegExp('^' + expression + escape(source.slice(last)) + '$', 'u'), target, slots };
    });
  const fragments = Object.entries(dictionary).filter(([source]) => hasChinese(source) &&
    source.length > 1 && !/\{\d+\}/.test(source)).sort((a, b) => b[0].length - a[0].length);
  function translate(value, depth = 0) {
    const original = String(value ?? '');
    if (language !== 'en') return original;
    const source = original.trim();
    const pad = translated => original.slice(0, original.indexOf(source)) + translated +
      original.slice(original.indexOf(source) + source.length);
    if (Object.prototype.hasOwnProperty.call(dictionary, source)) return pad(dictionary[source]);
    const normalized = source.replace(/\s+/g, ' ');
    if (Object.prototype.hasOwnProperty.call(dictionary, normalized)) return pad(dictionary[normalized]);
    if (!hasChinese(original)) return original;
    if (depth < 5) {
      for (const template of templates) {
        const match = source.match(template.pattern);
        if (!match) continue;
        const values = {};
        template.slots.forEach((slot, index) => { values[slot] = translate(match[index + 1], depth + 1); });
        return pad(template.target.replace(/\{(\d+)\}/g, (_, slot) => values[slot] ?? ''));
      }
    }
    let translated = original;
    for (const [phrase, english] of fragments) if (translated.includes(phrase)) translated = translated.split(phrase).join(english);
    return translated;
  }
  const textSources = new WeakMap(), attributeSources = new WeakMap();
  const missing = new Set();
  function publicText(source, element) {
    if (language === 'en' && element?.id === 'payment-total' && /^¥[\d.]+$/.test(source))
      return 'CNY ' + source.slice(1);
    // A saved file's name must stay literal so the user can find that same file.
    if (language === 'en' && element?.closest?.('.journey-filename, .onboarding-file-name')) {
      if (source.startsWith('本次文件：')) return 'Downloaded file: ' + source.slice('本次文件：'.length);
      if (source.startsWith('文件名：')) return 'Filename: ' + source.slice('文件名：'.length);
    }
    const translated = translate(source);
    if (language !== 'en' || !hasChinese(translated)) return translated;
    // Public catalogue text can arrive without English metadata. Do not invent a
    // translation or expose raw server errors as English product copy.
    const card = element?.closest?.('[data-appearance-number]');
    if (element?.closest?.('.library-description, #appearance-description'))
      return 'Preview the animation, then choose this character for your desktop.';
    if (element?.closest?.('.library-card h3, #appearance-title, .journey-confirm-item strong, #claim-items strong, #selection-chosen a, #delivery-items li')) {
      const number = card?.dataset.appearanceNumber || source.match(/#(\d{6,9})/)?.[1];
      return number ? `Character #${number}` : 'Desktop character';
    }
    if (element?.closest?.('.library-author, #appearance-author')) return 'Official character';
    missing.add(source);
    // Unknown service/user-generated copy is not treated as a translation. Keep
    // an English recovery message; the surrounding transaction state is intact.
    return 'This information is unavailable in English. Please contact support.';
  }
  function sourceText(element) {
    if (!element) return '';
    if (element.nodeType === Node.TEXT_NODE) {
      const saved = textSources.get(element);
      return saved && saved.rendered === element.nodeValue ? saved.source : element.nodeValue;
    }
    return [...element.childNodes].map(sourceText).join('');
  }
  function applyText(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, noscript, textarea, [data-locale-verbatim]')) return;
    const before = node.nodeValue;
    const previous = textSources.get(node);
    const source = previous && before === previous.rendered ? previous.source : before;
    const rendered = publicText(source, parent);
    textSources.set(node, { source, rendered });
    if (before !== rendered) node.nodeValue = rendered;
  }
  const attributes = ['aria-label', 'aria-description', 'aria-valuetext', 'alt', 'title', 'placeholder'];
  function applyElement(element) {
    if (!element || element.matches('script, style, [data-locale-verbatim]')) return;
    let saved = attributeSources.get(element);
    if (!saved) { saved = {}; attributeSources.set(element, saved); }
    for (const attribute of attributes) {
      if (!element.hasAttribute(attribute)) continue;
      const before = element.getAttribute(attribute);
      const prior = saved[attribute];
      const source = prior && before === prior.rendered ? prior.source : before;
      const rendered = publicText(source, element);
      saved[attribute] = { source, rendered };
      if (before !== rendered) element.setAttribute(attribute, rendered);
    }
    if (element.tagName === 'META' && /^(description|og:(title|description|site_name))$/.test(element.name || element.getAttribute('property') || '')) {
      const before = element.content, after = publicText(before, element);
      if (before !== after) element.content = after;
    }
    if (language === 'en' && element.matches('meta[property="og:locale"]')) element.content = 'en_US';
    if (element.matches('a[href]') && !element.hasAttribute('download')) {
      try {
        const url = new URL(element.href, location.href);
        if (url.origin === location.origin && /(?:\.html|\/)$/i.test(url.pathname) &&
            (url.searchParams.has('lang') || language === 'en')) {
          url.searchParams.set('lang', language);
          if (element.href !== url.href) element.href = url.href;
        }
      } catch { /* Leave non-navigation links untouched. */ }
    }
  }
  function applyTree(root) {
    if (root.nodeType === Node.TEXT_NODE) { applyText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) applyElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) applyText(node); else applyElement(node);
    }
  }
  function init() {
    const nav = document.querySelector('header nav, .nav nav, .guide-nav nav, header');
    if (nav && !document.querySelector('[data-site-language]')) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'site-language'; button.dataset.siteLanguage = 'true';
      button.dataset.localeVerbatim = 'true';
      button.textContent = language === 'en' ? 'Chinese' : 'English';
      button.setAttribute('aria-label', language === 'en' ? 'Switch to Chinese' : 'Switch to English');
      button.onclick = () => {
        const next = language === 'en' ? 'zh' : 'en';
        try { localStorage.setItem(key, next); } catch { /* URL is sufficient. */ }
        const url = new URL(location.href); url.searchParams.set('lang', next); location.assign(url.href);
      };
      nav.append(button);
    }
    if (language === 'en') {
      const pricing = document.querySelector('.characters .section-heading > p:last-child');
      const codeLink = pricing?.querySelector('a');
      if (codeLink) {
        const price = document.createElement('strong'); price.textContent = 'CNY 1 each';
        codeLink.textContent = 'use a fan-group code for free';
        pricing.replaceChildren(document.createTextNode('Woodfish is always free. Extra characters cost '),
          price, document.createTextNode(', or '), codeLink, document.createTextNode('.'));
      }
      // Native constraint validation otherwise uses the browser's own language.
      document.addEventListener('invalid', event => {
        const input = event.target;
        if (typeof input.setCustomValidity !== 'function') return;
        let message = 'Please check this field.';
        if (input.validity.valueMissing) message = 'Please fill out this field.';
        else if (input.validity.patternMismatch) message = input.closest('#claim-code-form')
          ? 'Use GD followed by six digits, for example GD123456.' : 'Please use the requested format.';
        else if (input.validity.typeMismatch) message = 'Please enter a valid ' + (input.type === 'email' ? 'email address.' : 'value.');
        else if (input.validity.tooLong) message = 'Please shorten this entry.';
        else if (input.validity.tooShort) message = 'Please enter the required number of characters.';
        else if (input.validity.rangeUnderflow || input.validity.rangeOverflow) message = 'Please enter a value within the allowed range.';
        input.setCustomValidity(message);
      }, true);
      document.addEventListener('input', event => {
        if (typeof event.target.setCustomValidity === 'function') event.target.setCustomValidity('');
      }, true);
    }
    applyTree(document);
  }
  window.NiuMaLocale = { language, translate, sourceText, searchQuery,
    get missingCount() { return missing.size; }, apply: applyTree };
  // Observe while the document is parsed, before deferred business modules run.
  // This also keeps later API-driven status messages in the selected language.
  const observer = new MutationObserver(records => {
    const roots = new Set();
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) roots.add(node);
      else roots.add(record.target);
    }
    for (const root of roots) if (root.isConnected) applyTree(root);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: attributes });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
