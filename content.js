// content.js — Facebook Property Extractor
(function () {
  'use strict';

  // ===================== CONSTANTS =====================

  // Thai phone: 06x/08x/09x + 7 digits (spaces/dashes optional) | +66 international
  const PHONE_REGEX = /(\+66[\s.\-]?[6-9](?:[\s.\-]?\d){8}|0[6-9]\d(?:[\s.\-]?\d){7})/g;

  const BTN_ID      = 'fbext-btn';
  const OVERLAY_ID  = 'fbext-overlay';

  // ===================== PAGE DETECTION =====================

  function getPageType() {
    const url = window.location.href;
    if (url.includes('/marketplace/item/')) return 'marketplace';
    if (url.includes('/groups/'))           return 'group';
    return null;
  }

  // ===================== TEXT UTILS =====================

  function removePhones(text) {
    return text.replace(PHONE_REGEX, '[tel supprimé]');
  }

  async function detectAndTranslate(text) {
    if (!text || text.trim().length < 5) return { text, translated: false };

    try {
      // Detect language on first 500 chars
      const sample = encodeURIComponent(text.substring(0, 500));
      const detectUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${sample}`;
      const detResp = await fetch(detectUrl);
      const detData = await detResp.json();
      const lang = detData[2]; // 'th', 'en', 'fr', ...

      if (lang === 'en' || lang === 'fr') {
        return { text, translated: false, lang };
      }

      // Translate full text in 1000-char chunks
      const chunks = [];
      for (let i = 0; i < text.length; i += 1000) {
        chunks.push(text.substring(i, i + 1000));
      }

      const translated = await Promise.all(chunks.map(async chunk => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${lang}&tl=en&dt=t&q=${encodeURIComponent(chunk)}`;
        const r = await fetch(url);
        const d = await r.json();
        return d[0].map(item => item[0]).join('');
      }));

      return {
        text: translated.join(' '),
        translated: true,
        lang,
        original: text
      };
    } catch (e) {
      console.warn('[FBExt] Translation failed:', e);
      return { text, translated: false };
    }
  }

  // ===================== DATA EXTRACTION =====================

  function extractTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();

    const og = document.querySelector('meta[property="og:title"]');
    if (og) return og.getAttribute('content') || '';

    return document.title || '';
  }

  function extractPrice() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (/^฿[\d,\s]+$/.test(t) || /^[\d,]+\s*฿$/.test(t) || /^[\d,]+\s*THB$/i.test(t)) {
        if (t.length < 25) return t;
      }
    }
    // Broader: element with ฿ and little children
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 1) continue;
      const t = el.textContent.trim();
      if (/฿/.test(t) && t.length < 30) return t;
    }
    return '';
  }

  function extractLocation() {
    const keywords = ['Bangkok', 'กรุงเทพ', 'Pattaya', 'Phuket', 'Chiang Mai',
                      'Sukhumvit', 'Silom', 'Sathorn', 'Asok', 'Thonglor',
                      'Ekkamai', 'Ari', 'Ladprao', 'Nonthaburi', 'Samut'];

    // Look inside known location containers
    const candidates = document.querySelectorAll(
      '[aria-label*="Location"], [aria-label*="ตำแหน่ง"], a[href*="marketplace/category/propertyrentals"]'
    );
    for (const el of candidates) {
      const t = el.textContent.trim();
      if (t && t.length < 120) return t;
    }

    // Keyword scan in leaf text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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

  function extractDescription(pageType) {
    // Strategy: gather all [dir="auto"] text blocks, pick the longest plausible one
    const candidates = [];

    if (pageType === 'marketplace') {
      for (const el of document.querySelectorAll('[dir="auto"]')) {
        const t = el.textContent.trim();
        if (t.length > 80 && t.length < 8000 && el.children.length < 10) {
          candidates.push(t);
        }
      }
    } else {
      // Group post
      const selectors = [
        '[data-ad-preview="message"]',
        '[data-ad-comet-preview="message"]',
        '[dir="auto"]'
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent.trim();
          if (t.length > 50 && t.length < 8000) candidates.push(t);
        }
        if (candidates.length > 0) break;
      }
    }

    // Return longest unique candidate
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  }

  function collectImages() {
    const urls = new Set();

    for (const img of document.querySelectorAll('img')) {
      const src = img.src || '';
      // Only Facebook CDN images
      if (!src.includes('fbcdn') && !src.includes('fbexternal')) continue;

      // Skip tiny (avatars, icons) — check both natural and rendered size
      const w = img.naturalWidth || img.width || img.offsetWidth;
      if (w > 0 && w < 150) continue;

      // Prefer highest-res from srcset
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

  async function extractAll(pageType) {
    const rawDesc  = extractDescription(pageType);
    const cleanDesc = removePhones(rawDesc);
    const rawTitle  = extractTitle();

    // Run translation concurrently
    const [descResult, titleResult] = await Promise.all([
      detectAndTranslate(cleanDesc),
      detectAndTranslate(rawTitle)
    ]);

    return {
      title:               titleResult.text,
      price:               extractPrice(),
      location:            extractLocation(),
      description:         descResult.text,
      originalDescription: descResult.translated ? descResult.original : null,
      wasTranslated:       descResult.translated,
      images:              collectImages(),
      pageType
    };
  }

  // ===================== FLOATING BUTTON =====================

  function injectButton() {
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
        const data = await extractAll(getPageType());
        showModal(data);
      } catch (e) {
        console.error('[FBExt]', e);
        alert('Extraction failed. See console for details.');
      } finally {
        btn.classList.remove('fbext-loading');
        btn.querySelector('span').textContent = 'Extract';
      }
    });

    document.body.appendChild(btn);
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
      ? `<div class="fbext-photos">
          ${data.images.slice(0, 20).map(u =>
            `<img src="${u}" alt="photo" loading="lazy" onerror="this.remove()">`
          ).join('')}
         </div>`
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
      try {
        await generatePDF(data);
      } catch (e) {
        console.error('[FBExt] PDF error:', e);
        alert('PDF generation failed.');
      } finally {
        this.textContent = '📥 Télécharger PDF';
        this.disabled = false;
      }
    });
  }

  // ===================== PDF =====================

  async function fetchImagesBase64(urls) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'fetchImages', urls }, response => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(response?.images || []);
      });
    });
  }

  async function generatePDF(data) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const margin = 15;
    const pageW = 210;
    const pageH = 297;
    const cw = pageW - margin * 2; // content width
    let y = margin;

    function checkBreak(h) {
      if (y + h > pageH - margin) { doc.addPage(); y = margin; }
    }

    // --- Title ---
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    const titleLines = doc.splitTextToSize(data.title || 'Property Listing', cw);
    checkBreak(titleLines.length * 9 + 4);
    doc.text(titleLines, margin, y);
    y += titleLines.length * 9 + 4;

    // --- Price ---
    if (data.price) {
      doc.setFontSize(14);
      doc.setTextColor(0, 140, 0);
      doc.setFont('helvetica', 'bold');
      checkBreak(9);
      doc.text(data.price, margin, y);
      y += 9;
      doc.setTextColor(0, 0, 0);
    }

    // --- Location ---
    if (data.location) {
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      checkBreak(7);
      doc.text(`📍 ${data.location}`, margin, y);
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
    const descLines = doc.splitTextToSize(data.description || '', cw);
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

  // ===================== INIT & SPA WATCHER =====================

  function init() {
    if (!getPageType()) return;
    // Facebook renders content dynamically — wait a bit
    setTimeout(injectButton, 2500);
  }

  // Watch for SPA navigation (Facebook is a React SPA)
  let lastHref = location.href;
  new MutationObserver(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(OVERLAY_ID)?.remove();
    setTimeout(init, 2500);
  }).observe(document.documentElement, { subtree: true, childList: true });

  init();
})();
