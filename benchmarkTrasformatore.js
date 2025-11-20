// benchmarkTrasformatore.js — Vista "Benchmark" per il caseificio
(function () {
  let kpiChart = null;
  // lascio lo slot per l'istogramma, che sistemeremo dopo
  let histChart = null;

  // Etichette asse X per lattazione (Ott–Set)
  const LATT_MONTH_LABELS = ['Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set'];

  // Palette colori per le lattazioni (max 3, come in app.js)
  const LAC_COLORS = ['#3b82f6', '#f59e0b', '#22c55e'];

  // Mappa stabile: startYear (string) -> colore, così colori e pallini restano allineati
  const LAC_COLOR_MAP = {};

  // Flag per non ricostruire 100 volte le checkbox
  let yearBoxesInitialized = false;

  // Flag per capire se i dati RAW (data.json) sono arrivati
  let rawReady = false;

  // ---------- KPI: unità e alias (qui i KPI sono leggermente diversi dall'allevatore) ----------
  const KPI_UNITS = {
    cellule:   'cell/mL',
    carica:    'UFC/mL',
    grasso:    '%',
    proteine:  '%',
    urea:      'mg/dL'
  };

  const KPI_ALIASES = {
    cellule:   ['cellule', 'scc', 'cellule somatiche', 'cellule somatiche (scc)'],
    carica:    ['carica', 'cbt', 'carica batterica', 'carica batterica (cbt)'],
    grasso:    ['grasso', 'grassi', 'fat', '% fat'],
    proteine:  ['proteine', 'protein', '% prot'],
    urea:      ['urea']
  };

  function normalizeKpiKey(key) {
    const k = String(key || '').toLowerCase();
    if (k === 'grasso') return 'grasso';
    return k;
  }

  function getSelectedKpi() {
    const sel = document.getElementById('indicatore');
    if (!sel) return 'grasso';
    return normalizeKpiKey(sel.value || 'grasso');
  }

  function getKpiUnit(k) {
    const key = normalizeKpiKey(k);
    return KPI_UNITS[key] || '';
  }

  function getAliasesFor(k) {
    const key = normalizeKpiKey(k);
    return (KPI_ALIASES[key] || [key]).map(s => String(s).toLowerCase());
  }

  function arithmeticMean(values) {
    let sum = 0;
    let n   = 0;
    for (const v of values) {
      const x = Number(v);
      if (Number.isFinite(x)) {
        sum += x;
        n++;
      }
    }
    return n ? (sum / n) : null;
  }

  // ---------- Mappa Anno/Mese → lattazione (Ott–Set) ----------
  /**
   * Converte Anno/Mese (1..12) in:
   *   - startYear della lattazione (Ott–Set)
   *   - indice 0..11 nel ciclo di lattazione
   *
   * Esempio:
   *   2022-10 → startYear=2022, index=0 (Ott)
   *   2022-11 → startYear=2022, index=1 (Nov)
   *   2023-01 → startYear=2022, index=3 (Gen)
   */
  function mapToLactation(anno, mese) {
    const y = Number(anno);
    const m = Number(mese);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;

    const startYear = m >= 10 ? y : y - 1;
    const pos = m >= 10 ? (m - 9) : (m + 3); // 10->1, 11->2, 12->3, 1->4, ..., 9->12

    return {
      startYear,
      index: pos - 1 // 0..11
    };
  }

  /**
   * Raggruppa i record (Anno, Mese, Valore) per lattazione (startYear)
   * e costruisce un vettore di 12 valori per ciascuna lattazione (Ott–Set).
   *
   * out: {
   *   "2022": {
   *     startYear: 2022,
   *     label: "2022-23",
   *     values: [..12..],
   *     count: numero di mesi con almeno un valore
   *   }, ...
   * }
   */
  function groupByLactation(rows) {
    const map = {};

    rows.forEach(r => {
      const lm = mapToLactation(r.Anno, r.Mese);
      if (!lm) return;
      const key = String(lm.startYear);

      if (!map[key]) {
        const endYear = lm.startYear + 1;
        const label = lm.startYear + '-' + String(endYear).slice(2);
        map[key] = {
          startYear: lm.startYear,
          label,
          values: new Array(12).fill(null),
          count: 0 // numero di mesi con valore
        };
      }

      const v = Number(r.Valore);
      if (!Number.isFinite(v)) return;

      if (map[key].values[lm.index] == null) {
        map[key].count++;
      }
      map[key].values[lm.index] = v;
    });

    return map;
  }

  /**
   * Costruisce dinamicamente le checkbox delle lattazioni disponibili,
   * sopra il grafico KPI (stile index allevatore), MA:
   * - mostra solo le ultime 3 lattazioni
   * - ciascuna deve avere almeno 4 mesi con dati (count >= 4)
   * - con un pallino colorato accanto alla checkbox (come in app.js)
   * - inizialmente è selezionata SOLO l’ultima lattazione (la più recente)
   */
  function ensureYearBoxes(lactMap) {
    const container = document.querySelector('#view-conf .year-boxes');
    if (!container) return;
    container.innerHTML = '';

    // svuota la mappa colori
    for (const k in LAC_COLOR_MAP) {
      if (Object.prototype.hasOwnProperty.call(LAC_COLOR_MAP, k)) {
        delete LAC_COLOR_MAP[k];
      }
    }

    const entries = Object.values(lactMap).sort((a, b) => a.startYear - b.startYear);

    // Filtra solo le lattazioni con almeno 4 mesi con dati
    const valid = entries.filter(l => (l.count || 0) >= 4);

    const source = valid.length ? valid : entries;
    const lastThree = source.slice(-3);
    const lastIdx = lastThree.length - 1; // indice dell'ultima (più recente)

    lastThree.forEach((l, idx) => {
      const color = LAC_COLORS[idx % LAC_COLORS.length];

      // mappa anno di lattazione -> colore, così il dataset userà lo stesso colore del pallino
      LAC_COLOR_MAP[String(l.startYear)] = color;

      const labelEl = document.createElement('label');
      labelEl.style.display = 'inline-flex';
      labelEl.style.alignItems = 'center';
      labelEl.style.gap = '6px';
      labelEl.style.marginRight = '10px';
      labelEl.style.fontSize = '13px';
      labelEl.style.color = '#0f172a';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(l.startYear);
      // solo l’ultima lattazione (più recente) è selezionata di default
      cb.checked = (idx === lastIdx);

      // Pallino colorato (come swatch legenda)
      const dot = document.createElement('span');
      dot.className = 'lac-dot';
      dot.style.width = '10px';
      dot.style.height = '10px';
      dot.style.borderRadius = '999px';
      dot.style.display = 'inline-block';
      dot.style.boxShadow = '0 0 0 1px rgba(0,0,0,.12) inset';
      dot.style.backgroundColor = color;

      const span = document.createElement('span');
      span.textContent = l.label;

      labelEl.appendChild(cb);
      labelEl.appendChild(dot);
      labelEl.appendChild(span);

      container.appendChild(labelEl);
    });

    yearBoxesInitialized = true;
  }

  function getActiveLactationKeys() {
    const container = document.querySelector('#view-conf .year-boxes');
    if (!container) return [];
    const cbs = container.querySelectorAll('input[type="checkbox"]');
    const active = [];
    cbs.forEach(cb => {
      if (cb.checked) active.push(cb.value);
    });
    return active;
  }

  // ---------- filtri benchmark / RAW intrappàre ----------
  function getBenchmarkMode() {
    const sel = document.getElementById('benchmarkType');
    return sel && sel.value ? sel.value : 'intraAppare';
  }

  function filterRawByCaseificioAndProvincia() {
    const base = Array.isArray(window.RAW) ? window.RAW : [];
    if (!base.length) {
      return { rows: [], nAziende: 0 };
    }

    const mode = getBenchmarkMode();
    if (mode !== 'intraAppare') {
      // per intracaseificio e regione, per ora non usiamo RAW
      return { rows: [], nAziende: 0 };
    }

    // nome caseificio dal selettore azienda (per ora CAO)
    const azSel = document.getElementById('aziendaSelect');
    let caseificioName = null;
    if (azSel && azSel.options && azSel.selectedIndex >= 0) {
      caseificioName = azSel.options[azSel.selectedIndex].textContent.trim();
    }

    let rows = base;
    if (caseificioName) {
      rows = rows.filter(r => {
        if (!r) return false;
        const c = String(r.Caseificio || '').trim();
        return c === caseificioName;
      });
    }

    // filtro provincia
    const provSel = document.getElementById('provinciaFilter');
    const provVal = provSel && provSel.value ? provSel.value : 'tutte';
    if (provVal !== 'tutte') {
      let provName = null;
      if (provVal === 'sassari')       provName = 'Sassari';
      else if (provVal === 'nuoro')    provName = 'Nuoro';
      else if (provVal === 'oristano') provName = 'Oristano';
      else if (provVal === 'cagliari') provName = 'Cagliari';

      if (provName) {
        rows = rows.filter(r => {
          if (!r) return false;
          return String(r.Provincia || '').trim() === provName;
        });
      }
    }

    const aziSet = new Set();
    for (const r of rows) {
      if (r && r.Azienda) aziSet.add(String(r.Azienda));
    }

    return { rows, nAziende: aziSet.size };
  }

  /**
   * Dati intrappàre:
   * 1) filtriamo per KPI
   * 2) aggreghiamo per (azienda, anno, mese) con media aritmetica
   * 3) per ogni (anno, mese) facciamo la media delle aziende
   * 4) torniamo righe {Anno, Mese, Valore} pronte per groupByLactation
   */
  function computeGroupMonthlyMeans(rawRows, kpiKey) {
    if (!Array.isArray(rawRows) || !rawRows.length) return [];

    const aliases = getAliasesFor(kpiKey);

    const aziYM = new Map(); // "Azienda|Anno|Mese" -> [valori]

    for (const r of rawRows) {
      if (!r) continue;

      const k = String(r.KPI || '').toLowerCase();
      if (!aliases.includes(k)) continue;

      let anno, mese;
      if (r.Anno != null && r.Mese != null) {
        anno = Number(r.Anno);
        mese = Number(r.Mese);
      } else if (r.Data) {
        const d = new Date(r.Data);
        if (!Number.isFinite(d.getTime())) continue;
        anno = d.getFullYear();
        mese = d.getMonth() + 1;
      } else {
        continue;
      }

      const val = Number(r.Valore);
      if (!Number.isFinite(val)) continue;

      const az = String(r.Azienda || '');
      const key = az + '|' + anno + '|' + mese;
      if (!aziYM.has(key)) aziYM.set(key, []);
      aziYM.get(key).push(val);
    }

    // media per (azienda, anno, mese)
    const ymValues = new Map(); // "Anno|Mese" -> [media_azienda]
    aziYM.forEach((vals, key) => {
      const mAzi = arithmeticMean(vals);
      if (mAzi == null) return;
      const parts = key.split('|');
      const anno = Number(parts[1]);
      const mese = Number(parts[2]);
      const ymKey = anno + '|' + mese;
      if (!ymValues.has(ymKey)) ymValues.set(ymKey, []);
      ymValues.get(ymKey).push(mAzi);
    });

    const out = [];
    ymValues.forEach((vals, ymKey) => {
      const mediaGruppo = arithmeticMean(vals);
      if (mediaGruppo == null) return;
      const parts = ymKey.split('|');
      out.push({
        Anno: Number(parts[0]),
        Mese: Number(parts[1]),
        Valore: mediaGruppo
      });
    });

    return out;
  }

  // ---------- costruzione dati per il grafico KPI ----------
  /**
   * Prepara labels e datasets per il grafico KPI:
   *  - serie CAO (cisterna caseificio) da window.CAO / CAO_RAW
   *  - opzionalmente serie "media gruppo" calcolata da RAW (data.json) quando benchmarkType = intraAppare
   */
  function buildKpiData() {
    // Senza dati CAO non ha senso disegnare nulla
    if (!window.CAO || !Array.isArray(window.CAO_RAW)) {
      return { labels: LATT_MONTH_LABELS, datasets: [], nAziende: 0, unit: '' };
    }

    const kpi = getSelectedKpi();
    const unit = getKpiUnit(kpi);

    // dati della cisterna del caseificio CAO
    const rowsCao = window.CAO.filter({ kpi, caseificio: 'CAO' });
    if (!rowsCao.length) {
      return { labels: LATT_MONTH_LABELS, datasets: [], nAziende: 0, unit };
    }

    const lactMapCao = groupByLactation(rowsCao);

    // Costruisco UNA sola volta le checkbox delle lattazioni (con regola "minimo 4 mesi")
    if (!yearBoxesInitialized) {
      ensureYearBoxes(lactMapCao);
    }

    const activeKeys = getActiveLactationKeys();
    // Se l'utente spegne tutto, grafico vuoto
    if (!activeKeys.length) {
      return {
        labels: LATT_MONTH_LABELS,
        datasets: [],
        nAziende: 0,
        unit
      };
    }

    // Serie CAO (una per lattazione attiva)
    const datasets = [];
    activeKeys.forEach((key, idx) => {
      const l = lactMapCao[key];
      if (!l) return;

      const color = LAC_COLOR_MAP[key] || LAC_COLORS[idx % LAC_COLORS.length];

      datasets.push({
        label: l.label + ' – CAO',
        data: l.values,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 3,
        pointHoverRadius: 4,
        spanGaps: true,
        _seriesType: 'caseificio'
      });
    });

    // Serie "media gruppo" intra-appàre (dati RAW), solo se modalita intraAppare
    let nAziende = 0;
    const mode = getBenchmarkMode();
    if (mode === 'intraAppare' && Array.isArray(window.RAW) && window.RAW.length) {
      const { rows, nAziende: nAz } = filterRawByCaseificioAndProvincia();
      nAziende = nAz;

      if (rows.length && nAziende > 0) {
        // media mensile del gruppo → groupByLactation come per CAO
        const groupMonthly = computeGroupMonthlyMeans(rows, kpi);
        const lactMapGroup = groupByLactation(groupMonthly);

        const medianToggle = document.getElementById('showMedian');
        const showGroup    = !medianToggle || !!medianToggle.checked;

        activeKeys.forEach((key, idx) => {
          const lg = lactMapGroup[key];
          if (!lg) return;

          const color = LAC_COLOR_MAP[key] || LAC_COLORS[idx % LAC_COLORS.length];

          datasets.push({
            label: lg.label + ' – media gruppo',
            data: lg.values,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 0,
            borderDash: [5, 4],
            spanGaps: true,
            hidden: !showGroup,
            _seriesType: 'group'
          });
        });
      }
    }

    return {
      labels: LATT_MONTH_LABELS,
      datasets,
      nAziende,
      unit
    };
  }

  // ---------- titolo (uno solo, con N aziende) ----------
  function updateTitle(nAziende) {
    const card = document.querySelector('#kpiChartHost')?.closest('.card');
    if (!card) return;

    const titleEl  = card.querySelector('.card-title');
    const legendEl = card.querySelector('.legend');

    if (titleEl) {
      if (nAziende && nAziende > 0) {
        titleEl.textContent = 'Valore KPI: Caseificio vs media del gruppo di ' + nAziende + ' aziende';
      } else {
        // quando non abbiamo ancora RAW o non siamo in intraAppare
        titleEl.textContent = 'Valore KPI: Caseificio';
      }
    }

    // niente secondo titolo: lasciamo la legend vuota
    if (legendEl) {
      legendEl.textContent = '';
    }
  }

  // ---------- render grafico KPI ----------
  function renderKpiChart() {
    const canvas = document.querySelector('#kpiChartHost canvas');
    if (!canvas || !canvas.getContext || typeof Chart === 'undefined') return;

    const ctx = canvas.getContext('2d');

    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (kpiChart) {
      kpiChart.destroy();
      kpiChart = null;
    }

    const cfg = buildKpiData();
    updateTitle(cfg.nAziende);

    kpiChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: cfg.labels,
        datasets: cfg.datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            top: 10,
            bottom: 0
          }
        },
        plugins: {
          // niente legenda standard: le checkbox + pallino sono la legenda
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              label(context) {
                const v = context.parsed.y;
                if (v == null) return '';
                const dsLabel = context.dataset.label || '';
                if (!cfg.unit) {
                  return `${dsLabel}: ${v.toFixed(3)}`;
                }
                return `${dsLabel}: ${v.toFixed(3)} ${cfg.unit}`;
              }
            }
          }
        },
        scales: {
          x: {
            title: {
              display: false,
              text: ''
            },
            ticks: {
              autoSkip: false
            }
          },
          y: {
            title: {
              display: !!cfg.unit,
              text: cfg.unit || ''
            },
            beginAtZero: false
          }
        }
      }
    });
  }

  // Per ora lascio un placeholder per l’istogramma (a destra)
  function renderEmptyHist() {
    const canvas = document.querySelector('#histChartHost canvas');
    if (!canvas || !canvas.getContext || typeof Chart === 'undefined') return;

    const ctx = canvas.getContext('2d');
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (histChart) {
      histChart.destroy();
      histChart = null;
    }

    histChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Distribuzione campione (in arrivo)',
          data: []
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            display: false
          },
          y: {
            display: false
          }
        }
      }
    });
  }

  // ---------- binding UI ----------
  function bindUi() {
    // cambio KPI
    const kpiSel = document.getElementById('indicatore');
    if (kpiSel) {
      kpiSel.addEventListener('change', () => {
        renderKpiChart();
      });
    }

    // cambio tipo di benchmark o provincia o caseificio
    ['benchmarkType', 'provinciaFilter', 'aziendaSelect'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => {
          renderKpiChart();
        });
      }
    });

    // cambio lattazioni (delegato: checkbox nel container .year-boxes)
    document.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLInputElement)) return;
      const container = t.closest('#view-conf .year-boxes');
      if (!container) return;
      if (t.type === 'checkbox') {
        renderKpiChart();
      }
    });

    // toggle media gruppo (usa la checkbox "Mostra mediana", già presente)
    const medianToggle = document.getElementById('showMedian');
    if (medianToggle) {
      medianToggle.addEventListener('change', () => {
        if (!kpiChart) return;
        const showGroup = !!medianToggle.checked;
        kpiChart.data.datasets.forEach(ds => {
          if (ds._seriesType === 'group') {
            ds.hidden = !showGroup;
          }
        });
        kpiChart.update();
      });
    }

    // cambio preset istogramma (per ora solo placeholder)
    const presetSel = document.getElementById('distPreset');
    if (presetSel) {
      presetSel.addEventListener('change', () => {
        renderEmptyHist();
      });
    }
  }

  function onCaoReady() {
    bindUi();
    renderKpiChart();
    renderEmptyHist();
  }

  function init() {
    // ascolta il caricamento di RAW (data.json) per aggiornare la media del gruppo
    document.addEventListener('raw:loaded', () => {
      rawReady = true;
      // Se il grafico KPI esiste già, lo ricalcoliamo con la media del gruppo
      if (kpiChart) {
        renderKpiChart();
      }
    });

    // aspetta che il loader CAO abbia caricato i dati
    if (window.CAO_RAW && window.CAO_RAW.length) {
      onCaoReady();
    } else {
      document.addEventListener('cao:loaded', function handle() {
        document.removeEventListener('cao:loaded', handle);
        onCaoReady();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
