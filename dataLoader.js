// dataLoader.js — carica data.json e popola window.RAW senza toccare app.js
(function(){
  const SRC = './data.json?v=' + Date.now();

  async function loadJson() {
    try {
      const resp = await fetch(SRC, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP '+resp.status);
      const data = await resp.json();
      if (Array.isArray(data) && data.length) {
        window.RAW = data;
        console.log('[dataLoader] DATA SOURCE:', 'data.json', data.length);
        document.dispatchEvent(new CustomEvent('raw:loaded', { detail: { source: 'json', size: data.length } }));
        return;
      }
      throw new Error('JSON vuoto o non array');
    } catch (err) {
      console.warn('[dataLoader] fetch fallito, provo seed:', err);
      try {
        const seedTag = document.getElementById('seed');
        const seed = seedTag && seedTag.textContent ? JSON.parse(seedTag.textContent) : [];
        window.RAW = Array.isArray(seed) ? seed : [];
        console.log('[dataLoader] DATA SOURCE:', 'seed', window.RAW.length);
        document.dispatchEvent(new CustomEvent('raw:loaded', { detail: { source: 'seed', size: window.RAW.length } }));
      } catch (e2) {
        window.RAW = [];
        console.warn('[dataLoader] nessun dato disponibile.');
        document.dispatchEvent(new CustomEvent('raw:loaded', { detail: { source: 'none', size: 0 } }));
      }
    }
  }

  // Parti appena possibile (defer lo farà a DOM pronto)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadJson);
  } else {
    loadJson();
  }
})();
