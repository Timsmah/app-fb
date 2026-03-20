// content.js — Facebook Property Extractor v1.1
(function () {
  'use strict';

  const PHONE_REGEX = /(\+66[\s.\-]?[6-9](?:[\s.\-]?\d){8}|0[6-9]\d(?:[\s.\-]?\d){7})/g;
  const BTN_ID         = 'fbext-btn';
  const OVERLAY_ID     = 'fbext-overlay';
  const POST_BTN_CLASS = 'fbext-post-btn';
  const POST_MARKED    = 'fbext-marked';

  // ===================== PAGE TYPE =====================

  function getPageType() {
    const url = window.location.href;
    if (url.includes('/marketplace/item/')) return 'marketplace';
    if (/\/groups\/[^/]+\/(posts|permalink)\//.test(url)) return 'group-post';
    if (url.includes('/groups/')) return 'group-feed';
    return null;
  }

  // ===================== TEXT UTILS =====================

  function removePhones(text) {
    return text
      // Replace phone numbers
      .replace(PHONE_REGEX, '[tel supprimé]')
      // Remove lines that contain ONLY [tel supprimé] (with optional labels/punctuation around)
      .replace(/^[^\n]*\[tel supprimé\][^\n]*$/gm, m => {
        // If the line has meaningful content besides the tag, keep the label, drop the tag
        const withoutTag = m.replace(/\[tel supprimé\]/g, '').replace(/[:\/\-\s•]+$/, '').trim();
        return withoutTag.length > 3 ? withoutTag : '';
      })
      // Collapse 3+ consecutive newlines into 2
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Clean text for PDF output.
  // jsPDF's built-in helvetica only supports Latin-1 (0x00–0xFF).
  // Anything outside that range renders as '?' or triggers Courier fallback.
  function cleanForPDF(str) {
    if (!str) return '';
    return str
      // Emojis → '-' (keeps bullet-list feel)
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '- ')
      .replace(/[\u{2600}-\u{27BF}]/gu, '- ')
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/\u200D/g, '')
      .replace(/\uFE0F/g, '')
      // Thai baht symbol → 'THB' (฿ is U+0E3F, outside Latin-1)
      .replace(/฿/g, 'THB ')
      // Typographic chars → ASCII equivalents
      .replace(/[—–]/g, '-')
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'")
      .replace(/[…]/g, '...')
      .replace(/[×]/g, 'x')
      // Remove decorative separator lines: +++, ====, ----, ~~~~
      .replace(/^[\s]*[+\-=*~#]{3,}[\s]*$/gm, '')
      // Drop any remaining non-Latin-1 characters (Thai, CJK, etc.)
      .replace(/[^\x00-\xFF]/g, '')
      // Tidy up
      .replace(/^- :/gm, ':')
      .replace(/- (\s*- )+/g, '- ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Remove Facebook UI navigation strings that bleed into extracted text
  const FB_UI_STRINGS = new Set([
    'groupes','groups','marketplace','accueil','home',
    "j'aime","like","commenter","comment","partager","share",
    'voir plus','see more','voir moins','see less',
    'voir la traduction','see translation','hide translation',
    'répondre','reply','signaler','report','enregistrer','save',
    'voir les réponses','view replies','masquer les réponses','hide replies',
    'membre','members','suivre','follow','rejoindre','join',
    'notifications','paramètres','settings','rechercher','search',
    'messenger','stories','reels','vidéo','video','photos',
  ]);

  function removeFacebookUI(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const filtered = lines.filter(line => {
      const t = line.trim().toLowerCase();
      if (!t) return true; // keep empty lines for spacing
      // Drop lines that are ONLY a known UI string (with optional punctuation)
      return !FB_UI_STRINGS.has(t.replace(/[:.!?]+$/, ''));
    });
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Detect bilingual posts (Thai + English/French) and keep only one version.
  // Most Bangkok RE posts repeat the same content twice: once in Thai, once in English.
  function deduplicateBilingual(text) {
    if (!text) return text;

    const THAI = /[\u0E00-\u0E7F]/g;
    const LATIN = /[a-zA-Z]/g;

    function langOf(block) {
      const thai  = (block.match(THAI)  || []).length;
      const latin = (block.match(LATIN) || []).length;
      const total = thai + latin;
      if (total < 5) return 'neutral';
      if (thai  / total > 0.45) return 'th';
      if (latin / total > 0.45) return 'en';
      return 'mixed';
    }

    const paragraphs = text.split(/\n{2,}/);
    const langs = paragraphs.map(langOf);

    const hasEn = langs.some(l => l === 'en' || l === 'mixed');
    const hasTh = langs.some(l => l === 'th');

    // If the post contains both Thai-only blocks AND Latin blocks → bilingual
    if (hasEn && hasTh) {
      // Keep English/mixed blocks, drop Thai-only blocks
      const kept = paragraphs.filter((_, i) => langs[i] !== 'th');
      return kept.join('\n\n').trim();
    }

    return text;
  }

  async function detectAndTranslate(text) {
    if (!text || text.trim().length < 5) return { text, translated: false };
    try {
      const sample = encodeURIComponent(text.substring(0, 500));
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${sample}`);
      const d = await r.json();
      const lang = d[2];
      if (lang === 'en' || lang === 'fr') return { text, translated: false, lang };

      const chunks = [];
      for (let i = 0; i < text.length; i += 1000) chunks.push(text.substring(i, i + 1000));

      const parts = await Promise.all(chunks.map(async chunk => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=en&dt=t&q=${encodeURIComponent(chunk)}`;
        const r2 = await fetch(url);
        const d2 = await r2.json();
        return d2[0].map(item => item[0]).join('');
      }));
      return { text: parts.join(' '), translated: true, lang, original: text };
    } catch (e) {
      console.warn('[FBExt] Translation error:', e);
      return { text, translated: false };
    }
  }

  // ===================== EXTRACTION (scoped to an element) =====================

  function extractTitle(scope) {
    // For a specific post scope, use first line of description as title
    if (scope && scope !== document.body) {
      const firstText = extractDescription(scope).split('\n')[0];
      if (firstText && firstText.length < 120) return firstText;
    }
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim();
    const og = document.querySelector('meta[property="og:title"]');
    return og ? og.getAttribute('content') || '' : document.title || '';
  }

  function extractPrice(scope) {
    const root = scope || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (/^฿[\d,\s]+$/.test(t) || /^[\d,]+\s*฿$/.test(t) || /^[\d,]+\s*THB$/i.test(t)) {
        if (t.length < 25) return t;
      }
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length > 1) continue;
      const t = el.textContent.trim();
      if (/฿/.test(t) && t.length < 30) return t;
    }
    return '';
  }

  function extractLocation(scope) {
    const root = scope || document.body;
    const keywords = ['Bangkok', 'กรุงเทพ', 'Pattaya', 'Phuket', 'Chiang Mai',
                      'Sukhumvit', 'Silom', 'Sathorn', 'Asok', 'Thonglor',
                      'Ekkamai', 'Ari', 'Ladprao', 'Nonthaburi', 'Samut'];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (t.length > 5 && t.length < 100) {
        for (const kw of keywords) {
          if (t.includes(kw)) return t;
        }
      }
    }
    return '';
  }

  function extractDescription(scope) {
    const root = scope || document.body;
    const candidates = [];

    // [dir="auto"] blocks — Facebook uses this for all user-written text
    for (const el of root.querySelectorAll('[dir="auto"]')) {
      // Skip elements that contain other [dir="auto"] children (take the innermost)
      if (el.querySelector('[dir="auto"]')) continue;
      const t = el.textContent.trim();
      if (t.length > 40 && t.length < 8000) candidates.push(t);
    }

    // Fallback: data-ad-preview
    for (const el of root.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]')) {
      const t = el.textContent.trim();
      if (t.length > 30) candidates.push(t);
    }

    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  }

  function collectImages(scope) {
    const root = scope || document.body;
    const urls = new Set();

    for (const img of root.querySelectorAll('img')) {
      const src = img.src || '';
      // Only Facebook CDN images
      if (!src.includes('fbcdn')) continue;

      // Skip tiny images (avatars, icons, reactions)
      const w = img.naturalWidth || img.width || img.offsetWidth;
      const h = img.naturalHeight || img.height || img.offsetHeight;
      if (w > 0 && w < 150) continue;
      if (h > 0 && h < 150) continue;

      // Skip profile pictures and group cover photos
      if (img.closest('[data-visualcompletion="ignore-dynamic"]')) continue;
      // Skip images in page header / navigation areas
      if (img.closest('header, nav, [role="banner"], [role="navigation"]')) continue;
      // Skip group cover/banner images (usually very wide, short height = landscape banner)
      if (w > 0 && h > 0 && w / h > 4) continue;
      // Skip images whose URL suggests they're profile/avatar (t1.0-1, t1.0-9 CDN paths)
      if (/\/t1\.0-(1|9)\//.test(src)) continue;

      if (img.srcset) {
        const best = img.srcset.split(',')
          .map(s => { const p = s.trim().split(/\s+/); return { url: p[0], w: parseInt(p[1]) || 0 }; })
          .sort((a, b) => b.w - a.w)[0];
        if (best) { urls.add(best.url); continue; }
      }
      urls.add(src);
    }
    return [...urls];
  }

  async function extractAll(pageType, scope) {
    const rawDesc   = extractDescription(scope);
    // 1. Strip FB UI strings, 2. Remove phones, 3. Deduplicate bilingual content
    const cleanDesc = deduplicateBilingual(removePhones(removeFacebookUI(rawDesc)));
    const rawTitle  = pageType === 'group-feed' || (scope && scope !== document.body)
                        ? rawDesc.split('\n')[0].substring(0, 120)
                        : extractTitle(scope);

    const [descResult, titleResult] = await Promise.all([
      detectAndTranslate(cleanDesc),
      detectAndTranslate(rawTitle)
    ]);

    return {
      title:               titleResult.text,
      price:               extractPrice(scope),
      location:            extractLocation(scope),
      description:         descResult.text,
      originalDescription: descResult.translated ? descResult.original : null,
      wasTranslated:       descResult.translated,
      images:              collectImages(scope),
      pageType
    };
  }

  // ===================== FLOATING BUTTON (Marketplace / specific post page) =====================

  function injectFloatingButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
      </svg>
      <span>Extract</span>
    `;
    btn.addEventListener('click', async () => {
      btn.classList.add('fbext-loading');
      btn.querySelector('span').textContent = '…';
      try {
        const data = await extractAll(getPageType(), document.body);
        showModal(data);
      } catch (e) {
        console.error('[FBExt]', e);
        alert('Extraction failed.');
      } finally {
        btn.classList.remove('fbext-loading');
        btn.querySelector('span').textContent = 'Extract';
      }
    });
    document.body.appendChild(btn);
  }

  // ===================== PER-POST BUTTON (Group feed) =====================

  // Returns true if this article is nested inside another article (= it's a comment)
  function isCommentArticle(el) {
    let p = el.parentElement;
    while (p) {
      if (p !== el && p.getAttribute('role') === 'article') return true;
      p = p.parentElement;
    }
    return false;
  }

  function injectPostButtons() {
    document.querySelectorAll('div[role="article"]').forEach(article => {
      if (article.hasAttribute(POST_MARKED)) return;
      article.setAttribute(POST_MARKED, '1');

      // Skip comments — they are articles nested inside another article
      if (isCommentArticle(article)) return;

      // Skip banners / headers with no real content
      const text = article.innerText?.trim() || '';
      if (text.length < 40) return;

      const btn = document.createElement('button');
      btn.className = POST_BTN_CLASS;
      btn.textContent = '📋 Extract';

      // Position relative if needed
      if (getComputedStyle(article).position === 'static') {
        article.style.position = 'relative';
      }
      article.appendChild(btn);

      btn.addEventListener('click', async e => {
        e.stopPropagation();
        e.preventDefault();
        if (!isExtensionAlive()) {
          alert('Extension reloaded — please refresh this page (Cmd+R) to reactivate the buttons.');
          return;
        }
        btn.textContent = '⏳…';
        btn.disabled = true;
        try {
          const data = await extractAll('group-post', article);
          showModal(data);
        } catch (err) {
          console.error('[FBExt]', err);
          alert('Extraction failed: ' + (err.message || err));
        } finally {
          btn.textContent = '📋 Extract';
          btn.disabled = false;
        }
      });
    });
  }

  // ===================== MODAL =====================

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function showModal(data) {
    document.getElementById(OVERLAY_ID)?.remove();

    const photosHtml = data.images.length > 0
      ? `<div class="fbext-photos">${data.images.slice(0, 20).map(u =>
          `<img src="${u}" alt="photo" loading="lazy" onerror="this.remove()">`).join('')}</div>`
      : '<p class="fbext-no-photos">Aucune photo trouvée.</p>';

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="fbext-modal">
        <div class="fbext-header">
          <span class="fbext-header-title">Property Extractor</span>
          <button class="fbext-close">✕</button>
        </div>
        <div class="fbext-body">
          ${data.wasTranslated ? '<div class="fbext-translated-badge">🌐 Translated from Thai</div>' : ''}
          <h2 class="fbext-title">${esc(data.title)}</h2>
          ${data.price    ? `<div class="fbext-price">${esc(data.price)}</div>` : ''}
          ${data.location ? `<div class="fbext-location">📍 ${esc(data.location)}</div>` : ''}
          <div class="fbext-desc">${esc(data.description)}</div>
          <div class="fbext-section-title">Photos (${data.images.length})</div>
          ${photosHtml}
        </div>
        <div class="fbext-footer">
          <button class="fbext-pdf-btn">📥 Télécharger PDF</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('.fbext-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.fbext-pdf-btn').addEventListener('click', async function () {
      this.textContent = '⏳ Génération…';
      this.disabled = true;
      try { await generatePDF(data); }
      catch (e) { console.error('[FBExt] PDF:', e); alert('PDF error: ' + (e.message || e)); }
      finally { this.textContent = '📥 Télécharger PDF'; this.disabled = false; }
    });
  }

  // ===================== PDF =====================

  function isExtensionAlive() {
    try { return !!chrome.runtime.id; } catch (e) { return false; }
  }

  async function fetchImagesBase64(urls) {
    // Extension context can be invalidated if the extension was reloaded without
    // refreshing the Facebook tab. In that case, skip images and still produce PDF.
    if (!isExtensionAlive()) {
      console.warn('[FBExt] Extension context invalidated — PDF will be generated without photos. Refresh this tab to restore full functionality.');
      return [];
    }
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'fetchImages', urls }, response => {
          if (chrome.runtime.lastError) { resolve([]); return; }
          resolve(response?.images || []);
        });
      } catch (e) {
        console.warn('[FBExt] sendMessage failed:', e.message);
        resolve([]);
      }
    });
  }

  async function generatePDF(data) {
    // jsPDF is loaded as a content script — verify it's available
    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('jsPDF not loaded. Reload the extension in chrome://extensions and try again.');
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const margin = 15;
    const pageW  = 210;
    const pageH  = 297;
    const cw     = pageW - margin * 2;
    let y        = margin;

    // Sanitize all text for Latin-1 PDF rendering
    const clean = str => cleanForPDF(str || '');

    function checkBreak(h) {
      if (y + h > pageH - margin) { doc.addPage(); y = margin; }
    }

    // --- Title ---
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    const titleLines = doc.splitTextToSize(clean(data.title) || 'Property Listing', cw);
    checkBreak(titleLines.length * 9 + 4);
    doc.text(titleLines, margin, y);
    y += titleLines.length * 9 + 4;

    // --- Price ---
    if (data.price) {
      doc.setFontSize(14);
      doc.setTextColor(0, 140, 0);
      doc.setFont('helvetica', 'bold');
      checkBreak(9);
      doc.text(clean(data.price), margin, y);
      y += 9;
      doc.setTextColor(0, 0, 0);
    }

    // --- Location ---
    if (data.location) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      checkBreak(7);
      doc.text(`Location: ${clean(data.location)}`, margin, y);
      y += 7;
    }

    // --- Translation note ---
    if (data.wasTranslated) {
      doc.setFontSize(9);
      doc.setTextColor(120, 120, 120);
      checkBreak(6);
      doc.text('[Translated from Thai]', margin, y);
      y += 6;
      doc.setTextColor(0, 0, 0);
    }

    // --- Separator ---
    y += 3;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pageW - margin, y);
    y += 6;

    // --- Description ---
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    const descLines = doc.splitTextToSize(clean(data.description), cw);
    for (const line of descLines) {
      checkBreak(6);
      doc.text(line, margin, y);
      y += 6;
    }

    y += 8;

    // --- Photos ---
    if (data.images.length > 0) {
      doc.setFontSize(13);
      doc.setFont('helvetica', 'bold');
      checkBreak(10);
      doc.text('Photos', margin, y);
      y += 9;

      const imgDataArray = await fetchImagesBase64(data.images);
      const imgH = 100;

      for (const imgData of imgDataArray) {
        try {
          checkBreak(imgH + 6);
          const fmt = imgData.startsWith('data:image/png') ? 'PNG' : 'JPEG';
          doc.addImage(imgData, fmt, margin, y, cw, imgH, undefined, 'MEDIUM');
          y += imgH + 6;
        } catch (err) {
          console.warn('[FBExt] Skipped image:', err);
        }
      }
    }

    doc.save(`property_${Date.now()}.pdf`);
  }

  // ===================== INIT =====================

  function init() {
    const type = getPageType();
    if (!type) return;

    if (type === 'marketplace' || type === 'group-post') {
      setTimeout(injectFloatingButton, 2500);
    } else if (type === 'group-feed') {
      setTimeout(() => {
        injectPostButtons();
        // Watch for new posts loaded on scroll
        new MutationObserver(injectPostButtons)
          .observe(document.body, { subtree: true, childList: true });
      }, 2500);
    }
  }

  // ===================== SPA NAVIGATION WATCHER =====================
  // Facebook uses the History API for navigation — MutationObserver alone misses it.
  // We intercept pushState/replaceState + listen to popstate.

  function onNavigate() {
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(OVERLAY_ID)?.remove();
    document.querySelectorAll(`.${POST_BTN_CLASS}`).forEach(b => b.remove());
    // Try at 1s and 3s to handle slow React renders
    setTimeout(init, 1000);
    setTimeout(init, 3000);
  }

  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    onNavigate();
  };

  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replaceState(...args);
    onNavigate();
  };

  window.addEventListener('popstate', onNavigate);

  // Fallback: catch anything we missed
  let lastHref = location.href;
  new MutationObserver(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    onNavigate();
  }).observe(document.documentElement, { subtree: true, childList: true });

  // Initial run — try at 1s and 3s
  setTimeout(init, 1000);
  setTimeout(init, 3000);
})();
