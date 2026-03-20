// background.js — Service Worker
// Fetches images cross-origin and returns base64 data URIs

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'fetchImages') {
    const urls = message.urls || [];

    Promise.all(
      urls.slice(0, 10).map(url =>
        fetch(url)
          .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.blob();
          })
          .then(blob => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          }))
          .catch(() => null)
      )
    ).then(images => {
      sendResponse({ images: images.filter(Boolean) });
    });

    return true; // keep channel open for async response
  }
});
