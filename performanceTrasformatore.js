// performanceTrasformatore.js - Vista "Performance" per il caseificio (placeholder attuale)
/**
 * Flusso della vista Performance (trasformatore):
 * - init() e' l'entry point: aggancia i toggle UI e, se la vista "miei dati" e' attiva, disegna il placeholder.
 * - setupToggle() gestisce lo switch Performance/Benchmark: mostra/nasconde i container e,
 *   quando passa a Benchmark, emette l'evento custom "trasfo:benchmark:activate" per far avviare la vista benchmark.
 * - renderEmptyPerformance() prepara un grafico vuoto su #md-chart per non lasciare la card bianca.
 *
 * Dipendenze/dati:
 * - elementi DOM: radio #miei-dati, #confronto, contenitori #view-miei e #view-conf, toggle #viewToggle, canvas #md-chart.
 * - Chart.js deve essere disponibile (placeholder altrimenti salta).
 *
 * Nota: questa e' ancora una vista placeholder; quando arriveranno i dati performance reali,
 * si potra' sostituire renderEmptyPerformance con il rendering effettivo.
 */
(function () {
  /** @type {Chart|null} handler Chart.js per il grafico performance (placeholder) */
  let perfChart = null;

  /**
   * Disegna un grafico vuoto di placeholder sulla vista Performance.
   * Distrugge eventuali grafici esistenti su #md-chart.
   * Dipendenze: richiede che Chart.js sia caricato e che esista il canvas #md-chart.
   */
  function renderEmptyPerformance() {
    const canvas = document.getElementById('md-chart');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof Chart === 'undefined') return;

    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (perfChart) { perfChart.destroy(); perfChart = null; }

    perfChart = new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, title: { display: false } },
        scales: { x: { display: true }, y: { display: true } }
      }
    });
  }

  /**
   * Gestisce il toggle Performance/Benchmark nel trasformatore.
   * - attiva/disattiva le viste DOM
   * - emette evento custom 'trasfo:benchmark:activate' quando si passa a benchmark
   * - in Performance disegna il placeholder vuoto
   * Dipendenze: radio #miei-dati/#confronto, container #view-miei/#view-conf, toggle #viewToggle.
   */
  function setupToggle() {
    const mieiRadio  = document.getElementById('miei-dati');
    const confRadio  = document.getElementById('confronto');
    const toggle     = document.getElementById('viewToggle');
    const viewMiei   = document.getElementById('view-miei');
    const viewConf   = document.getElementById('view-conf');

    if (!mieiRadio || !confRadio || !viewMiei || !viewConf) return;

    function activate(view) {
      if (view === 'miei') {
        viewMiei.classList.add('active');
        viewConf.classList.remove('active');
        if (toggle) toggle.dataset.active = 'miei';
        renderEmptyPerformance();
      } else {
        viewConf.classList.add('active');
        viewMiei.classList.remove('active');
        if (toggle) toggle.dataset.active = 'conf';
        document.dispatchEvent(new CustomEvent('trasfo:benchmark:activate'));
      }
    }

    if (mieiRadio) mieiRadio.addEventListener('change', () => { if (mieiRadio.checked) activate('miei'); });
    if (confRadio) confRadio.addEventListener('change', () => { if (confRadio.checked) activate('conf'); });

    if (confRadio && confRadio.checked) { activate('conf'); } else { activate('miei'); }
  }

  /**
   * Inizializzazione vista Performance: setup toggle e placeholder iniziale.
   * Entry point chiamato a DOMContentLoaded (o subito se il DOM e' gia' pronto).
   */
  function init() {
    setupToggle();
    const mieiRadio = document.getElementById('miei-dati');
    if (mieiRadio && mieiRadio.checked) {
      renderEmptyPerformance();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
