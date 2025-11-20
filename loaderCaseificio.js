// loaderCaseificio.js — carica datiCAO.json e espone helper per la vista Trasformatore
(function () {
  const SRC = './datiCAO.json?v=' + Date.now();

  // array grezzo con TUTTE le righe del JSON
  window.CAO_RAW = [];

  // piccolo "namespace" per avere già dei filtri pronti
  window.CAO = {
    /**
     * Tutti i record così come arrivano dal JSON
     */
    getAll() {
      return window.CAO_RAW.slice();
    },

    /**
     * Filtra per KPI (es. 'grassi', 'proteine', 'lattosio', 'caseina')
     */
    byKpi(kpiKey) {
      if (!kpiKey) return window.CAO_RAW.slice();
      const k = String(kpiKey).toLowerCase();
      return window.CAO_RAW.filter(r => String(r.KPI).toLowerCase() === k);
    },

    /**
     * Filtro generico:
     *   opts = { kpi, fromYear, toYear, fromMonth, toMonth, caseificio, provincia }
     */
    filter(opts = {}) {
      const {
        kpi,
        fromYear,
        toYear,
        fromMonth,
        toMonth,
        caseificio,
        provincia
      } = opts;

      return window.CAO_RAW.filter(r => {
        if (!r) return false;

        if (kpi && String(r.KPI).toLowerCase() !== String(kpi).toLowerCase()) {
          return false;
        }

        if (caseificio && String(r.Caseificio).toLowerCase() !== String(caseificio).toLowerCase()) {
          return false;
        }

        if (provincia && String(r.Provincia).toLowerCase() !== String(provincia).toLowerCase()) {
          return false;
        }

        const y = Number(r.Anno);
        const m = Number(r.Mese);

        if (Number.isFinite(fromYear) && y < fromYear) return false;
        if (Number.isFinite(toYear)   && y > toYear)   return false;

        if (Number.isFinite(fromMonth) && m < fromMonth) return false;
        if (Number.isFinite(toMonth)   && m > toMonth)   return false;

        return true;
      });
    }
  };

  async function loadCao() {
    try {
      const resp = await fetch(SRC, { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();

      if (!Array.isArray(data) || !data.length) {
        console.warn('[loaderCaseificio] datiCAO.json vuoto o non array');
        window.CAO_RAW = [];
      } else {
        window.CAO_RAW = data;
        console.log('[loaderCaseificio] caricati', data.length, 'record da datiCAO.json');
      }

      // Notifica chi è interessato (es. benchmarkTrasformatore.js)
      document.dispatchEvent(new CustomEvent('cao:loaded', {
        detail: { size: window.CAO_RAW.length }
      }));
    } catch (err) {
      console.error('[loaderCaseificio] errore nel caricamento di datiCAO.json:', err);
      window.CAO_RAW = [];
      document.dispatchEvent(new CustomEvent('cao:loaded', {
        detail: { size: 0, error: String(err) }
      }));
    }
  }

  // Parti appena possibile (come dataLoader.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCao);
  } else {
    loadCao();
  }
})();
