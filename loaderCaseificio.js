// loaderCaseificio.js - carica dati CAO: cisterna (datiCAO.json) + campioni conferitori (conferitoriCAO.json)
// COSA FA (alto livello)
// - Carica i dati CAO: valori cisterna mensili (CAO_TANK) e campioni conferitori (CAO_RAW) da file multipli.
// - Espone API su window.CAO: ensureLoaded/load, filter/filterTank, getAll/getTank, isLoaded/isLoading.
// - Emette evento "cao:loaded" al termine (detail: { size, tank, error? }).
//
// FLUSSO PRINCIPALE
// - all'avvio (DOMContentLoaded) chiama ensureLoaded() per pre-caricare i dati.
// - ensureLoaded(): se gia' caricato e non force, riusa i dati; altrimenti fetch di datiCAO.json + conferitoriCAO-*.json,
//   flat dei campioni, set su window.CAO_RAW / window.CAO_TANK, dispatch "cao:loaded".
//
// DIPENDENZE
// - fetch API disponibile.
// - Dataset JSON: datiCAO.json (cisterna) + conferitoriCAO-22-23/23-24/24-25.json (campioni).
// - Consumatori: benchmarkTrasformatore.js (modalita intraCaseificio), eventualmente altri moduli.
//
// NOTA: logica invariata, documentazione e JSDoc aggiunte per chiarezza/manutenzione.
(function () {
  const SRC_CAMPI = [
    './conferitoriCAO-22-23.json',
    './conferitoriCAO-23-24.json',
    './conferitoriCAO-24-25.json'
  ];
  const SRC_TANK  = './datiCAO.json';

  // Stato globale: dataset conferitori (campioni) e cisterna (valori mensili)
  window.CAO_RAW  = Array.isArray(window.CAO_RAW) ? window.CAO_RAW : [];   // campioni conferitori
  window.CAO_TANK = Array.isArray(window.CAO_TANK) ? window.CAO_TANK : []; // valori cisterna mensili

  // Promise condivisa per evitare richieste parallele duplicate
  let loadPromise = null;

  /**
   * Normalizza stringa in lower-case e trim.
   */
  function norm(v) {
    return String(v || '').trim().toLowerCase();
  }

  // Alias KPI per gestire plurali / sinonimi
  const KPI_ALIASES = {
    grassi:    ['grassi', 'grasso'],
    proteine:  ['proteine', 'proteina'],
    lattosio:  ['lattosio'],
    caseina:   ['caseina', 'caseine'],
    cellule:   ['cellule', 'scc'],
    carica:    ['carica', 'cbt'],
    urea:      ['urea'],
    crio:      ['crio', 'crio ft'],
    nacl:      ['nacl'],
    ph:        ['ph']
  };

  /**
   * Normalizza le sigle provincia (ss/ca/or/nu) in nome esteso.
   * @param {string} p codice/nome provincia.
   * @returns {string} nome provincia normalizzato.
   */
  function mapProvincia(p) {
    const v = norm(p);
    if (v === 'ca') return 'Cagliari';
    if (v === 'ss') return 'Sassari';
    if (v === 'or') return 'Oristano';
    if (v === 'nu') return 'Nuoro';
    return (p || '').trim();
  }

  /**
   * Filtra i campioni conferitori (CAO_RAW) per KPI/anno/mese/provincia.
   * Dipendenze: window.CAO_RAW popolato da ensureLoaded(); usa KPI_ALIASES per match KPI.
   * @param {Object} opts { kpi, fromYear, toYear, fromMonth, toMonth, provincia }
   * @returns {Array<Object>} record conferitori filtrati
   */
  function filter(opts = {}) {
    const { kpi, fromYear, toYear, fromMonth, toMonth, provincia } = opts;

    let kpiAccepted = null;
    if (kpi) {
      const key = norm(kpi);
      kpiAccepted = KPI_ALIASES[key] ? KPI_ALIASES[key].map(norm) : [key];
    }

    const provName = provincia ? mapProvincia(provincia) : null;

    return window.CAO_RAW.filter(r => {
      if (!r) return false;

      if (kpiAccepted) {
        const rk = norm(r.KPI);
        if (!kpiAccepted.includes(rk)) return false;
      }

      if (provName && r.Provincia && r.Provincia !== provName) return false;

      const y = Number(r.Anno);
      const m = Number(r.Mese);
      if (Number.isFinite(fromYear) && y < fromYear) return false;
      if (Number.isFinite(toYear) && y > toYear) return false;
      if (Number.isFinite(fromMonth) && m < fromMonth) return false;
      if (Number.isFinite(toMonth)   && m > toMonth)   return false;

      return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(Number(r.Valore));
    });
  }

  /**
   * Filtra i valori cisterna mensili (CAO_TANK) per KPI/anno/mese/provincia.
   * Dipendenze: window.CAO_TANK popolato da ensureLoaded(); usa KPI_ALIASES per match KPI.
   * @param {Object} opts { kpi, fromYear, toYear, fromMonth, toMonth, provincia }
   * @returns {Array<Object>} record cisterna filtrati
   */
  function filterTank(opts = {}) {
    const { kpi, fromYear, toYear, fromMonth, toMonth, provincia } = opts;

    let kpiAccepted = null;
    if (kpi) {
      const key = norm(kpi);
      kpiAccepted = KPI_ALIASES[key] ? KPI_ALIASES[key].map(norm) : [key];
    }

    const provName = provincia ? mapProvincia(provincia) : null;

    return window.CAO_TANK.filter(r => {
      if (!r) return false;

      if (kpiAccepted) {
        const rk = norm(r.KPI);
        if (!kpiAccepted.includes(rk)) return false;
      }

      if (provName && r.Provincia && r.Provincia !== provName) return false;

      const y = Number(r.Anno);
      const m = Number(r.Mese);
      if (Number.isFinite(fromYear) && y < fromYear) return false;
      if (Number.isFinite(toYear) && y > toYear) return false;
      if (Number.isFinite(fromMonth) && m < fromMonth) return false;
      if (Number.isFinite(toMonth)   && m > toMonth)   return false;

      return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(Number(r.Valore));
    });
  }

  /**
   * Carica i JSON CAO (cisterna + campioni) se non presenti o se force=true.
   * Popola window.CAO_RAW e window.CAO_TANK, emette evento "cao:loaded".
   * Dipendenze: fetch API; file JSON SRC_TANK + SRC_CAMPI; usa loadPromise per evitare ricarichi paralleli.
   *
   * Come avviene il caricamento:
   * - costruiamo gli URL dei 3 file conferitori (SRC_CAMPI) e del file cisterna (SRC_TANK) aggiungendo un cache-buster.
   * - eseguiamo in parallelo:
   *     fetch(SRC_TANK) -> json -> window.CAO_TANK
   *     fetch di ciascun file in SRC_CAMPI -> json -> appiattiamo tutti i chunk in un unico array window.CAO_RAW
   * - al termine logghiamo le cardinalità e dispatchiamo l'evento "cao:loaded" con {size, tank}.
   * @param {boolean} [force=false] forza ricarica
   * @returns {Promise<{tank:Array,samples:Array}>}
   */
  async function ensureLoaded(force = false) {
    if (window.CAO_RAW.length && window.CAO_TANK.length && !force) {
      return { tank: window.CAO_TANK, samples: window.CAO_RAW };
    }
    if (!loadPromise || force) {
      const urlTank = SRC_TANK + '?v=' + Date.now();
      const camUrls = SRC_CAMPI.map(u => u + '?v=' + Date.now());
      loadPromise = Promise.all([
        fetch(urlTank, { cache: 'no-store' }).then(resp => {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        }),
        Promise.all(camUrls.map(u => fetch(u, { cache: 'no-store' })
          .then(resp => {
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + u);
            return resp.json();
          })))
      ])
        .then(([tank, campioniChunks]) => {
          const flat = [];
          const chunks = campioniChunks || [];
          for (const chunk of chunks) {
            if (Array.isArray(chunk)) flat.push(...chunk);
          }
          window.CAO_TANK = Array.isArray(tank) ? tank : [];
          window.CAO_RAW  = flat;
          console.log('[loaderCaseificio] caricati', window.CAO_TANK.length, 'valori cisterna e', window.CAO_RAW.length, 'campioni (multifile)');
          document.dispatchEvent(new CustomEvent('cao:loaded', {
            detail: { size: window.CAO_RAW.length, tank: window.CAO_TANK.length }
          }));
          return { tank: window.CAO_TANK, samples: window.CAO_RAW };
        })
        .catch(err => {
          console.error('[loaderCaseificio] errore nel caricamento di dati CAO:', err);
          window.CAO_RAW  = [];
          window.CAO_TANK = [];
          document.dispatchEvent(new CustomEvent('cao:loaded', {
            detail: { size: 0, tank: 0, error: String(err) }
          }));
          return { tank: [], samples: [] };
        });
    }
    return loadPromise;
  }

  window.CAO = {
    /** True se almeno uno dei dataset (campioni o cisterna) e' caricato */
    isLoaded() { return window.CAO_RAW.length > 0 || window.CAO_TANK.length > 0; },
    /** True se c'e' un caricamento in corso (loadPromise attivo) */
    isLoading() { return !!loadPromise; },
    /** Forza o garantisce il caricamento dei JSON (alias load) */
    ensureLoaded,
    load: ensureLoaded,
    /** Copia dei campioni conferitori */
    getAll() { return window.CAO_RAW.slice(); },
    /** Copia dei valori cisterna mensili */
    getTank() { return window.CAO_TANK.slice(); },
    /** Filtra i campioni conferitori per KPI/periodo/provincia */
    filter,
    /** Filtra i valori cisterna per KPI/periodo/provincia */
    filterTank
  };

  // Avvia subito il caricamento come comportamento di default
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensureLoaded().catch(() => {}));
  } else {
    ensureLoaded().catch(() => {});
  }
})();
