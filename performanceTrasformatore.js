// performanceTrasformatore.js — Vista "Performance" per il caseificio
(function () {
  let perfChart = null;

  function renderEmptyPerformance() {
    const canvas = document.getElementById('md-chart');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof Chart === 'undefined') return;

    // distruggi eventuali grafici esistenti
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (perfChart) { perfChart.destroy(); perfChart = null; }

    // grafico vuoto di placeholder
    perfChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: []
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: false }
        },
        scales: {
          x: { display: true },
          y: { display: true }
        }
      }
    });
  }

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
        // notifica la vista benchmark che è stata attivata
        document.dispatchEvent(new CustomEvent('trasfo:benchmark:activate'));
      }
    }

    // listeners
    mieiRadio.addEventListener('change', () => {
      if (mieiRadio.checked) activate('miei');
    });

    confRadio.addEventListener('change', () => {
      if (confRadio.checked) activate('conf');
    });

    // stato iniziale (come nell'index: benchmark attivo)
    if (confRadio.checked) {
      activate('conf');
    } else {
      activate('miei');
    }
  }

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
