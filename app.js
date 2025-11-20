// ============================================================================
// APPÀRE - Dashboard Benchmark Allevatore
// File: app.js (VERSIONE STABILE)
//
// - Gestione stato applicazione (azienda, KPI, periodo istogramma)
// - Calcolo PR (percentile rank) per lattazioni
// - Grafico KPI (valori assoluti + mediana altre aziende)
// - Istogramma distribuzione per KPI e periodo (lattazione/intervallo personalizzato)
// - Selettori dinamici: azienda, tipo benchmark, provincia, periodo istogramma
// ============================================================================


// ============================================================================
// CONFIGURAZIONE KPI E COSTANTI
// ============================================================================

/**
 * Mappa dei nomi KPI logici → alias presenti nel dataset.
 * Serve per filtrare le righe corrette da RAW.
 */
const KPI_ALIASES = {
  cellule:   ['cellule', 'scc', 'cellule somatiche', 'cellule somatiche (scc)'],
  carica:    ['carica', 'cbt', 'carica batterica', 'carica batterica (cbt)'],
  urea:      ['urea'],
  grassi:    ['grassi', 'fat', '% fat'],
  proteine:  ['proteine', 'protein', '% prot']
};

/**
 * Unità di misura per ciascun KPI, utilizzata nelle label degli assi.
 */
const KPI_UNITS = {
  cellule:   'cell/mL',
  carica:    'UFC/mL',
  urea:      'mg/dL',
  grassi:    '%',
  proteine:  '%'
};

/**
 * Etichette dei mesi per le lattazioni (Ottobre → Settembre).
 */
const LAC_MONTHS_IT = [
  'Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar',
  'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set'
];

/**
 * Esporto KPI_UNITS su window per l'utilizzo in mieiDati.js.
 */
window.KPI_UNITS = KPI_UNITS;


// ============================================================================
// STATO APPLICAZIONE
// ============================================================================

/**
 * Stato globale dell'app.
 * - currentLacStart: inizio lattazione correntemente selezionata (non usato direttamente ovunque)
 * - currentKpi: KPI selezionato (chiave logica: 'cellule', 'carica', ecc.)
 * - azienda: azienda attualmente selezionata dall'utente
 * - histPeriod: definisce il periodo usato nell'istogramma
 *     type: 'months' | 'lactation' | 'custom'
 *     - 'months': ultimi N mesi (valore in .value) [legacy]
 *     - 'lactation': una lattazione intera (Ott→Set), start = anno di inizio
 *     - 'custom': intervallo personalizzato (from/to = Date)
 */
var state = {
  currentLacStart: null,
  currentKpi:      'cellule',
  azienda:         'GOIA SILVIA',
  histPeriod:      { type: 'months', value: 12 }
};

/**
 * Dataset grezzo (raw) caricato da dataLoader.js (JSON).
 */
var RAW = [];

/**
 * Riferimenti ai grafici Chart.js:
 * - prChart: grafico PR per lattazioni
 * - kpiChart: grafico KPI (valori assoluti + mediana)
 * - histChart: istogramma distribuzione KPI
 */
var prChart, kpiChart, histChart;

/**
 * Flag per auto-selezionare la lattazione più recente alla prima inizializzazione.
 * Viene usato da updatePR per selezionare solo l'ultima lattazione al primo render.
 */
var didInitialLacAutoSelect = false;


// ============================================================================
// FUNZIONI DI FILTRO - BENCHMARK (IntraAppare / IntraCaseificio / Regione)
// ============================================================================

/**
 * Restituisce il dataset "di confronto" in base ai selettori:
 * - tipo benchmark (intraAppare / intraCaseificio / regione)
 * - provincia (filtro sul gruppo, ma l'azienda selezionata è sempre inclusa)
 *
 * NOTA:
 *  - RAW contiene tutti i campioni.
 *  - Per IntraCaseificio restringiamo al caseificio dell'azienda selezionata.
 *  - Per gli altri casi, al momento usiamo tutto il dataset.
 *  - In tutti i casi, i dati dell'azienda selezionata vengono sempre aggiunti
 *    anche se non rientrano nel filtro (p.es. provincia).
 */
function getBenchmarkRaw() {
  var base = Array.isArray(RAW) ? RAW : [];
  if (!base.length) return base;

  // Tipo di benchmark: IntraAppare / IntraCaseificio / Regione
  var sel  = document.getElementById('benchmarkType');
  var mode = sel && sel.value ? sel.value : 'intraAppare';

  var working = base;

  // IntraCaseificio → filtra solo i record del caseificio dell'azienda selezionata
  if (mode === 'intraCaseificio') {
    var azCase = state && state.azienda ? state.azienda : null;
    if (azCase) {
      var caseificio = null;

      for (var i = 0; i < base.length; i++) {
        var r0 = base[i];
        if (r0 && r0.Azienda === azCase && r0.Caseificio) {
          caseificio = r0.Caseificio;
          break;
        }
      }

      if (caseificio) {
        working = base.filter(function (r) {
          return r && r.Caseificio === caseificio;
        });
      }
    }
  }

  // Modalità 'intraAppare' e 'regione':
  // per ora usano tutto il dataset "base"
  // (in futuro 'regione' potrà includere anche dati extra-Laore)

  // Filtro per provincia: agisce sul gruppo di confronto
  var provSel = document.getElementById('provinciaFilter');
  var provVal = provSel && provSel.value ? provSel.value : 'tutte';
  if (provVal !== 'tutte') {
    var provName = null;
    if (provVal === 'sassari')       provName = 'Sassari';
    else if (provVal === 'nuoro')    provName = 'Nuoro';
    else if (provVal === 'oristano') provName = 'Oristano';
    else if (provVal === 'cagliari') provName = 'Cagliari';

    if (provName) {
      working = working.filter(function (r) {
        return r && r.Provincia === provName;
      });
    }
  }

  // Aggiungiamo sempre i record dell'azienda selezionata,
  // anche se non rientrano nel filtro di provincia.
  var az = state && state.azienda ? state.azienda : null;
  if (!az) return working;

  var hasAz = false;
  for (var j = 0; j < working.length; j++) {
    var r1 = working[j];
    if (r1 && r1.Azienda === az) {
      hasAz = true;
      break;
    }
  }
  if (hasAz) return working;

  // Se l'azienda non era nel gruppo filtrato, le uniamo i suoi record.
  var azRows = base.filter(function (r) {
    return r && r.Azienda === az;
  });

  return working.concat(azRows);
}


// ============================================================================
// KPI UTILITY E AGGREGAZIONI
// ============================================================================

/**
 * Per alcuni KPI un valore più basso è migliore (cellule, carica).
 */
function lowerIsBetter(k) {
  return k === 'cellule' || k === 'carica';
}

/**
 * KPI che vanno considerati su scala logaritmica (cellule, carica).
 */
function isLogKPI(k) {
  return k === 'cellule' || k === 'carica';
}

/**
 * Media aritmetica su un array di valori numerici (ignorando NaN/non finiti).
 */
function aggArithmetic(values) {
  var s = 0;
  var n = 0;
  for (var v of values) {
    if (isFinite(v)) {
      s += v;
      n++;
    }
  }
  return n ? s / n : null;
}

/**
 * Media geometrica su un array di valori numerici (solo > 0).
 * Utilizzata per KPI in scala log (cellule, carica).
 */
function aggGeometric(values) {
  var s = 0;
  var n = 0;
  for (var v of values) {
    if (isFinite(v) && v > 0) {
      s += Math.log(v);
      n++;
    }
  }
  return n ? Math.exp(s / n) : null;
}

/**
 * Estrae da RAW le righe relative al KPI logico k.
 * Converte Anno/Mese in year/month (0..11) e Valore in value.
 */
function rowsForKpi(raw, k) {
  var aliases = KPI_ALIASES[k] || [k];
  var out = [];

  for (var r of raw) {
    if (aliases.indexOf(String(r.KPI).toLowerCase()) !== -1) {
      var y = +r.Anno;
      var m = (+r.Mese) - 1;
      var v = +r.Valore;
      if (isFinite(v) && !isNaN(y) && !isNaN(m)) {
        out.push({ Azienda: r.Azienda, year: y, month: m, value: v });
      }
    }
  }
  return out;
}

/**
 * Aggiorna il testo "confronto su X aziende" sopra il grafico PR.
 */
function updateBenchmarkCountLabel(rows) {
  var el = document.getElementById('benchmarkCount');
  if (!el) return;

  var set = new Set();
  if (Array.isArray(rows)) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r && r.Azienda) set.add(String(r.Azienda));
    }
  }
  var n = set.size;

  if (!n) {
    el.textContent = '';
  } else if (n === 1) {
    el.textContent = '– al momento sei l\'unica azienda nel gruppo di confronto';
  } else {
    el.textContent = '– confronto su ' + n + ' aziende';
  }
}

/**
 * Mostra, in modalità IntraCaseificio, il nome del caseificio
 * a cui appartiene l'azienda selezionata.
 */
function updateCaseificioLabel() {
  var el = document.getElementById('caseificioLabel');
  if (!el) return;

  var modeSel = document.getElementById('benchmarkType');
  var mode = modeSel && modeSel.value ? modeSel.value : 'intraAppare';

  // Mostriamo il caseificio solo in modalità IntraCaseificio
  if (mode !== 'intraCaseificio') {
    el.textContent = '';
    return;
  }

  var az = state && state.azienda ? state.azienda : null;
  if (!az || !Array.isArray(RAW) || !RAW.length) {
    el.textContent = '';
    return;
  }

  var caseificio = null;
  for (var i = 0; i < RAW.length; i++) {
    var r = RAW[i];
    if (r && r.Azienda === az && r.Caseificio) {
      caseificio = r.Caseificio;
      break;
    }
  }

  el.textContent = caseificio ? 'Caseificio: ' + caseificio : '';
}

/**
 * Aggrega i campioni su base mensile per (Anno, Mese, Azienda)
 * usando media aritmetica o geometrica a seconda del KPI.
 */
function monthlyAggregate(rawRows, kpi) {
  var byKey = new Map();
  var useGeo = isLogKPI(kpi);

  for (var r of rawRows) {
    var key = r.year + '|' + r.month + '|' + r.Azienda;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r.value);
  }

  var out = [];
  byKey.forEach((vals, keyStr) => {
    var parts = keyStr.split('|');
    var y  = +parts[0];
    var m  = +parts[1];
    var az = parts[2];
    var agg = useGeo ? aggGeometric(vals) : aggArithmetic(vals);
    if (agg != null) out.push({ Azienda: az, year: y, month: m, value: agg });
  });

  return out;
}

/**
 * Percentile Rank di v rispetto all'array arr.
 * Restituisce un intero 0..100 (approx).
 */
function percentileRank(arr, v) {
  var nums = arr
    .filter(x => typeof x === 'number' && !isNaN(x))
    .sort((a, b) => a - b);

  if (!nums.length || typeof v !== 'number' || isNaN(v)) return null;

  var count = 0;
  var ties  = 0;
  for (var x of nums) {
    if (x < v) count++;
    else if (x === v) ties++;
  }
  return Math.round(((count + 0.5 * ties) / nums.length) * 100);
}

/**
 * Mediana di un array numerico (ignorando non finiti).
 */
function median(arr) {
  var a = arr.filter(x => isFinite(x)).sort((x, y) => x - y);
  var n = a.length;
  if (!n) return null;
  var m = Math.floor(n / 2);
  return (n % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
}


// ============================================================================
// CACHE YM (anno-mese → Map(Azienda, valore aggregato))
// ============================================================================

/**
 * Cache: per ogni KPI logico memorizziamo la mappa YM:
 *  key = 'year-month'
 *  value = { year, month, by: Map(Azienda, valore_aggregato) }
 */
var cache = {
  ymByKpi: new Map()
};

/**
 * Restituisce (o costruisce) la mappa YM per un dato KPI.
 */
function getYMMap(kpiRows, kpiKey) {
  var key = kpiKey;
  if (cache.ymByKpi.has(key)) return cache.ymByKpi.get(key);

  var agg = monthlyAggregate(kpiRows, key);
  var m   = new Map();

  for (var r of agg) {
    var mapKey = r.year + '-' + r.month;
    if (!m.has(mapKey)) {
      m.set(mapKey, {
        year: r.year,
        month: r.month,
        by: new Map()
      });
    }
    m.get(mapKey).by.set(r.Azienda, r.value);
  }

  cache.ymByKpi.set(key, m);
  return m;
}


// ============================================================================
// LATTATIONI E UTILITIES TEMPORALI
// ============================================================================

/**
 * Restituisce l'anno corrente.
 */
function todayY() {
  return new Date().getFullYear();
}

/**
 * Restituisce il mese corrente (0..11).
 */
function todayM() {
  return new Date().getMonth();
}

/**
 * Anno di inizio della lattazione corrente (Ott→Set).
 */
function currentLactationStart() {
  var m = todayM();
  var y = todayY();
  return (m >= 9) ? y : (y - 1);
}

/**
 * Le ultime tre lattazioni basate sulla data odierna (non usato più qui, mantenuto per completezza).
 */
function lastThreeLactations() {
  var s = currentLactationStart();
  return [s - 2, s - 1, s];
}

/**
 * Label visuale per una lattazione: "YYYY-YY"
 */
function lactationLabel(yStart) {
  var yEnd = (yStart + 1).toString().slice(-2);
  return yStart + '-' + yEnd;
}

/**
 * Posizione (0..11) di un mese (0..11) all'interno della lattazione (Ott→Set).
 * Ott(9) → 0, Nov(10) → 1, ..., Set(8) → 11
 */
function lacPosFromMonth(m) {
  return (m + 3) % 12;
}

/**
 * Ultime 3 lattazioni presenti nei dati per l'azienda corrente.
 * Considera solo i mesi dove l'azienda ha dati, e costruisce la lattazione:
 *  - Ott–Dic → anno stesso
 *  - Gen–Set → anno-1
 */
function getLactationStartsFromRows(rows) {
  var set = new Set();
  var az  = state.azienda;

  for (var r of rows) {
    if (!r || r.Azienda !== az) continue;
    var y = r.year;
    var m = r.month; // 0..11
    if (!Number.isFinite(y) || !Number.isFinite(m)) continue;

    var yStart = (m >= 9) ? y : (y - 1);
    set.add(yStart);
  }

  // Ordina e restituisce solo le ultime 3 lattazioni
  return Array.from(set)
    .sort((a, b) => a - b)
    .slice(-3);
}


// ============================================================================
// CHARTS (PR, KPI, ISTOGRAMMA) - SETUP
// ============================================================================

/**
 * Plugin personalizzato: disegna una linea orizzontale in corrispondenza del
 * punto attivo (hover) sui grafici a linee.
 */
var HoverLine = {
  id: 'hoverLine',
  afterDatasetsDraw(chart) {
    var a = chart.getActiveElements();
    if (!a || !a.length) return;

    var ca  = chart.chartArea;
    var y   = a[0].element.y;
    var ctx = chart.ctx;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ca.left, y);
    ctx.lineTo(ca.right, y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(51,65,85,0.8)';
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();
  }
};

// Registrazione plugin Chart.js (annotazioni + linea hover)
Chart.register(window['chartjs-plugin-annotation'], HoverLine);

/**
 * Crea e inizializza i tre grafici Chart.js:
 * - prChart: PR per lattazione
 * - kpiChart: KPI e mediana
 * - histChart: istogramma distribuzione KPI
 */
function ensureCharts() {
  // ----- Grafico PR (percentile rank per lattazione) -----
  prChart = new Chart(
    document.querySelector('#prChartHost canvas').getContext('2d'),
    {
      type: 'line',
      data: { labels: LAC_MONTHS_IT, datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 0 },
        scales: {
          x: {
            type: 'category',
            labels: LAC_MONTHS_IT
          },
          y: {
            min: 0,
            max: 100,
            ticks: { stepSize: 20 }
          },
          // Asse fittizio padL per allineare larghezze Y tra PR e KPI
          padL: {
            position: 'left',
            grid: { display: false, drawTicks: false },
            ticks: { display: false },
            display: true,
            afterFit: (scale) => {
              scale.width = (scale && scale.chart && scale.chart.__padLeft) || 0;
            }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          annotation: {
            annotations: {
              low: {
                type: 'box',
                yMin: 0,
                yMax: 24,
                backgroundColor: 'rgba(239,68,68,.12)',
                borderWidth: 0
              },
              mid: {
                type: 'box',
                yMin: 25,
                yMax: 74,
                backgroundColor: 'rgba(245,158,11,.12)',
                borderWidth: 0
              },
              high: {
                type: 'box',
                yMin: 75,
                yMax: 100,
                backgroundColor: 'rgba(34,197,94,.12)',
                borderWidth: 0
              },
              t40: {
                type: 'line',
                yMin: 25,
                yMax: 25,
                borderColor: 'rgba(15,23,42,.35)',
                borderDash: [6, 6],
                borderWidth: 1
              },
              t75: {
                type: 'line',
                yMin: 75,
                yMax: 75,
                borderColor: 'rgba(15,23,42,.35)',
                borderDash: [6, 6],
                borderWidth: 1
              },
              medianLine: {
                type: 'line',
                yMin: 50,
                yMax: 50,
                borderColor: 'rgba(220,38,38,0.95)',
                borderWidth: 1.5,
                borderDash: [4, 2],
                label: {
                  display: true,
                  content: 'Mediana (50%)',
                  position: 'end',
                  color: '#dc2626',
                  font: { weight: 'bold', size: 10 }
                }
              }
            }
          }
        },
        elements: {
          line: { tension: 0.3 },
          point: { radius: 3 }
        }
      }
    }
  );

  // ----- Grafico KPI (serie azienda + mediana gruppo per lattazione) -----
  kpiChart = new Chart(
    document.querySelector('#kpiChartHost canvas').getContext('2d'),
    {
      type: 'line',
      data: { labels: LAC_MONTHS_IT, datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 0 },
        scales: {
          x: {
            type: 'category',
            labels: LAC_MONTHS_IT
          },
          y: {
            beginAtZero: false,
            grace: '5%',
            title: { display: false, text: '' }
          },
          padL: {
            position: 'left',
            grid: { display: false, drawTicks: false },
            ticks: { display: false },
            display: true,
            afterFit: (scale) => {
              scale.width = (scale && scale.chart && scale.chart.__padLeft) || 0;
            }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          annotation: { annotations: {} }
        },
        elements: {
          line: { tension: 0.3 },
          point: { radius: 3 }
        }
      }
    }
  );

  // ----- Istogramma (distribuzione valori KPI) -----
  histChart = new Chart(
    document.querySelector('#histChartHost canvas').getContext('2d'),
    {
      type: 'bar',
      data: {
        datasets: [{
          label: 'Frequenza %',
          data: [],
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          backgroundColor: 'rgba(2,132,199,.25)',
          borderColor: '#0284c7'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 0 },
        scales: {
          x: {
            type: 'linear',
            title: { display: false, text: '' }
          },
          y: {
            beginAtZero: true,
            ticks: { callback: v => v + '%' }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          annotation: { annotations: {} }
        }
      }
    }
  );
}


// ============================================================================
// ALLINEAMENTO ROBUSTO LARGHEZZA ASSE Y (PR vs KPI)
// ============================================================================

/**
 * Memorizza la larghezza target dell'asse Y in px.
 * Non riduciamo mai questo valore all'interno dello stesso KPI
 * per evitare saltellamenti del layout.
 */
let _leftLockWidth = 0;

/**
 * Allinea la larghezza dell'asse Y (in px) tra PR e KPI.
 */
function equalizeByYAxisWidth() {
  if (!prChart || !kpiChart) return;

  var prY  = prChart.scales && prChart.scales.y;
  var kpiY = kpiChart.scales && kpiChart.scales.y;
  if (!prY || !kpiY) return;

  var wPR  = prY.width || 0;
  var wKPI = kpiY.width || 0;

  // Target: massimo di (lock, wPR, wKPI)
  var target = Math.max(_leftLockWidth || 0, wPR, wKPI);
  _leftLockWidth = target;

  // Pad fittizio per raggiungere la stessa larghezza di asse Y
  prChart.__padLeft  = Math.max(0, target - wPR);
  kpiChart.__padLeft = Math.max(0, target - wKPI);

  prChart.update('none');
  kpiChart.update('none');
}

/**
 * Usa due requestAnimationFrame per attendere layout/ticks,
 * quindi richiama equalizeByYAxisWidth.
 */
let _syncA = null;
let _syncB = null;

function scheduleSync() {
  if (_syncA) cancelAnimationFrame(_syncA);
  if (_syncB) cancelAnimationFrame(_syncB);

  _syncA = requestAnimationFrame(() => {
    _syncB = requestAnimationFrame(() => {
      equalizeByYAxisWidth();
    });
  });
}


// ============================================================================
// LEGENDA HTML A DESTRA DEL TITOLO KPI
// ============================================================================

/**
 * Crea una leggenda HTML minimal (linea continua vs tratteggiata)
 * accanto al titolo del grafico KPI, mostrando:
 *  - Azienda
 *  - Mediana (altre aziende)
 */
function ensureKpiStyleLegend() {
  var host = document.getElementById('kpiChartHost');
  var head = host ? host.previousElementSibling : null;
  if (!head) return;

  var oldColored = head.querySelector('.legend');
  if (oldColored) oldColored.remove();

  var oldSimple = head.querySelector('#kpiLegendSimple');
  if (oldSimple) oldSimple.remove();

  head.style.display = 'flex';
  head.style.alignItems = 'center';
  head.style.gap = head.style.gap || '12px';

  var title = head.querySelector('.card-title');
  if (!title) return;

  var medianWrap = document.getElementById('showMedian')?.parentElement || null;

  var legend = document.createElement('div');
  legend.id = 'kpiLegendSimple';
  legend.style.display = 'inline-flex';
  legend.style.alignItems = 'center';
  legend.style.gap = '14px';
  legend.style.fontSize = '12px';
  legend.style.color = '#334155';

  function item(label, dashed) {
    var w = document.createElement('span');
    w.style.display = 'inline-flex';
    w.style.alignItems = 'center';
    w.style.gap = '6px';

    var ln = document.createElement('span');
    ln.style.display = 'inline-block';
    ln.style.width = '28px';
    ln.style.height = '0';
    ln.style.borderTop = dashed
      ? '2px dashed currentColor'
      : '2px solid currentColor';

    var tx = document.createElement('span');
    tx.textContent = label;

    w.appendChild(ln);
    w.appendChild(tx);
    return w;
  }

  legend.appendChild(item('Azienda', false));
  legend.appendChild(item('Mediana (altre aziende)', true));

  if (medianWrap) {
    head.insertBefore(legend, medianWrap);
  } else {
    head.appendChild(legend);
  }
}


// ============================================================================
// SELETTORE AZIENDA (DINAMICO DA RAW)
// ============================================================================

/**
 * Crea (se non esiste) e popola il <select> delle aziende,
 * posizionandolo dove prima veniva mostrata la label dell'azienda.
 *
 * Il change handler:
 *  - aggiorna state.azienda
 *  - resetta la cache YM
 *  - ricalcola PR, KPI, istogramma
 *  - ricostruisce il menu lattazioni istogramma (preservando la lattazione se possibile)
 */
function ensureAziendaSelector() {
  try {
    // Trova il contenitore dove inserire il select dell'azienda
    function findLabelHost() {
      var idCandidates = ['aziendaLabel', 'aziendaTitle', 'aziendaName', 'aziendaBadge'];
      for (var id of idCandidates) {
        var el = document.getElementById(id);
        if (el) return el;
      }

      var role = document.querySelector('[data-role="azienda-label"]');
      if (role) return role;

      var cls = document.querySelector('.azienda-label, .aziendaName, .azienda, .az-label');
      if (cls) return cls;

      // Fallback: un heading/span/div che contenga il nome corrente
      var pool = document.querySelectorAll('h1,h2,h3,h4,span,strong,div');
      for (var el2 of pool) {
        var t = (el2.textContent || '').trim();
        if (t === state.azienda) return el2;
      }

      // Fallback finale: barra superiore
      var topbar = document.getElementById('topbar') || document.querySelector('.topbar,.header,.toolbar');
      if (topbar) return topbar;
      return null;
    }

    var host = findLabelHost();
    if (!host) return;

    // Crea o recupera il <select> aziende
    var sel = document.getElementById('aziendaSelect');
    if (!sel) {
      sel = document.createElement('select');
      sel.id = 'aziendaSelect';
      sel.style.fontSize = '13px';
      sel.style.padding = '4px 8px';
      sel.style.border = '1px solid #cbd5e1';
      sel.style.borderRadius = '8px';
      sel.style.background = '#fff';
      sel.style.color = '#0f172a';
      sel.title = 'Seleziona azienda';

      var wrap = document.createElement('span');
      wrap.style.display = 'inline-flex';
      wrap.style.gap = '8px';
      wrap.style.alignItems = 'center';

      var hadOnlyText =
        host.childNodes.length === 1 &&
        host.firstChild &&
        host.firstChild.nodeType === 3;

      if (hadOnlyText) {
        var lab = document.createElement('span');
        lab.textContent = 'Azienda:';
        lab.style.fontWeight = '600';
        lab.style.color = '#334155';
        wrap.appendChild(lab);
        wrap.appendChild(sel);
        host.textContent = '';
        host.appendChild(wrap);
      } else {
        host.appendChild(sel);
        host.style.display = host.style.display || 'inline-flex';
        host.style.gap = host.style.gap || '8px';
        host.style.alignItems = host.style.alignItems || 'center';
      }
    }

    // Popola aziende uniche da RAW
    var set = new Set();
    for (var r of RAW) {
      if (r && r.Azienda) set.add(String(r.Azienda));
    }

    var list = Array.from(set).sort((a, b) =>
      a.localeCompare(b, 'it', { sensitivity: 'base' })
    );

    // Mantieni selezione corrente se possibile
    var current = (state.azienda && list.includes(state.azienda))
      ? state.azienda
      : (list[0] || state.azienda);

    state.azienda = current;

    // Ricostruisci options solo se diverso da quello già presente
    var existing = Array.from(sel.options).map(o => o.value);
    var same =
      existing.length === list.length &&
      existing.every((v, i) => v === list[i]);

    if (!same) {
      sel.innerHTML = '';
      for (var name of list) {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
    }

    sel.value = state.azienda;

    // Change handler (solo una volta)
    if (!sel._bound) {
      sel.addEventListener('change', () => {
        state.azienda = sel.value;
        updateCaseificioLabel();

        // YM dipende anche dall'azienda → svuota la cache
        if (cache && cache.ymByKpi && cache.ymByKpi.clear) {
          cache.ymByKpi.clear();
        }

        var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
        updateBenchmarkCountLabel(rows);
        updatePR(rows);
        updateKPI(rows);

        // Ricostruisce il menu delle lattazioni dell'istogramma
        // preservando la selezione se possibile.
        rebuildLactationMenu(true);
        updatePeriodUIFromState();
        updateHistogram(rows);
        scheduleSync();
      });
      sel._bound = true;
    }
  } catch (e) {
    console.warn('ensureAziendaSelector error', e);
  }
}


// ============================================================================
// UPDATE PR (GRAFICO PERCENTILE RANK)
// ============================================================================

/**
 * Aggiorna il grafico PR (linea 0–100%) per le lattazioni selezionate.
 * - Usa getLactationStartsFromRows per trovare le ultime 3 lattazioni reali.
 * - Le check-box yr2023/yr2024/yr2025 vengono legate dinamicamente alle lattazioni reali.
 * - Alla prima chiamata, abilita solo l'ultima lattazione disponibile.
 */
function updatePR(rows) {
  var by = getYMMap(rows, state.currentKpi);

  // Lattazioni reali (ultime 3) per l'azienda corrente
  var lacStarts = getLactationStartsFromRows(rows);
  var palette   = ['#3b82f6', '#f59e0b', '#22c55e'];

  // Mappa checkbox (yr2023, yr2024, yr2025) → anno di inizio lattazione
  var ids = ['yr2023', 'yr2024', 'yr2025'];
  var map = ids.map((id, idx) => [id, lacStarts[idx]]);

  var colors = {};
  lacStarts.forEach((y, idx) => {
    colors[y] = palette[idx] || '#64748b';
  });

  // Aggiorna label, colore e visibilità delle checkbox
  map.forEach(([id, yStart]) => {
    var inp = document.getElementById(id);
    var lab = document.querySelector('label[for="' + id + '"]');

    if (!lab && inp && inp.parentElement && inp.parentElement.tagName.toLowerCase() === 'label') {
      lab = inp.parentElement;
    }

    if (!yStart || !inp || !lab) {
      // Nessuna lattazione associata → nascondi/azzera
      if (lab) lab.style.display = 'none';
      if (inp) {
        inp.checked  = false;
        inp.disabled = true;
      }
      var labSpanEmpty = document.getElementById(id + 'Lbl');
      if (labSpanEmpty) labSpanEmpty.textContent = '';
      return;
    }

    // Lattazione valida → mostra e abilita
    inp.disabled = false;
    lab.style.display = 'inline-flex';
    lab.style.alignItems = 'center';
    lab.style.gap = '6px';

    var labelTxt = lactationLabel(yStart);
    var color    = colors[yStart] || '#64748b';

    var labSpan = document.getElementById(id + 'Lbl');
    if (labSpan) labSpan.textContent = labelTxt;

    var old = lab.querySelector('[data-role="lac-swatch"]');
    if (old) old.remove();

    var dot = document.createElement('span');
    dot.setAttribute('data-role', 'lac-swatch');
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '999px';
    dot.style.background = color;
    dot.style.display = 'inline-block';
    dot.style.boxShadow = '0 0 0 1px rgba(0,0,0,.12) inset';

    var first = lab.firstElementChild;
    if (inp && first === inp) {
      inp.insertAdjacentElement('afterend', dot);
    } else {
      lab.insertBefore(dot, lab.firstChild);
    }
  });

  // Al primo render con dati, seleziona automaticamente solo l'ultima lattazione
  if (!didInitialLacAutoSelect) {
    var available = map.filter(([id, y]) => Number.isFinite(y));
    if (available.length) {
      // Spegni tutte le checkbox disponibili
      available.forEach(([id]) => {
        var el = document.getElementById(id);
        if (el && !el.disabled) el.checked = false;
      });
      // Accendi solo l'ultima lattazione
      var lastPair = available[available.length - 1];
      var lastId   = lastPair[0];
      var lastEl   = document.getElementById(lastId);
      if (lastEl && !lastEl.disabled) lastEl.checked = true;

      didInitialLacAutoSelect = true;
    }
  }

  // Lattazioni effettivamente selezionate
  var selected = map
    .filter(([id, y]) => {
      if (!Number.isFinite(y)) return false;
      var el = document.getElementById(id);
      return el && el.checked && !el.disabled;
    })
    .map(([id, y]) => y);

  // Nessuna trasformazione: PR cresce sempre verso l'alto
  var trans = v => v;

  var ds = [];
  for (var yStart of selected) {
    var arr = new Array(12).fill(null);

    // Ottobre–Dicembre dell'anno yStart
    for (var m = 9; m <= 11; m++) {
      var b1 = by.get(yStart + '-' + m);
      if (!b1) continue;
      var vals1 = Array.from(b1.by.values()).map(trans);
      var vAzi1 = b1.by.get(state.azienda);
      var tv1   = (vAzi1 != null) ? trans(vAzi1) : null;
      arr[lacPosFromMonth(m)] = percentileRank(vals1, tv1);
    }

    // Gennaio–Settembre dell'anno successivo
    for (var m2 = 0; m2 <= 8; m2++) {
      var b2 = by.get((yStart + 1) + '-' + m2);
      if (!b2) continue;
      var vals2 = Array.from(b2.by.values()).map(trans);
      var vAzi2 = b2.by.get(state.azienda);
      var tv2   = (vAzi2 != null) ? trans(vAzi2) : null;
      arr[lacPosFromMonth(m2)] = percentileRank(vals2, tv2);
    }

    ds.push({
      label: lactationLabel(yStart),
      data: arr,
      borderColor: colors[yStart] || '#64748b',
      backgroundColor: (colors[yStart] || '#64748b') + '22',
      spanGaps: true,
      _lacStart: yStart
    });
  }

  prChart.data.labels = LAC_MONTHS_IT;
  prChart.data.datasets = ds;

  // Sfondo PR (bande colorate) invertito se KPI è "lower is better"
  (function () {
    var isLower = lowerIsBetter(state.currentKpi);
    var annRoot = prChart.options?.plugins?.annotation;
    var ann     = annRoot?.annotations;
    if (ann && ann.low && ann.mid && ann.high) {
      ann.low.backgroundColor  = isLower ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
      ann.mid.backgroundColor  = 'rgba(245,158,11,0.12)';
      ann.high.backgroundColor = isLower ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)';
    }
  })();

  prChart.update('none');
  scheduleSync();
}


// ============================================================================
// UPDATE KPI (GRAFICO VALORI ASSOLUTI + MEDIANA)
// ============================================================================

/**
 * Aggiorna il grafico KPI:
 * - serie azienda (per lattazione)
 * - serie mediana gruppo (per lattazione)
 * - toggle "Mostra mediana" gestito senza ricalcolo (solo hidden su dataset)
 * - limiti normativi (SCC=1500, CBT=500) come linee di annotazione
 */
function updateKPI(rows) {
  var by = getYMMap(rows, state.currentKpi);

  // Lattazioni reali per l'azienda corrente
  var lacStarts = getLactationStartsFromRows(rows);
  var palette   = ['#3b82f6', '#f59e0b', '#22c55e'];
  var ids       = ['yr2023', 'yr2024', 'yr2025'];
  var map       = ids.map((id, idx) => [id, lacStarts[idx]]);

  var colorFor = {};
  lacStarts.forEach((y, idx) => {
    colorFor[y] = palette[idx] || '#64748b';
  });

  // Lattazioni selezionate (stesse checkbox usate per PR)
  var selected = map
    .filter(([id, y]) => {
      if (!Number.isFinite(y)) return false;
      var el = document.getElementById(id);
      return el && el.checked && !el.disabled;
    })
    .map(([_, y]) => y);

  // Toggle "Mostra mediana"
  var medianToggle = document.getElementById('showMedian');
  if (!medianToggle) {
    var hostHead = document.getElementById('kpiChartHost')?.previousElementSibling;
    if (hostHead) {
      var wrap = document.createElement('label');
      wrap.style.marginLeft = 'auto';
      wrap.style.fontSize = '13px';
      wrap.style.display = 'inline-flex';
      wrap.style.gap = '6px';
      wrap.style.alignItems = 'center';

      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = 'showMedian';
      chk.checked = true;

      var txt = document.createElement('span');
      txt.textContent = 'Mostra mediana';

      wrap.appendChild(chk);
      wrap.appendChild(txt);
      hostHead.appendChild(wrap);

      medianToggle = chk;

      // Invece di ricalcolare tutto, mostriamo/nascondiamo solo i dataset di tipo "median"
      chk.addEventListener('change', () => {
        var show = !!chk.checked;
        if (!kpiChart) return;

        kpiChart.data.datasets.forEach(ds => {
          if (ds._type === 'median') {
            ds.hidden = !show;
          }
        });

        kpiChart.update('none');
        scheduleSync();
      });
    }
  }

  var showMedian = medianToggle ? !!medianToggle.checked : true;

  // Costruzione dataset azienda + mediana per ogni lattazione selezionata
  var datasets = [];

  for (var yStart of selected) {
    var azi = new Array(12).fill(null);
    var med = new Array(12).fill(null);

    // Ott–Dic anno yStart
    for (var m = 9; m <= 11; m++) {
      var b = by.get(yStart + '-' + m);
      if (!b) continue;
      var vals = Array.from(b.by.values());
      azi[lacPosFromMonth(m)] = b.by.get(state.azienda) ?? null;
      med[lacPosFromMonth(m)] = median(vals);
    }

    // Gen–Set anno yStart+1
    for (var m2 = 0; m2 <= 8; m2++) {
      var b2 = by.get((yStart + 1) + '-' + m2);
      if (!b2) continue;
      var vals2 = Array.from(b2.by.values());
      azi[lacPosFromMonth(m2)] = b2.by.get(state.azienda) ?? null;
      med[lacPosFromMonth(m2)] = median(vals2);
    }

    var c = colorFor[yStart] || '#64748b';

    // Serie azienda
    datasets.push({
      label: lactationLabel(yStart) + ' – KPI',
      data: azi,
      borderColor: c,
      backgroundColor: c + '22',
      borderWidth: 2,
      spanGaps: true,
      pointRadius: 3,
      _type: 'kpi',
      _lacStart: yStart
    });

    // Serie mediana
    datasets.push({
      label: lactationLabel(yStart) + ' – Mediana',
      data: med,
      borderColor: c,
      backgroundColor: c + '10',
      borderWidth: 2,
      borderDash: [6, 4],
      spanGaps: true,
      pointRadius: 0,
      hidden: !showMedian,
      _type: 'median',
      _lacStart: yStart
    });
  }

  var unit = KPI_UNITS[state.currentKpi] || '';
  kpiChart.data.labels = LAC_MONTHS_IT;
  kpiChart.data.datasets = datasets;
  kpiChart.options.scales.y.title = {
    display: !!unit,
    text: unit
  };

  // Limiti normativi per SCC (cellule) e CBT (carica)
  (function () {
    if (!kpiChart?.options?.plugins?.annotation) return;
    var anns = {};

    if (state.currentKpi === 'cellule') {
      anns = {
        scc_limit: {
          type: 'line',
          yMin: 1500,
          yMax: 1500,
          borderColor: 'rgba(239,68,68,0.75)',
          borderWidth: 1,
          borderDash: [6, 6],
          label: {
            display: true,
            content: 'Limite 1500',
            position: 'end',
            backgroundColor: 'rgba(255,255,255,0.8)',
            color: '#111',
            font: { size: 10 }
          }
        }
      };
    } else if (state.currentKpi === 'carica') {
      anns = {
        cbt_limit: {
          type: 'line',
          yMin: 500,
          yMax: 500,
          borderColor: 'rgba(239,68,68,0.75)',
          borderWidth: 1,
          borderDash: [6, 6],
          label: {
            display: true,
            content: 'Limite 500',
            position: 'end',
            backgroundColor: 'rgba(255,255,255,0.8)',
            color: '#111',
            font: { size: 10 }
          }
        }
      };
    }

    kpiChart.options.plugins.annotation.annotations = anns;
  })();

  kpiChart.update('none');
  ensureKpiStyleLegend();
  ensureAziendaSelector();
  scheduleSync();
}


// ============================================================================
// UPDATE ISTOGRAMMA (DISTRIBUZIONE KPI PER PERIODO)
// ============================================================================

/**
 * Aggiorna l'istogramma:
 * - estrazione dei mesi in range (in base a state.histPeriod)
 * - aggregazione per azienda (media aritmetica o geometrica)
 * - calcolo bins con regola di Freedman-Diaconis
 * - disegno istogramma e linea verticale azienda con PR
 */
function updateHistogram(rows) {
  var by = getYMMap(rows, state.currentKpi);

  // Tutte le chiavi anno-mese presenti nel dataset (ordinato)
  var ymKeys = Array
    .from(by.keys())
    .map(k => {
      var parts = k.split('-').map(Number);
      return { y: parts[0], m: parts[1] };
    })
    .sort((a, b) => (a.y - b.y) || (a.m - b.m));

  if (!ymKeys.length) {
    histChart.data.datasets[0].data = [];
    histChart.update();
    var pbEmpty = document.getElementById('posBadge');
    if (pbEmpty) pbEmpty.textContent = '—° percentile';
    return;
  }

  // ----- Limita il range dei month-picker "from/to" ai mesi con dati dell'azienda corrente -----
  (function () {
    var az = state.azienda;
    var minD = null;
    var maxD = null;

    // Scorri la mappa by (year,month,byAziende) solo dove l'azienda ha dati
    by.forEach((obj) => {
      if (!obj || !obj.by || !obj.by.has(az)) return;
      var d = new Date(obj.year, obj.month, 1);
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    });

    var fmEl = document.getElementById('fromMonth');
    var tmEl = document.getElementById('toMonth');
    if (!fmEl || !tmEl || !minD || !maxD) return;

    function fmtMonth(d) {
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      return y + '-' + m;
    }

    var minStr = fmtMonth(minD);
    var maxStr = fmtMonth(maxD);

    fmEl.min = minStr;
    fmEl.max = maxStr;
    tmEl.min = minStr;
    tmEl.max = maxStr;

    // Se i valori correnti sono fuori range, riallinea
    if (fmEl.value && fmEl.value < minStr) fmEl.value = minStr;
    if (tmEl.value && tmEl.value > maxStr) tmEl.value = maxStr;
  })();

  // Data di fine (ultimo mese disponibile)
  var lastYM = ymKeys[ymKeys.length - 1];
  var maxD = new Date(lastYM.y, lastYM.m, 1);

  // Mesi compresi nel periodo selezionato (histPeriod)
  var inRangeMonths = [];

  if (state.histPeriod.type === 'months') {
    var minD = new Date(
      maxD.getFullYear(),
      maxD.getMonth() - (state.histPeriod.value - 1),
      1
    );
    for (var k of ymKeys) {
      var d = new Date(k.y, k.m, 1);
      if (d >= minD && d <= maxD) inRangeMonths.push(k);
    }
  } else if (state.histPeriod.type === 'lactation') {
    var y0 = Number(state.histPeriod.start);
    for (var k2 of ymKeys) {
      if ((k2.y === y0 && k2.m >= 9) || (k2.y === y0 + 1 && k2.m <= 8)) {
        inRangeMonths.push(k2);
      }
    }
  } else {
    // Intervallo personalizzato "custom"
    for (var k3 of ymKeys) {
      var d2 = new Date(k3.y, k3.m, 1);
      if (d2 >= state.histPeriod.from && d2 <= state.histPeriod.to) {
        inRangeMonths.push(k3);
      }
    }
  }

  // Aggregazione per azienda (media mesi in-range)
  var perAz = new Map();
  inRangeMonths.forEach(ym => {
    var b = by.get(ym.y + '-' + ym.m);
    if (!b) return;

    b.by.forEach((val, az) => {
      if (!isFinite(val)) return;
      if (!perAz.has(az)) perAz.set(az, []);
      perAz.get(az).push(val);
    });
  });

  var useGeo = isLogKPI(state.currentKpi);
  var vals   = [];
  var aziAgg = null;

  perAz.forEach((list, az) => {
    var agg = useGeo ? aggGeometric(list) : aggArithmetic(list);
    if (agg != null) {
      vals.push(agg);
      if (az === state.azienda) aziAgg = agg;
    }
  });

  if (!vals.length) {
    histChart.data.datasets[0].data = [];
    histChart.update();
    var pbNo = document.getElementById('posBadge');
    if (pbNo) pbNo.textContent = '—° percentile';
    return;
  }

  /**
   * Calcolo del numero di bins con regola di Freedman-Diaconis.
   * Limita il numero di bins tra 6 e 15 per evitare istogrammi "vuoti".
   */
  function freedmanBins(values) {
    var n = values.length;
    if (n < 2) return 6;

    var s = values.slice().sort((a, b) => a - b);
    var q1 = s[Math.floor(0.25 * (n - 1))];
    var q3 = s[Math.floor(0.75 * (n - 1))];
    var iqr = (q3 - q1);

    if (!isFinite(iqr) || iqr === 0) {
      iqr = (s[n - 1] - s[0]) / 4;
      if (!isFinite(iqr) || iqr === 0) iqr = 1;
    }

    var h    = 2 * iqr * Math.pow(n, -1 / 3);
    var bins = Math.ceil((s[n - 1] - s[0]) / (h || 1)) || 6;

    if (bins < 6)  bins = 6;
    if (bins > 15) bins = 15;

    return bins;
  }

  // Calcolo bins, min/max, centri e conteggi
  var bins = freedmanBins(vals);
  var mn   = Math.min(...vals);
  var mx   = Math.max(...vals);
  var centers;
  var counts;
  var step;

  if (mn === mx) {
    // Tutti i valori uguali: un unico bin centrato
    bins   = 1;
    step   = 1;
    centers = [mn];
    counts  = [vals.length];
  } else {
    step = (mx - mn) / bins;
    if (!isFinite(step) || step <= 0) step = 1;

    centers = [];
    for (var bIdx = 0; bIdx < bins; bIdx++) {
      centers.push(mn + (bIdx + 0.5) * step);
    }

    counts = new Array(bins).fill(0);
    for (var v of vals) {
      var idx = Math.floor((v - mn) / step);
      if (idx >= bins) idx = bins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
  }

  var total = counts.reduce((a, c) => a + c, 0) || 1;
  var data  = centers.map((c, i) => ({
    x: c,
    y: Math.round((counts[i] / total) * 1000) / 10
  }));

  // Percentile dell'azienda rispetto alla distribuzione
  var pr = percentileRank(vals, aziAgg);

  var unit = KPI_UNITS[state.currentKpi] || '';
  histChart.data.datasets[0].data = data;

  // Asse X, min/max "robusti" (se mn==mx espande leggermente)
  var axisMin = mn;
  var axisMax = mx;
  if (axisMin === axisMax) {
    axisMin = mn - 0.5;
    axisMax = mn + 0.5;
  }

  histChart.options.scales.x = {
    type: 'linear',
    min: axisMin,
    max: axisMax,
    title: { display: !!unit, text: unit }
  };

  // Linea verticale per l'azienda con etichetta PR
  histChart.options.plugins.annotation.annotations = (aziAgg != null)
    ? {
        azi: {
          type: 'line',
          xMin: aziAgg,
          xMax: aziAgg,
          borderColor: '#ef4444',
          borderWidth: 2,
          label: {
            enabled: true,
            content:
              'Azienda: ' +
              aziAgg.toFixed(2) +
              (unit ? (' ' + unit) : '') +
              ' (PR ' + pr + ')',
            rotation: 90,
            backgroundColor: 'rgba(239,68,68,0.15)',
            color: '#ef4444'
          }
        }
      }
    : {};

  histChart.update();

  var posBadge = document.getElementById('posBadge');
  if (posBadge) {
    posBadge.textContent = (pr != null) ? (pr + '° percentile') : '—° percentile';
  }
}


// ============================================================================
// PERIOD SELECTION (ISTOGRAMMA) - UI E LOGICA
// ============================================================================

// Riferimenti HTML principali per il periodo istogramma
let preset = null; // <select id="distPreset">
let wrap   = null; // contenitore pannello custom <div id="customPeriod">
let apply  = null; // pulsante "Applica" <button id="applyCustom">

/**
 * Ricostruisce il menu delle lattazioni per l'istogramma (select #distPreset).
 *
 * @param {boolean} preserveSelection
 *        - false → forza la selezione sull'ultima lattazione disponibile
 *        - true  → se possibile mantiene la lattazione/custom già selezionati
 */
function rebuildLactationMenu(preserveSelection = false) {
  if (!preset) return;

  var previousType  = state.histPeriod?.type;
  var previousStart = state.histPeriod?.start;

  // Ultime lattazioni reali dai dati dell'azienda corrente
  var rows     = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
  var lacStarts = getLactationStartsFromRows(rows);

  // Svuota e ricostruisci le opzioni del select
  preset.innerHTML = '';

  // Opzioni per le lattazioni disponibili
  for (var yStart of lacStarts) {
    if (!Number.isFinite(yStart)) continue;
    var opt = document.createElement('option');
    opt.value = 'lac:' + yStart;
    opt.textContent = 'Lattazione ' + lactationLabel(yStart);
    preset.appendChild(opt);
  }

  // Opzione intervallo personalizzato
  var optCustom = document.createElement('option');
  optCustom.value = 'custom';
  optCustom.textContent = 'Intervallo personalizzato';
  preset.appendChild(optCustom);

  // Se dobbiamo preservare la selezione precedente...
  if (preserveSelection) {
    // 1) Se prima era custom, rimaniamo in custom
    if (previousType === 'custom') {
      preset.value = 'custom';
      if (wrap) wrap.style.display = 'flex';
      // state.histPeriod (from/to) resta com'è
      return;
    }

    // 2) Se era una lattazione ancora disponibile, mantienila
    if (
      previousType === 'lactation' &&
      Number.isFinite(previousStart) &&
      lacStarts.includes(previousStart)
    ) {
      preset.value = 'lac:' + previousStart;
      state.histPeriod = { type: 'lactation', start: previousStart };
      if (wrap) wrap.style.display = 'none';
      return;
    }

    // Se arrivo qui, non posso preservare → vado in fallback sotto
  }

  // Fallback standard: se ci sono lattazioni → ultima, altrimenti custom vuoto
  if (lacStarts.length) {
    var def = lacStarts[lacStarts.length - 1]; // ultima lattazione disponibile
    state.histPeriod = { type: 'lactation', start: def };
    preset.value = 'lac:' + def;
    if (wrap) wrap.style.display = 'none';
  } else {
    state.histPeriod = { type: 'custom', from: null, to: null };
    preset.value = 'custom';
    if (wrap) wrap.style.display = 'flex';
  }
}

/**
 * Formatter "YYYY-MM" per input type="month".
 */
function formatMonth(d) {
  if (!(d instanceof Date)) return '';
  var y = d.getFullYear();
  var m = (d.getMonth() + 1).toString().padStart(2, '0');
  return y + '-' + m;
}

/**
 * Aggiorna il testo dell'opzione "Intervallo personalizzato" nel select #distPreset,
 * includendo eventualmente le estremità dell'intervallo (from/to).
 */
function setCustomLabelText(presetEl, fromD, toD) {
  if (!presetEl) return;
  var optCustom = Array.from(presetEl.options).find(o => o.value === 'custom');
  if (!optCustom) return;

  if (fromD && toD) {
    optCustom.textContent =
      'Intervallo personalizzato (' +
      formatMonth(fromD) +
      ' → ' +
      formatMonth(toD) +
      ')';
  } else {
    optCustom.textContent = 'Intervallo personalizzato';
  }
}

/**
 * Sincronizza la UI (select distPreset + pannello custom + campi mese)
 * con lo stato corrente in state.histPeriod.
 */
function updatePeriodUIFromState() {
  var presetEl = document.getElementById('distPreset');
  var wrapEl   = document.getElementById('customPeriod');
  var fm       = document.getElementById('fromMonth');
  var tm       = document.getElementById('toMonth');

  if (!presetEl) return;

  if (state.histPeriod?.type === 'custom') {
    // Mantieni select su "custom" e pannello aperto
    presetEl.value = 'custom';
    if (wrapEl) wrapEl.style.display = 'flex';

    var f = state.histPeriod.from;
    var t = state.histPeriod.to;
    if (fm) fm.value = formatMonth(f);
    if (tm) tm.value = formatMonth(t);

    setCustomLabelText(presetEl, f, t);
  } else if (state.histPeriod?.type === 'lactation') {
    if (wrapEl) wrapEl.style.display = 'flex';
    presetEl.value = 'lac:' + Number(state.histPeriod.start);
    setCustomLabelText(presetEl, null, null);
  } else if (state.histPeriod?.type === 'months') {
    // Modalità legacy "ultimi N mesi"
    setCustomLabelText(presetEl, null, null);
  }
}


// ============================================================================
// INIZIALIZZAZIONE PRINCIPALE
// ============================================================================

(function init() {
  try {
    // Carica eventuale "seed" JSON inline nella pagina
    var seedTag = document.getElementById('seed');
    if (seedTag && seedTag.textContent) {
      RAW = JSON.parse(seedTag.textContent);
    }
  } catch (e) {
    console.warn('No seed parsed', e);
  }

  // Crea i grafici
  ensureCharts();

  // Selettore azienda basato su RAW corrente
  ensureAziendaSelector();

  // ----- Listener selettore KPI -----
  var kSel = document.getElementById('indicatore');
  if (kSel) {
    state.currentKpi = kSel.value || state.currentKpi;

    kSel.addEventListener('change', function () {
      state.currentKpi = this.value;

      // Reset allineamento asse Y quando cambi KPI
      _leftLockWidth = 0;

      // Invalida cache YM per questo KPI
      cache.ymByKpi.delete(state.currentKpi);

      var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
      updateBenchmarkCountLabel(rows);
      updatePR(rows);
      updateKPI(rows);

      // Decide se preservare la selezione istogramma o forzare auto-selezione
      var hp = state.histPeriod;
      var shouldPreserve =
        hp &&
        (
          // Se ho già una lattazione valida, la mantengo
          hp.type === 'lactation' ||
          // Se ho un custom reale (from/to Date), lo mantengo
          (hp.type === 'custom' && hp.from instanceof Date && hp.to instanceof Date)
        );

      // Prima volta (custom null o months) → shouldPreserve = false
      rebuildLactationMenu(shouldPreserve);

      updateHistogram(rows);
      updatePeriodUIFromState();
    });
  }

  // ----- Gestione vista "I miei dati" vs "Confronto" -----
  var miei       = document.getElementById('miei-dati');
  var conf       = document.getElementById('confronto');
  var viewMiei   = document.getElementById('view-miei');
  var viewConf   = document.getElementById('view-conf');
  var benchmarkOpts = document.getElementById('benchmarkOptions');

  // Listener tipo benchmark (IntraAppare / IntraCaseificio / Regione)
  var benchmarkTypeSel = document.getElementById('benchmarkType');
  if (benchmarkTypeSel && !benchmarkTypeSel._bound) {
    benchmarkTypeSel.addEventListener('change', function () {
      if (cache && cache.ymByKpi && cache.ymByKpi.clear) {
        cache.ymByKpi.clear();
      }

      var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
      updateCaseificioLabel();
      updateBenchmarkCountLabel(rows);
      updatePR(rows);
      updateKPI(rows);
      updateHistogram(rows);
      scheduleSync();
    });
    benchmarkTypeSel._bound = true;
  }

  // Listener filtro provincia
  var provinciaSel = document.getElementById('provinciaFilter');
  if (provinciaSel && !provinciaSel._bound) {
    provinciaSel.addEventListener('change', function () {
      if (cache && cache.ymByKpi && cache.ymByKpi.clear) {
        cache.ymByKpi.clear();
      }

      var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
      updateBenchmarkCountLabel(rows);
      updatePR(rows);
      updateKPI(rows);
      updateHistogram(rows);
      scheduleSync();
    });
    provinciaSel._bound = true;
  }

  // Funzione per applicare la vista (miei dati vs confronto)
  function applyView() {
    if (miei && miei.checked) {
      if (viewMiei) viewMiei.classList.add('active');
      if (viewConf) viewConf.classList.remove('active');
      if (benchmarkOpts) benchmarkOpts.style.display = 'none';
    } else {
      if (viewConf) viewConf.classList.add('active');
      if (viewMiei) viewMiei.classList.remove('active');
      if (benchmarkOpts) benchmarkOpts.style.display = 'flex';
    }
  }

  if (miei) miei.addEventListener('change', applyView);
  if (conf) conf.addEventListener('change', applyView);

  // ----- Listener check-box lattazioni (yr2023/yr2024/yr2025) -----
  ['yr2023', 'yr2024', 'yr2025'].forEach(id => {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', function () {
        var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
        updatePR(rows);
        updateKPI(rows);
      });
    }
  });

  // ----- Wiring controlli istogramma -----
  preset = document.getElementById('distPreset');
  wrap   = document.getElementById('customPeriod');
  apply  = document.getElementById('applyCustom');

  // Costruisce menu lattazioni istogramma e allinea UI al periodo corrente
  rebuildLactationMenu();
  updatePeriodUIFromState();

  // Cambio opzione nel select (#distPreset)
  if (preset) {
    preset.addEventListener('change', () => {
      var v = preset.value;

      if (v === 'custom') {
        // Solo apertura pannello; lo stato effettivo custom si applica con "Applica"
        if (wrap) wrap.style.display = 'flex';
      } else if (v && v.startsWith('lac:')) {
        if (wrap) wrap.style.display = 'flex';
        var y = Number(v.split(':')[1]);
        state.histPeriod = { type: 'lactation', start: y };
        var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
        updateHistogram(rows);
      }
    });
  }

  // Click su "Applica" per l'intervallo personalizzato
  if (apply) {
    apply.addEventListener('click', (e) => {
      if (e && e.preventDefault) e.preventDefault();

      var fm = document.getElementById('fromMonth');
      var tm = document.getElementById('toMonth');
      var fVal = fm?.value;
      var tVal = tm?.value;

      if (!fVal || !tVal) return;

      // input type="month" → "YYYY-MM"
      var fParts = fVal.split('-').map(Number);
      var tParts = tVal.split('-').map(Number);

      var fromD = new Date(fParts[0], (fParts[1] || 1) - 1, 1);
      var toD   = new Date(tParts[0], (tParts[1] || 1) - 1, 1);

      if (fromD > toD) {
        var tmp = fromD;
        fromD   = toD;
        toD     = tmp;
      }

      state.histPeriod = { type: 'custom', from: fromD, to: toD };

      // Aggiorna label opzione custom e i campi input
      setCustomLabelText(preset, fromD, toD);
      if (fm) fm.value = formatMonth(fromD);
      if (tm) tm.value = formatMonth(toD);

      if (preset) preset.value = 'custom';
      if (wrap) wrap.style.display = 'flex';

      var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
      updateHistogram(rows);
    });
  }

  // ----- Primo render con eventuale RAW (seed) -----
  var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi);
  updateBenchmarkCountLabel(rows);
  updateCaseificioLabel();
  updatePR(rows);
  updateKPI(rows);
  updateHistogram(rows);
  updatePeriodUIFromState();
  applyView();

  // Legenda KPI + selettore azienda + allineamento assi
  ensureKpiStyleLegend();
  ensureAziendaSelector();
  scheduleSync();

  // ----- Quando dataLoader ha caricato RAW completo (event "raw:loaded") -----
  document.addEventListener('raw:loaded', function () {
    try {
      // 1) aggiorna la lista aziende
      ensureAziendaSelector();

      // 2) recupera il select KPI
      var kSelLoaded = document.getElementById('indicatore');
      if (kSelLoaded) {
        state.currentKpi = kSelLoaded.value || state.currentKpi || 'cellule';

        // Simula un "change" del KPI: fa ricalcolare tutto
        var evChange = new Event('change', { bubbles: true });
        kSelLoaded.dispatchEvent(evChange);
      } else {
        // Fallback se il select KPI non è presente
        var rows2 = rowsForKpi(getBenchmarkRaw(), state.currentKpi || 'cellule');
        updateBenchmarkCountLabel(rows2);
        updatePR(rows2);
        updateKPI(rows2);
        updateHistogram(rows2);
        updatePeriodUIFromState();
        applyView();
      }
    } catch (e) {
      console.warn('raw:loaded handler error', e);
    }
  });

  // Allineamento assi al resize della finestra
  window.addEventListener('resize', scheduleSync);
})();


// ============================================================================
// PULSANTE DEMO (CREDIT)
// ============================================================================

/**
 * Mostra un piccolo toast con il nome "Giannicola Spezzigu".
 */
function showCredit() {
  var toast = document.createElement('div');
  toast.textContent = 'Giannicola Spezzigu';

  toast.style.position = 'fixed';
  toast.style.top = '20px';
  toast.style.right = '20px';
  toast.style.background = 'rgba(15,23,42,0.9)';
  toast.style.color = 'white';
  toast.style.padding = '10px 16px';
  toast.style.borderRadius = '12px';
  toast.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
  toast.style.fontFamily = 'system-ui, sans-serif';
  toast.style.zIndex = '9999';
  toast.style.opacity = '0';
  toast.style.transition = 'opacity 0.4s ease';

  document.body.appendChild(toast);

  setTimeout(() => { toast.style.opacity = '1'; }, 10);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 500);
  }, 2000);
}

/**
 * Associa il pulsante DEMO al toast di credit.
 */
(function bindDemoButton() {
  var demoEl = document.getElementById('demo');
  if (!demoEl) return;

  demoEl.style.cursor = 'pointer';
  demoEl.addEventListener('mouseenter', () => { demoEl.style.opacity = '0.8'; });
  demoEl.addEventListener('mouseleave', () => { demoEl.style.opacity = '1'; });
  demoEl.addEventListener('click', showCredit);
})();
