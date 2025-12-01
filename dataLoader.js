// dataLoader.js - carica data.json e popola window.RAW senza toccare benchmarkAllevatore.js
// COSA FA (alto livello)
// - Scarica data.json (no-cache) e popola window.RAW con il dataset aziendale.
// - Se il fetch fallisce imposta RAW=[].
// - Notifica il caricamento con l'evento custom "raw:loaded" (detail: {source,size}).
//
// FLUSSO
// - All'avvio (DOMContentLoaded) chiama loadJson().
// - loadJson(): fetch data.json -> set window.RAW -> dispatch "raw:loaded".
//   In caso di errore: imposta RAW=[] e dispatch "raw:loaded" (source 'none').
//
// DIPENDENZE
// - fetch API disponibile.
// - Consumatori: benchmarkAllevatore.js, performanceAllevatore.js (ascoltano "raw:loaded").
(function(){
  const SRC = './data.json?v=' + Date.now();

  /**
   * Scarica data.json (no-cache) e popola window.RAW, notificando con evento "raw:loaded".
   * In caso di errore, setta RAW=[] e notifica con source 'none'.
   * Emitted event detail: { source: 'json'|'none', size: <numero record> }.
   */
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
      console.warn('[dataLoader] fetch fallito:', err);
      window.RAW = [];
      document.dispatchEvent(new CustomEvent('raw:loaded', { detail: { source: 'none', size: 0 } }));
    }
  }

  // Parti appena possibile (defer lo fara a DOM pronto)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadJson);
  } else {
    loadJson();
  }
})();
