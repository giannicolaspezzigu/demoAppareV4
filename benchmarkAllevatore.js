// ============================================================================
// APPARE - Dashboard Benchmark Allevatore
// File: benchmarkAllevatore.js (VERSIONE STABILE)
//
// COSA FA (alto livello)
// - Gestisce stato applicazione (azienda, KPI, periodo istogramma) e relative UI.
// - Calcola PR (percentile rank) per lattazioni, serie KPI con mediana gruppo, istogramma distribuzione.
// - Coordina i grafici Chart.js: PR per lattazioni, KPI linea, istogramma distribuzione.
// - Selettori dinamici: azienda, tipo benchmark (intraAppare/intraCaseificio/regione), provincia, periodo istogramma.
//
// FLUSSO PRINCIPALE (entry point init in fondo al file)
// 1) init() -> applyView() per allineare UI e lanciare i render iniziali.
// 2) updatePR(), updateKPI(), updateHistogram() costruiscono dataset da RAW (dataLoader.js) e stato UI.
// 3) Eventi UI (change su select/radio) e evento "raw:loaded" (dataLoader) riattivano i render.
//
// SORGENTI DATI E DIPENDENZE
// - RAW popolato da dataLoader.js (data.json) con campioni aziendali.
// - CAO_RAW popolato da loaderCaseificio.js (conferitori CAO multipli) + evento "cao:loaded".
// - Stato UI letto dai select/radio: #aziendaSelect, #benchmarkType, #provinciaFilter, #kpi, menu lattazioni, periodi istogramma.
// - Librerie: Chart.js per i grafici. Nessuna altra dipendenza esterna.
//
// NOTA
// - La logica resta invariata: i commenti e le JSDoc chiariscono flussi, variabili e dipendenze per manutenzione futura.
// - Caso speciale CAO: in intraCaseificio, se il caseificio è CAO, i confronti usano i campioni conferitori caricati in CAO_RAW.
// ============================================================================


// ============================================================================
// CONFIGURAZIONE KPI E COSTANTI
// ============================================================================

/**
 * Mappa dei KPI logici e degli alias presenti nel dataset grezzo.
 * Serve a identificare correttamente le righe di RAW per ogni KPI.
 */
const KPI_ALIASES = {
  cellule:   ['cellule', 'scc', 'cellule somatiche', 'cellule somatiche (scc)'],
  carica:    ['carica', 'cbt', 'carica batterica', 'carica batterica (cbt)'],
  urea:      ['urea'],
  grassi:    ['grassi', 'fat', '% fat'],
  proteine:  ['proteine', 'protein', '% prot'],
  caseina:   ['caseina', 'caseine'],
  lattosio:  ['lattosio'],
  crio:      ['crio', 'crio ft'],
  ph:        ['ph'],
  nacl:      ['nacl', 'cloruro di sodio']
};

/**
 * Unita di misura per ciascun KPI, utilizzata nelle label degli assi.
 */
const KPI_UNITS = {
  cellule:   'cell/mL',
  carica:    'UFC/mL',
  urea:      'mg/dL',
  grassi:    '%',
  proteine:  '%',
  caseina:   '%',
  lattosio:  '%',
  crio:      'C',
  ph:        '',
  nacl:      'g/L'
};

/**
 * Etichette dei mesi per le lattazioni (Ottobre-Settembre).
 */
const LAC_MONTHS_IT = [
  'Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar',
  'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set'
];

/**
 * Esporto KPI_UNITS su window per l'utilizzo in performanceAllevatore.js.
 */
window.KPI_UNITS = KPI_UNITS;
window.KPI_ALIASES = KPI_ALIASES;


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
 *     - 'lactation': una lattazione intera (Ottobre-Settembre), start = anno di inizio
 *     - 'custom': intervallo personalizzato (from/to = Date)
 */
var state = {
  currentLacStart: null,
  currentKpi:      'cellule',
  azienda:         'GOIA SILVIA',
  histPeriod:      { type: 'months', value: 12 }
};

// Flag scenario intra-caseificio CAO (media campioni conferitori)
var lastIsCaoIntra = false;
// Media approssimata campioni/mese (solo CAO, per messaggi)
var lastCaoMeanSamplesPerMonth = null;
// Debug helper CAO
var DEBUG_CAO = true;

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
 * Flag per auto-selezionare la lattazione piu recente alla prima inizializzazione.
 * Viene usato da updatePR per selezionare solo l'ultima lattazione al primo render.
 */
var didInitialLacAutoSelect = false;


// ============================================================================
// FUNZIONI DI FILTRO - BENCHMARK (IntraAppare / IntraCaseificio / Regione)
// ============================================================================

/**
 * Restituisce le righe RAW da usare come gruppo di confronto, rispettando i filtri UI.
 *
 * Algoritmo in breve:
 * 1) parte da tutto RAW (tutti i campioni)
 * 2) se benchmark = intraCaseificio, scopre il caseificio dell'azienda selezionata e filtra solo quel caseificio
 * 3) applica eventuale filtro provincia al gruppo filtrato
 * 4) garantisce che i record dell'azienda selezionata siano sempre presenti (anche se esclusi dal filtro provincia)
 * 5) Caso speciale CAO: se il caseificio è CAO, sostituisce il gruppo di confronto con i campioni conferitori (CAO_RAW)
 *    filtrati per KPI e provincia; conserva comunque le righe aziendali originali per confronti/serie azienda.
 *
 * Relazioni:
 * - usa state.azienda come azienda selezionata
 * - dipende dai <select> #benchmarkType e #provinciaFilter per i filtri utente
 * - fornisce i dati a rowsForKpi -> updatePR / updateKPI / updateHistogram
 *
 * @returns {Array<Object>} sottoinsieme di RAW pronto per essere passato a rowsForKpi
 */
function getBenchmarkRaw() {
  var rawRows = Array.isArray(RAW) ? RAW : [];
  if (!rawRows.length) return rawRows;

  // reset flag: verrà settato solo se scatta la modalità CAO
  lastIsCaoIntra = false;
  lastCaoMeanSamplesPerMonth = null;
  if (cache && cache.caoCountsByYM) cache.caoCountsByYM.clear();

  // Tipo di benchmark scelto (intraAppare / IntraCaseificio / Regione)
  var benchmarkSelect = document.getElementById('benchmarkType');
  var benchmarkMode = benchmarkSelect && benchmarkSelect.value ? benchmarkSelect.value : 'intraAppare';

  var filteredRows = rawRows;

  // Modalita IntraCaseificio: filtra solo i record del caseificio dell'azienda selezionata
  if (benchmarkMode === 'intraCaseificio') {
    var selectedAzienda = state && state.azienda ? state.azienda : null;
    if (selectedAzienda) {
      var selectedCaseificio = null;

      for (var i = 0; i < rawRows.length; i++) {
        var candidateRow = rawRows[i];
        if (candidateRow && candidateRow.Azienda === selectedAzienda && candidateRow.Caseificio) {
          selectedCaseificio = candidateRow.Caseificio;
          break;
        }
      }

      if (selectedCaseificio) {
        // Caso speciale: CAO -> usa campioni conferitori come gruppo di confronto
        if (isCaoCaseificio(selectedCaseificio)) {
          // se i campioni non sono ancora caricati, avvia il loader e ritorna vuoto
          if ((!Array.isArray(window.CAO_RAW) || !window.CAO_RAW.length) && window.CAO && typeof window.CAO.ensureLoaded === 'function') {
            if (DEBUG_CAO) console.log('[CAO] ensureLoaded trigger: campioni non presenti, caseificio selezionato:', selectedCaseificio);
            window.CAO.ensureLoaded().catch(() => {});
            return [];
          }
          if (Array.isArray(window.CAO_RAW) && window.CAO_RAW.length) {
            lastIsCaoIntra = true;

            // assicurati che il loader CAO sia partito (in caso di lazy loading)
            if (window.CAO && typeof window.CAO.ensureLoaded === 'function') {
              window.CAO.ensureLoaded().catch(() => {});
            }

          // Applichiamo eventuale filtro provincia anche ai campioni CAO_RAW
          var provinceSelect = document.getElementById('provinciaFilter');
          var provinceValue = provinceSelect && provinceSelect.value ? provinceSelect.value : 'tutte';
          var provinceName = null;
          if (provinceValue === 'sassari')       provinceName = 'Sassari';
          else if (provinceValue === 'nuoro')    provinceName = 'Nuoro';
          else if (provinceValue === 'oristano') provinceName = 'Oristano';
          else if (provinceValue === 'cagliari') provinceName = 'Cagliari';

            var aziRows = rawRows.filter(function (row) { return row && row.Azienda === selectedAzienda; });

            var kpiKey = state && state.currentKpi ? state.currentKpi : 'cellule';
            var aliases = KPI_ALIASES[kpiKey] || [kpiKey];

          var caoSamples = [];
          var countsByYM = cache.caoCountsByYM;
          countsByYM.clear();

          for (var cr of window.CAO_RAW) {
            if (!cr) continue;
            var rk = String(cr.KPI || '').toLowerCase();
            if (aliases.indexOf(rk) === -1) continue;
            if (provinceName && cr.Provincia && cr.Provincia !== provinceName) continue;
            var y = Number(cr.Anno);
            var m = Number(cr.Mese);
            var v = Number(cr.Valore);
            if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(v)) continue;
            caoSamples.push({
              Azienda: cr.Azienda || 'Conferitore CAO',
              Caseificio: 'CAO',
              Provincia: cr.Provincia || '',
              KPI: kpiKey,
                Anno: y,
                Mese: m,
                Valore: v
              });
            var keyYM = y + '-' + m;
            countsByYM.set(keyYM, (countsByYM.get(keyYM) || 0) + 1);
          }

          if (countsByYM.size) {
            var sumC = 0;
            countsByYM.forEach(function (c) { sumC += c; });
            lastCaoMeanSamplesPerMonth = sumC / countsByYM.size;
          } else {
            lastCaoMeanSamplesPerMonth = null;
          }

            if (DEBUG_CAO) {
              console.log('[CAO] KPI', kpiKey, 'samples raw:', window.CAO_RAW.length, 'rows used:', caoSamples.length, 'countsByYM size:', countsByYM.size, 'mean samples/month:', lastCaoMeanSamplesPerMonth);
            }

            return aziRows.concat(caoSamples);
          }
        } else {
          filteredRows = rawRows.filter(function (row) {
            return row && row.Caseificio === selectedCaseificio;
          });
        }
      }
    }
  }

  // Modalita intraAppare/regione: usano tutto RAW, poi applichiamo filtro provincia
  var provinceSelect = document.getElementById('provinciaFilter');
  var provinceValue = provinceSelect && provinceSelect.value ? provinceSelect.value : 'tutte';
  if (provinceValue !== 'tutte') {
    var provinceName = null;
    if (provinceValue === 'sassari')       provinceName = 'Sassari';
    else if (provinceValue === 'nuoro')    provinceName = 'Nuoro';
    else if (provinceValue === 'oristano') provinceName = 'Oristano';
    else if (provinceValue === 'cagliari') provinceName = 'Cagliari';

    if (provinceName) {
      filteredRows = filteredRows.filter(function (row) {
        return row && row.Provincia === provinceName;
      });
    }
  }

  // Aggiungiamo sempre i record dell'azienda selezionata, anche se filtrati fuori
  var selected = state && state.azienda ? state.azienda : null;
  if (!selected) return filteredRows;

  var hasSelected = filteredRows.some(function (row) {
    return row && row.Azienda === selected;
  });
  if (hasSelected) return filteredRows;

  var selectedRows = rawRows.filter(function (row) {
    return row && row.Azienda === selected;
  });

  return filteredRows.concat(selectedRows);
}


// ============================================================================
// KPI UTILITY E AGGREGAZIONI
// ============================================================================

/**
 * Indica se un KPI migliora con valori piu bassi (es. cellule somatiche, carica batterica).
 * @param {string} k KPI logico
 * @returns {boolean} true se un valore minore e desiderabile
 */
function lowerIsBetter(k) {
  return k === 'cellule' || k === 'carica';
}

/**
 * Indica se il KPI richiede trasformazione logaritmica per aggregazioni/grafici.
 * @param {string} k KPI logico
 * @returns {boolean} true per KPI con distribuzione log (cellule, carica)
 */
function isLogKPI(k) {
  return k === 'cellule' || k === 'carica';
}

/**
 * Media aritmetica su un array di numeri, ignorando valori non finiti.
 * @param {number[]} values lista di valori numerici
 * @returns {number|null} media aritmetica, oppure null se nessun valore valido
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
 * Media geometrica su un array di numeri positivi.
 * Usata per KPI in scala log (cellule, carica).
 * @param {number[]} values lista di valori numerici
 * @returns {number|null} media geometrica, oppure null se nessun valore valido
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
 * Filtra RAW per KPI logico e normalizza i campi in un formato uniforme.
 * Converte Anno/Mese in year (YYYY) e month (0..11), Valore in value numerico.
 * @param {Array<Object>} raw dataset grezzo
 * @param {string} k KPI logico da estrarre
 * @returns {Array<Object>} record normalizzati {Azienda, year, month, value}
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
 * Aggiorna la label "#benchmarkCount" con il numero di aziende uniche nel gruppo di confronto.
 * @param {Array<Object>} rows righe KPI filtrate (dopo getBenchmarkRaw + rowsForKpi)
 */
function updateBenchmarkCountLabel(rows) {
  var el = document.getElementById('benchmarkCount');
  if (!el) return;

  // In caso di intra CAO: conteggia i campioni (righe) invece delle aziende
  if (lastIsCaoIntra) {
    var approx = lastCaoMeanSamplesPerMonth ? ('confronto su circa ' + lastCaoMeanSamplesPerMonth.toFixed(0) + ' campioni/mese') : '';
    el.textContent = approx;
    return;
  }

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
    el.textContent = ' al momento sei l\'unica azienda nel gruppo di confronto';
  } else {
    el.textContent = ' confronto su ' + n + ' aziende';
  }
}

/**
 * Aggiorna la label del caseificio in modalita IntraCaseificio.
 * Legge state.azienda e RAW per trovare il caseificio associato; nasconde il campo negli altri casi.
 */
function updateCaseificioLabel() {
  // Gestisce la label #caseificioLabel per mostrare il caseificio dell'azienda (solo in intraCaseificio)
  var el = document.getElementById('caseificioLabel');
  if (!el) return;

  var modeSel = document.getElementById('benchmarkType');
  var mode = modeSel && modeSel.value ? modeSel.value : 'intraAppare';

  // Mostriamo il caseificio solo in modalita IntraCaseificio
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
 * Aggrega i campioni su base mensile per (Anno, Mese, Azienda).
 * - Usa media aritmetica o geometrica a seconda del KPI (log per cellule/carca).
 * - Produce righe normalizzate {Azienda, year, month, value} per un solo KPI.
 *
 * @param {Array<Object>} rawRows record normalizzati {Azienda, year, month, value}
 * @param {string} kpi KPI logico di riferimento
 * @returns {Array<Object>} righe aggregate per anno-mese-azienda
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
 * Percentile rank approssimato di un valore rispetto a un array di numeri.
 * Gestisce gli ex-aequo distribuendo 0.5 sui pari.
 * @param {number[]} arr valori del gruppo
 * @param {number} v valore dell'azienda
 * @returns {number|null} percentile 0..100, oppure null se input non valido
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
 * Calcola la mediana di un array di numeri, ignorando i non finiti.
 * @param {number[]} arr valori numerici
 * @returns {number|null} mediana oppure null se array vuoto
 */
function median(arr) {
  var a = arr.filter(x => isFinite(x)).sort((x, y) => x - y);
  var n = a.length;
  if (!n) return null;
  var m = Math.floor(n / 2);
  return (n % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
}


// ============================================================================
// CACHE YM (anno-mese -> Map(Azienda, valore aggregato))
// ============================================================================

/**
 * Cache: per ogni KPI logico memorizziamo la mappa YM:
 *  key = 'year-month'
 *  value = { year, month, by: Map(Azienda, valore_aggregato) }
 */
var cache = {
  ymByKpi: new Map(),
  // Mappa YM -> count campioni CAO (solo per scenario intra CAO)
  caoCountsByYM: new Map()
};

/**
 * Riconosce il caseificio CAO anche con punteggiatura/maiuscole diverse.
 * @param {string} name nome caseificio
 * @returns {boolean} true se coincide con C.A.O.
 */
function isCaoCaseificio(name) {
  if (!name) return false;
  var n = String(name).toLowerCase().replace(/[.\-\s]/g, '');
  return n.includes('cao');
}

/**
 * Restituisce (o costruisce) la mappa anno-mese -> valori per azienda per un KPI.
 * Cachea per KPI logico per evitare ricalcoli.
 *
 * Relazioni:
 * - usa monthlyAggregate per ottenere i valori mensili per azienda
 * - alimenta grafici PR/KPI/istogramma
 *
 * @param {Array<Object>} kpiRows righe filtrate per KPI {Azienda, year, month, value}
 * @param {string} kpiKey KPI logico
 * @returns {Map<string,{year:number,month:number,by:Map<string,number>}>} mappa 'year-month' -> struttura con valori per azienda
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
 * Anno di inizio della lattazione corrente (Ottobre-Settembre).
 */
function currentLactationStart() {
  var m = todayM();
  var y = todayY();
  return (m >= 9) ? y : (y - 1);
}

/**
 * Le ultime tre lattazioni basate sulla data odierna (lasciata per completezza).
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
 * Posizione (0..11) di un mese (0..11) all"interno della lattazione (Ottobre-Settembre).
 * Ott(9) = 0, Nov(10) = 1, ..., Set(8) = 11
 */
function lacPosFromMonth(m) {
  return (m + 3) % 12;
}

/**
 * Rileva le lattazioni (anni di inizio) in cui l'azienda selezionata ha dati.
 * Regola: Ott-Dic appartengono all'anno corrente, Gen-Set all'anno precedente.
 * Restituisce al massimo le ultime 3 lattazioni ordinate.
 * @param {Array<Object>} rows righe KPI normalizzate {Azienda, year, month, value}
 * @returns {number[]} anni di inizio lattazione
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
 * Inizializza i tre grafici Chart.js (PR, KPI, Istogramma) con configurazioni base.
 * - registra plugin (annotazioni + linea hover)
 * - crea le istanze prChart, kpiChart, histChart collegandole ai rispettivi canvas
 * Le serie e i dati verranno popolati dalle funzioni updatePR/updateKPI/updateHistogram.
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
        datasets: [
          {
            label: 'Frequenza %',
            data: [],
            parsing: { xAxisKey: 'x', yAxisKey: 'y' },
            backgroundColor: (ctx) => {
              const c = ctx.raw?.count;
              return (Number.isFinite(c) && c > 0) ? 'rgba(59,130,246,0.28)' : 'transparent';
            },
            borderColor: (ctx) => {
              const c = ctx.raw?.count;
              return (Number.isFinite(c) && c > 0) ? '#3b82f6' : 'transparent';
            },
            borderWidth: (ctx) => {
              const c = ctx.raw?.count;
              return (Number.isFinite(c) && c > 0) ? 1 : 0;
            },
            barPercentage: 1,
            categoryPercentage: 1,
            _tag: 'bars'
          },
          {
            type: 'scatter',
            label: 'Azienda',
            data: [],
            backgroundColor: '#f43f5e',
            borderColor: '#f43f5e',
            pointRadius: 2.5,
            pointHoverRadius: 7,
            pointHitRadius: 10,
            showLine: false,
            _tag: 'azi'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
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
/**
 * Costruisce/aggiorna la legenda del grafico KPI (azienda vs mediana/media).
 * Dipendenze: header del grafico KPI (#kpiChartHost precedente sibling), checkbox mediana/media per allineamento.
 * Non tocca i dataset: solo UI/markup di legenda.
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
  legend.style.fontSize = '14px';
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
  legend.appendChild(item(lastIsCaoIntra ? 'Media (campioni CAO)' : 'Mediana (altre aziende)', true));

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
 * Assicura la presenza del select aziende e lo popola da RAW.
 *
 * Flusso:
 * - trova un host plausibile (id/ruolo/classi oppure barra superiore)
 * - se non esiste <select id="aziendaSelect"> lo crea e lo inserisce accanto all'etichetta
 * - costruisce la lista delle aziende uniche (ordinata) e mantiene la selezione se possibile
 * - associa un change handler che:
 *   - aggiorna state.azienda
 *   - svuota la cache YM (dipende dall'azienda)
 *   - ricalcola PR, KPI, istogramma e menu lattazioni
 *   - riallinea la UI periodo e l'etichetta caseificio
 *
 * Relazioni:
 * - dipende da RAW e state.azienda
 * - richiama getBenchmarkRaw/rowsForKpi e le funzioni di update grafici
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
    //    lab.textContent = 'Azienda:';
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
    var aziendeSet = new Set();
    for (var r of RAW) {
      if (r && r.Azienda) aziendeSet.add(String(r.Azienda));
    }

    var aziendaList = Array.from(aziendeSet).sort((a, b) =>
      a.localeCompare(b, 'it', { sensitivity: 'base' })
    );

    // Mantieni selezione corrente se possibile
    var current = (state.azienda && aziendaList.includes(state.azienda))
      ? state.azienda
      : (aziendaList[0] || state.azienda);

    state.azienda = current;

    // Ricostruisci options solo se diverso da quello gia presente
    var existing = Array.from(sel.options).map(o => o.value);
    var same =
      existing.length === aziendaList.length &&
      existing.every((v, i) => v === aziendaList[i]);

    if (!same) {
      sel.innerHTML = '';
      for (var name of aziendaList) {
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

        // YM dipende anche dall'azienda -> svuota la cache
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
 * Aggiorna il grafico PR (percentile rank 0-100%) per le lattazioni selezionate.
 * Logica:
 * - recupera le ultime 3 lattazioni reali per l azienda
 * - associa dinamicamente i checkbox yr2023/yr2024/yr2025 alle lattazioni trovate
 * - al primo render accende solo l ultima lattazione disponibile
 * - per ogni lattazione calcola il PR mensile rispetto al gruppo di confronto
 *   - standard: confronta il valore medio mensile aziendale con le medie mensili di tutte le aziende (b.by.values())
 *   - CAO: confronta il valore medio mensile aziendale con tutti i campioni grezzi CAO del mese (filtrati per KPI/provincia)
 * Dipendenze: usa getYMMap per mappa anno-mese, getLactationStartsFromRows per le lattazioni,
 * palette/checkbox condivise con updateKPI per coerenza visuale.
 * Il percentile per mese confronta azienda vs gruppo filtrato (getBenchmarkRaw -> rowsForKpi).
 *
 * @param {Array<Object>} rows righe KPI normalizzate {Azienda, year, month, value} per l'azienda/gruppo
 */
function updatePR(rows) {
  var ymMap = getYMMap(rows, state.currentKpi);

  // Helper per il caso CAO: campioni grezzi per (anno, mese) filtrati per KPI/provincia
  var provinceNameForCao = (function () {
    var provinceSelect = document.getElementById('provinciaFilter');
    var provinceValue = provinceSelect && provinceSelect.value ? provinceSelect.value : 'tutte';
    if (provinceValue === 'sassari')       return 'Sassari';
    if (provinceValue === 'nuoro')         return 'Nuoro';
    if (provinceValue === 'oristano')      return 'Oristano';
    if (provinceValue === 'cagliari')      return 'Cagliari';
    return null;
  })();
  var kpiAliasesForCao = KPI_ALIASES[state.currentKpi] || [state.currentKpi];
  function getCaoSamplesForMonth(year, month0) {
    // Restituisce i campioni grezzi CAO (array di numeri) per anno/mese, filtrati per KPI/provincia
    if (!lastIsCaoIntra || !Array.isArray(window.CAO_RAW)) return null;
    var month1 = month0 + 1;
    var vals = [];
    for (var cr of window.CAO_RAW) {
      if (!cr) continue;
      var rk = String(cr.KPI || '').toLowerCase();
      if (kpiAliasesForCao.indexOf(rk) === -1) continue;
      if (provinceNameForCao && cr.Provincia && cr.Provincia !== provinceNameForCao) continue;
      var y = Number(cr.Anno);
      var m = Number(cr.Mese);
      var v = Number(cr.Valore);
      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(v)) continue;
      if (y === year && m === month1) vals.push(v);
    }
    return vals;
  }

  // Lattazioni reali (ultime 3) per l'azienda corrente
  var lacStarts = getLactationStartsFromRows(rows);
  var palette   = ['#3b82f6', '#f59e0b', '#22c55e'];

  // Mappa checkbox (yr2023, yr2024, yr2025) -> anno di inizio lattazione
  var ids = ['yr2023', 'yr2024', 'yr2025'];
  var map = ids.map((id, idx) => [id, lacStarts[idx]]);

  var colors = {};
  lacStarts.forEach((y, idx) => {
    colors[y] = palette[idx] || '#64748b';
  });

  // Aggiorna label, colore e visibilita delle checkbox
  map.forEach(([id, yStart]) => {
    var inp = document.getElementById(id);
    var lab = document.querySelector('label[for="' + id + '"]');

    if (!lab && inp && inp.parentElement && inp.parentElement.tagName.toLowerCase() === 'label') {
      lab = inp.parentElement;
    }

    if (!yStart || !inp || !lab) {
      // Nessuna lattazione associata -> nascondi/azzera
      if (lab) lab.style.display = 'none';
      if (inp) {
        inp.checked  = false;
        inp.disabled = true;
      }
      var labSpanEmpty = document.getElementById(id + 'Lbl');
      if (labSpanEmpty) labSpanEmpty.textContent = '';
      return;
    }

    // Lattazione valida -> mostra e abilita
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

  var ds = []; // datasets PR per ciascuna lattazione selezionata
  for (var yStart of selected) {
    var arr = new Array(12).fill(null);

    // Ottobre-Dicembre dell'anno yStart
    for (var m = 9; m <= 11; m++) {
      var b1 = ymMap.get(yStart + '-' + m);
      if (!b1) continue;
      var vals1 = lastIsCaoIntra
        ? getCaoSamplesForMonth(yStart, m) || []
        : Array.from(b1.by.values()).map(trans);
      var vAzi1 = b1.by.get(state.azienda);
      var tv1   = (vAzi1 != null) ? trans(vAzi1) : null;
      arr[lacPosFromMonth(m)] = percentileRank(vals1, tv1);
    }

    // Gennaio-Settembre dell'anno successivo
    for (var m2 = 0; m2 <= 8; m2++) {
      var b2 = ymMap.get((yStart + 1) + '-' + m2);
      if (!b2) continue;
      var vals2 = lastIsCaoIntra
        ? getCaoSamplesForMonth(yStart + 1, m2) || []
        : Array.from(b2.by.values()).map(trans);
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

  // Sfondo PR (bande colorate) invertito se il KPI e 'lower is better'
  (function () {
    var isLower = lowerIsBetter(state.currentKpi);
    var isUrea = state.currentKpi === 'urea';
    var annRoot = prChart.options?.plugins?.annotation;
    var ann     = annRoot?.annotations;
    if (ann && ann.low && ann.mid && ann.high) {
      ann.low.backgroundColor  = isUrea ? 'rgba(0,0,0,0)' : (isLower ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)');
      ann.mid.backgroundColor  = isUrea ? 'rgba(0,0,0,0)' : 'rgba(245,158,11,0.12)';
      ann.high.backgroundColor = isUrea ? 'rgba(0,0,0,0)' : (isLower ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)');
    }
  })();

  prChart.update('none');
  scheduleSync();
}


// ============================================================================
// UPDATE KPI (GRAFICO VALORI ASSOLUTI + MEDIANA)
// ============================================================================

/**
 * Aggiorna il grafico KPI (serie azienda + mediana/media gruppo) per le lattazioni selezionate.
 * Logica:
 * - usa le checkbox yr20xx per capire quali lattazioni mostrare
 * - per ogni lattazione genera due serie:
 *    • azienda: media mensile per mese della lattazione (da ymMap, già aggregata)
 *    • mediana (standard) oppure media campioni CAO (caso intra CAO) per il gruppo
 * - applica il toggle "Mostra mediana" (o media CAO) senza ricalcolo (solo hide/show dei dataset median)
 * - aggiunge eventuali linee di limite normativo per KPI log in scala cellulare/carca
 *
 * Dati in ingresso: righe KPI normalizzate per azienda/gruppo (output di rowsForKpi + getBenchmarkRaw).
 * Relazioni: usa getYMMap per ottenere una mappa anno-mese -> valori per azienda; condivide checkbox con updatePR;
 * il toggle showMedian agisce solo su dataset con _type='median' evitando ricalcoli.
 *
 * @param {Array<Object>} rows righe KPI normalizzate {Azienda, year, month, value}
 */
function updateKPI(rows) {
  // rows: righe KPI normalizzate {Azienda, year, month, value}; costruisce dataset per grafico KPI
  var ymMap = getYMMap(rows, state.currentKpi);
  var aliasesCao = KPI_ALIASES[state.currentKpi] || [state.currentKpi];
  var provinceNameCao = (function () {
    var provinceSelect = document.getElementById('provinciaFilter');
    var provinceValue = provinceSelect && provinceSelect.value ? provinceSelect.value : 'tutte';
    if (provinceValue === 'sassari')       return 'Sassari';
    if (provinceValue === 'nuoro')         return 'Nuoro';
    if (provinceValue === 'oristano')      return 'Oristano';
    if (provinceValue === 'cagliari')      return 'Cagliari';
    return null;
  })();
  function getCaoSamplesForMonth(year, month0) {
    if (!lastIsCaoIntra || !Array.isArray(window.CAO_RAW)) return [];
    // Restituisce i campioni grezzi CAO (array di numeri) per anno/mese, filtrati per KPI/provincia
    var month1 = month0 + 1;
    var arr = [];
    for (var cr of window.CAO_RAW) {
      if (!cr) continue;
      var rk = String(cr.KPI || '').toLowerCase();
      if (aliasesCao.indexOf(rk) === -1) continue;
      if (provinceNameCao && cr.Provincia && cr.Provincia !== provinceNameCao) continue;
      var y = Number(cr.Anno);
      var m = Number(cr.Mese);
      var v = Number(cr.Valore);
      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(v)) continue;
      if (y === year && m === month1) arr.push(v);
    }
    return arr;
  }

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

  // Toggle "Mostra mediana" (o "Mostra media" in caso CAO)
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
      txt.textContent = lastIsCaoIntra ? 'Mostra media' : 'Mostra mediana';

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
  if (medianToggle) {
    // Se cambia il contesto (CAO/non CAO) aggiorna la label
    var lblSpan = medianToggle.nextElementSibling;
    if (lblSpan) lblSpan.textContent = lastIsCaoIntra ? 'Mostra media' : 'Mostra mediana';
  }

  // Costruzione dataset azienda + mediana per ogni lattazione selezionata
  var datasets = []; // coppie KPI/Mediana per ogni lattazione selezionata

  for (var yStart of selected) {
    var azi = new Array(12).fill(null);
    var med = new Array(12).fill(null);

    // Ott-Dic anno yStart
    for (var m = 9; m <= 11; m++) {
      var b = ymMap.get(yStart + '-' + m);
      if (!b) continue;
      var vals = Array.from(b.by.values());
      azi[lacPosFromMonth(m)] = b.by.get(state.azienda) ?? null;
      if (lastIsCaoIntra) {
        var samp = getCaoSamplesForMonth(yStart, m);
        med[lacPosFromMonth(m)] = samp.length ? (isLogKPI(state.currentKpi) ? aggGeometric(samp) : aggArithmetic(samp)) : null;
      } else {
        med[lacPosFromMonth(m)] = median(vals);
      }
    }

    // Gen-Set anno yStart+1
    for (var m2 = 0; m2 <= 8; m2++) {
      var b2 = ymMap.get((yStart + 1) + '-' + m2);
      if (!b2) continue;
      var vals2 = Array.from(b2.by.values());
      azi[lacPosFromMonth(m2)] = b2.by.get(state.azienda) ?? null;
      if (lastIsCaoIntra) {
        var samp2 = getCaoSamplesForMonth(yStart + 1, m2);
        med[lacPosFromMonth(m2)] = samp2.length ? (isLogKPI(state.currentKpi) ? aggGeometric(samp2) : aggArithmetic(samp2)) : null;
      } else {
        med[lacPosFromMonth(m2)] = median(vals2);
      }
    }

    var c = colorFor[yStart] || '#64748b';

    // Serie azienda
    datasets.push({
      label: lactationLabel(yStart) + ' KPI',
      data: azi,
      borderColor: c,
      backgroundColor: c + '22',
      borderWidth: 2,
      spanGaps: true,
      pointRadius: 3,
      _type: 'kpi',
      _lacStart: yStart
    });

    // Serie mediana/media
    datasets.push({
      label: lastIsCaoIntra ? (lactationLabel(yStart) + ' Media') : (lactationLabel(yStart) + ' Mediana'),
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
  var kpiLabel = (function () {
    var sel = document.getElementById('indicatore');
    if (sel && sel.options && sel.selectedIndex >= 0) {
      return sel.options[sel.selectedIndex].text || state.currentKpi;
    }
    return state.currentKpi;
  })();
  kpiChart.options.scales.y.title = {
    display: !!unit || !!kpiLabel,
    text: unit ? (kpiLabel + ' (' + unit + ')') : kpiLabel
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
 *
 * Input: righe KPI normalizzate (rowsForKpi su getBenchmarkRaw).
 * Relazioni: usa getYMMap per aggregare per anno-mese, e state.histPeriod per determinare il periodo.
 *
 * @param {Array<Object>} rows righe KPI normalizzate {Azienda, year, month, value}
 */
function updateHistogram(rows) {
  // rows: righe KPI normalizzate {Azienda, year, month, value}; gestisce istogramma + PR azienda
  var ymMap = getYMMap(rows, state.currentKpi);

  // Tutte le chiavi anno-mese presenti nel dataset (ordinato)
  var ymKeys = Array
    .from(ymMap.keys())
    .map(k => {
      var parts = k.split('-').map(Number);
      return { y: parts[0], m: parts[1] };
    })
    .sort((a, b) => (a.y - b.y) || (a.m - b.m));

  if (!ymKeys.length) {
    histChart.data.datasets[0].data = [];
    histChart.update();
    var pbEmpty = document.getElementById('posBadge');
    if (pbEmpty) pbEmpty.textContent = '-- percentile';
    return;
  }

  // ----- Limita il range dei month-picker "from/to" ai mesi con dati dell'azienda corrente -----
  (function () {
    var az = state.azienda;
    var minD = null;
    var maxD = null;

    // Scorri la mappa ymMap (year,month,byAziende) solo dove l'azienda ha dati
    ymMap.forEach((obj) => {
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

  var useGeo = isLogKPI(state.currentKpi);

  // ----- Branch CAO (campioni conferitori) -----
  if (lastIsCaoIntra) {
    var ymSet = new Set(inRangeMonths.map(ym => (ym.y + '-' + (ym.m + 1))));
    var aziVals = [];
    inRangeMonths.forEach(function (ym) {
      var b = ymMap.get(ym.y + '-' + ym.m);
      if (!b) return;
      var vAz = b.by.get(state.azienda);
      if (isFinite(vAz)) aziVals.push(vAz);
    });
    var aziAggCao = aziVals.length ? (useGeo ? aggGeometric(aziVals) : aggArithmetic(aziVals)) : null;

    var aliases = KPI_ALIASES[state.currentKpi] || [state.currentKpi];
    var provinceSelect = document.getElementById('provinciaFilter');
    var provinceValue = provinceSelect && provinceSelect.value ? provinceSelect.value : 'tutte';
    var provinceName = null;
    if (provinceValue === 'sassari')       provinceName = 'Sassari';
    else if (provinceValue === 'nuoro')    provinceName = 'Nuoro';
    else if (provinceValue === 'oristano') provinceName = 'Oristano';
    else if (provinceValue === 'cagliari') provinceName = 'Cagliari';

    var sampleVals = [];
    for (var cr of window.CAO_RAW || []) {
      if (!cr) continue;
      var rk = String(cr.KPI || '').toLowerCase();
      if (aliases.indexOf(rk) === -1) continue;
      if (provinceName && cr.Provincia && cr.Provincia !== provinceName) continue;
      var yS = Number(cr.Anno);
      var mS = Number(cr.Mese);
      var vS = Number(cr.Valore);
      if (!Number.isFinite(yS) || !Number.isFinite(mS) || !Number.isFinite(vS)) continue;
      if (!ymSet.has(yS + '-' + mS)) continue;
      sampleVals.push(vS);
    }

    if (!sampleVals.length) {
      histChart.data.datasets[0].data = [];
      histChart.update();
      var pbEmptyCao = document.getElementById('posBadge');
      if (pbEmptyCao) pbEmptyCao.textContent = '-- percentile';
      return;
    }

    function freedmanBinsCao(values) {
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
      var h = 2 * iqr * Math.pow(n, -1 / 3);
      var b = Math.ceil((s[n - 1] - s[0]) / h);
      if (!isFinite(b) || b < 6) b = 6;
      if (b > 15) b = 15;
      return b;
    }

    var mnC = Math.min.apply(null, sampleVals);
    var mxC = Math.max.apply(null, sampleVals);
    var binsC = freedmanBinsCao(sampleVals);
    var centersC, countsC, stepC, edgesC = [];

    if (mnC === mxC) {
      binsC = 1;
      stepC = 1;
      edgesC = [mnC - 0.5, mnC + 0.5];
      centersC = [mnC];
      countsC = [sampleVals.length];
    } else {
      stepC = (mxC - mnC) / binsC;
      if (!isFinite(stepC) || stepC <= 0) stepC = 1;
      edgesC = [];
      for (var bIdx = 0; bIdx <= binsC; bIdx++) edgesC.push(mnC + bIdx * stepC);
      centersC = [];
      for (var bIdx2 = 0; bIdx2 < binsC; bIdx2++) centersC.push(mnC + (bIdx2 + 0.5) * stepC);
      countsC = new Array(binsC).fill(0);
      for (var sv of sampleVals) {
        var idxC = Math.floor((sv - mnC) / stepC);
        if (idxC >= binsC) idxC = binsC - 1;
        if (idxC < 0) idxC = 0;
        countsC[idxC] += 1;
      }
    }

    var totalC = countsC.reduce((a, c) => a + c, 0) || 1;
    var dataC  = centersC.map((c, i) => ({
      x: c,
      y: Math.round((countsC[i] / totalC) * 1000) / 10,
      count: countsC[i],
      from: edgesC[i],
      to: edgesC[i + 1]
    }));

    var prC = percentileRank(sampleVals.map(Number), aziAggCao);
    var unitC = KPI_UNITS[state.currentKpi] || '';
    histChart.data.datasets[0].data = dataC;
    histChart.data.datasets[1].data = (aziAggCao != null)
      ? [{ x: aziAggCao, y: 0, aziValue: aziAggCao, unit: unitC }]
      : [];

    var axisMinC = mnC;
    var axisMaxC = mxC;
    if (axisMinC === axisMaxC) { axisMinC = mnC - 0.5; axisMaxC = mnC + 0.5; }
    if (aziAggCao != null && isFinite(aziAggCao)) {
      var padC = isFinite(stepC) && stepC > 0 ? (stepC * 0.3) : 0.5;
      axisMinC = Math.min(axisMinC, aziAggCao - padC);
      axisMaxC = Math.max(axisMaxC, aziAggCao + padC);
    }

    histChart.options.scales.x = {
      type: 'linear',
      min: axisMinC,
      max: axisMaxC,
      bounds: 'ticks',
      offset: false,
      title: { display: !!unitC, text: unitC ? (state.currentKpi + ' ' + unitC) : '' },
      ticks: {
        callback: (v) => isFinite(v) ? Number(v).toFixed(2) : v
      },
      afterBuildTicks: (scale) => {
        scale.ticks = edgesC.map(v => ({ value: v }));
      }
    };

    histChart.options.plugins.annotation.annotations = (aziAggCao != null)
      ? {
          azi: {
            type: 'line',
            xMin: aziAggCao,
            xMax: aziAggCao,
            borderColor: '#ef4444',
            borderWidth: 2,
            label: {
              enabled: true,
              content:
                'Azienda: ' +
                aziAggCao.toFixed(2) +
                (unitC ? (' ' + unitC) : '') +
                (prC != null ? (' (PR ' + prC + '°)') : ''),
              rotation: 90,
              backgroundColor: 'rgba(239,68,68,0.15)',
              color: '#ef4444'
            }
          }
        }
      : {};

    histChart.options.plugins.tooltip = {
      enabled: true,
      displayColors: false,
      filter: function (item) {
        if (item.dataset && item.dataset._tag === 'bars') {
          var c = item.raw && item.raw.count;
          return isFinite(c) && c > 0;
        }
        return true;
      },
      callbacks: {
        label: function (ctx) {
          if (ctx.dataset && ctx.dataset._tag === 'azi') {
            var d = ctx.raw || {};
            var val = isFinite(d.aziValue) ? d.aziValue.toFixed(2) : '';
            return val ? ['Azienda: ' + val + (unitC ? ' ' + unitC : '')] : '';
          }
          var d2 = ctx.raw || {};
          var left = (d2.from != null && isFinite(d2.from)) ? d2.from.toFixed(2) : '?';
          var right = (d2.to != null && isFinite(d2.to)) ? d2.to.toFixed(2) : '?';
          var isLast = ctx.dataIndex === (ctx.chart.data.datasets[0].data.length - 1);
          var range = 'Range: [' + left + ' ; ' + right + (isLast ? ' ]' : ' [');
          var pct = isFinite(d2.y) ? 'Frequenza: ' + d2.y.toFixed(1) + '%' : '';
          var cnt = isFinite(d2.count) ? 'Campioni: ' + d2.count : '';
          return [range, pct, cnt].filter(Boolean);
        }
      }
    };

    histChart.update();
    var pbCao = document.getElementById('posBadge');
    if (pbCao) pbCao.textContent = (prC != null) ? (prC + '° percentile') : '-- percentile';
    return;
  }

  // Aggregazione per azienda (media mesi in-range)
  var perAz = new Map(); // Map azienda -> lista valori nel periodo selezionato
  inRangeMonths.forEach(ym => {
    var b = ymMap.get(ym.y + '-' + ym.m);
    if (!b) return;

    b.by.forEach((val, az) => {
      if (!isFinite(val)) return;
      if (!perAz.has(az)) perAz.set(az, []);
      perAz.get(az).push(val);
    });
  });

  var useGeo = isLogKPI(state.currentKpi);
  var vals   = [];   // tutti i valori aggregati (serve per istogramma)
  var aziAgg = null; // aggregato dell'azienda selezionata

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
    if (pbNo) pbNo.textContent = '-- percentile';
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
  var edges = [];

  if (mn === mx) {
    // Tutti i valori uguali: un unico bin centrato
    bins   = 1;
    step   = 1;
    edges = [mn - 0.5, mn + 0.5];
    centers = [mn];
    counts  = [vals.length];
  } else {
    step = (mx - mn) / bins;
    if (!isFinite(step) || step <= 0) step = 1;

    edges = [];
    for (var bIdx = 0; bIdx <= bins; bIdx++) {
      edges.push(mn + bIdx * step);
    }

    centers = [];
    for (var bIdx2 = 0; bIdx2 < bins; bIdx2++) {
      centers.push(mn + (bIdx2 + 0.5) * step);
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
    y: Math.round((counts[i] / total) * 1000) / 10,
    count: counts[i],
    from: edges[i],
    to: edges[i + 1]
  }));

  // Percentile dell'azienda rispetto alla distribuzione
  var pr = percentileRank(vals, aziAgg);

  var unit = KPI_UNITS[state.currentKpi] || '';
  histChart.data.datasets[0].data = data;
  histChart.data.datasets[1].data = (aziAgg != null)
    ? [{
        x: aziAgg,
        y: 0,
        aziValue: aziAgg,
        unit
      }]
    : [];

  // Asse X, min/max "robusti" (se mn==mx espande leggermente)
  var axisMin = mn;
  var axisMax = mx;
  if (axisMin === axisMax) {
    axisMin = mn - 0.5;
    axisMax = mn + 0.5;
  }
  if (aziAgg != null && isFinite(aziAgg)) {
    var pad = isFinite(step) && step > 0 ? (step * 0.3) : 0.5;
    axisMin = Math.min(axisMin, aziAgg - pad);
    axisMax = Math.max(axisMax, aziAgg + pad);
  }

  histChart.options.scales.x = {
    type: 'linear',
    min: axisMin,
    max: axisMax,
    title: { display: !!unit, text: unit ? (state.currentKpi + ' ' + unit) : '' },
    ticks: {
      callback: (v) => isFinite(v) ? Number(v).toFixed(2) : v
    },
    afterBuildTicks: (scale) => {
      var tks = edges.map(v => ({ value: v }));
      scale.ticks = tks;
    }
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
              ' (PR ' + pr + '°)',
            rotation: 90,
            backgroundColor: 'rgba(239,68,68,0.15)',
            color: '#ef4444'
          }
        }
      }
    : {};

  histChart.options.plugins.tooltip = {
    enabled: true,
    displayColors: false,
    filter: function (item) {
      if (item.dataset && item.dataset._tag === 'bars') {
        var c = item.raw && item.raw.count;
        return isFinite(c) && c > 0;
      }
      return true;
    },
    callbacks: {
      label: function (ctx) {
        if (ctx.dataset && ctx.dataset._tag === 'azi') {
          var d = ctx.raw || {};
          var val = isFinite(d.aziValue) ? d.aziValue.toFixed(2) : '';
          return val ? ['Azienda: ' + val + (unit ? ' ' + unit : '')] : '';
        }
        var d2 = ctx.raw || {};
        var left = (d2.from != null && isFinite(d2.from)) ? d2.from.toFixed(2) : '?';
        var right = (d2.to != null && isFinite(d2.to)) ? d2.to.toFixed(2) : '?';
        var isLast = ctx.dataIndex === (ctx.chart.data.datasets[0].data.length - 1);
        var range = 'Range: [' + left + ' ; ' + right + (isLast ? ' ]' : ' [');
        var pct = isFinite(d2.y) ? 'Frequenza: ' + d2.y.toFixed(1) + '%' : '';
        var cnt = isFinite(d2.count) ? 'Aziende: ' + d2.count : '';
        return [range, pct, cnt].filter(Boolean);
      }
    }
  };

  histChart.update();

  var posBadge = document.getElementById('posBadge');
  if (posBadge) {
    posBadge.textContent = (pr != null) ? (pr + '° percentile') : '-- percentile';
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
 *        - false -> forza la selezione sull'ultima lattazione disponibile
 *        - true  -> se possibile mantiene la lattazione/custom gia selezionati
 * Relazioni: legge le lattazioni disponibili via getLactationStartsFromRows(rowsForKpi(getBenchmarkRaw())).
 */
function rebuildLactationMenu(preserveSelection = false) {
  // Aggiorna le opzioni del select #distPreset in base alle lattazioni disponibili e alle scelte precedenti
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
      // state.histPeriod (from/to) resta com'e
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

    // Se arrivo qui, non posso preservare -> vado in fallback sotto
  }

  // Fallback standard: se ci sono lattazioni -> ultima, altrimenti custom vuoto
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
 * includendo eventualmente le estremita dell'intervallo (from/to).
 * @param {HTMLSelectElement} presetEl select #distPreset
 * @param {Date|null} fromD data inizio intervallo
 * @param {Date|null} toD data fine intervallo
 */
function setCustomLabelText(presetEl, fromD, toD) {
  if (!presetEl) return;
  var optCustom = Array.from(presetEl.options).find(o => o.value === 'custom');
  if (!optCustom) return;

  if (fromD && toD) {
    optCustom.textContent =
      'Intervallo personalizzato (' +
      formatMonth(fromD) +
      ' - ' +
      formatMonth(toD) +
      ')';
  } else {
    optCustom.textContent = 'Intervallo personalizzato';
  }
}

/**
 * Sincronizza la UI (select distPreset + pannello custom + campi mese)
 * con lo stato corrente in state.histPeriod.
 * @returns {void}
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
  // Modalita legacy "ultimi N mesi"
    setCustomLabelText(presetEl, null, null);
  }
}


// ============================================================================
// INIZIALIZZAZIONE PRINCIPALE
// ============================================================================

(function init() {
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
          // Se ho gia una lattazione valida, la mantengo
          hp.type === 'lactation' ||
          // Se ho un custom reale (from/to Date), lo mantengo
          (hp.type === 'custom' && hp.from instanceof Date && hp.to instanceof Date)
        );

      // Prima volta (custom null o months) -> shouldPreserve = false
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

  /**
   * Applica la vista attiva (miei dati vs confronto) mostrando/nascondendo i container.
   * Dipendenze: radio #miei-dati/#confronto, wrapper view-miei/view-conf, pannello benchmark options.
   * Effetto collaterale: in modalita "miei" nasconde le opzioni benchmark; in "confronto" le mostra.
   */
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

      // input type="month" e "YYYY-MM"
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

  // ----- Primo render con RAW disponibile -----
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
        // Fallback se il select KPI non e presente
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

// Quando arrivano i dati CAO (campioni conferitori) rilancia i render
document.addEventListener('cao:loaded', function () {
  if (cache && cache.ymByKpi) cache.ymByKpi.clear();
  var rows = rowsForKpi(getBenchmarkRaw(), state.currentKpi || 'cellule');
  updateBenchmarkCountLabel(rows);
  updateCaseificioLabel();
  updatePR(rows);
  updateKPI(rows);
  updateHistogram(rows);
  scheduleSync();
});


// ============================================================================
// PULSANTE CREDITS (popover hi-tech)
// ============================================================================

function showCredit() {
  var existing = document.getElementById('creditOverlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'creditOverlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    background: 'radial-gradient(circle at 20% 20%, rgba(59,130,246,0.18), transparent 32%), radial-gradient(circle at 80% 25%, rgba(16,185,129,0.20), transparent 28%), rgba(9,12,20,0.78)',
    backdropFilter: 'blur(6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '9999',
    opacity: '0',
    transition: 'opacity 220ms ease'
  });

  var panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'relative',
    maxWidth: '480px',
    width: '90%',
    padding: '20px 22px',
    borderRadius: '16px',
    background: 'linear-gradient(135deg, rgba(15,23,42,0.92), rgba(30,41,59,0.9))',
    boxShadow: '0 20px 60px rgba(0,0,0,0.35), 0 0 0 1px rgba(59,130,246,0.25)',
    color: '#e2e8f0',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    overflow: 'hidden',
    textAlign: 'center'
  });

  var accent = document.createElement('div');
  Object.assign(accent.style, {
    position: 'absolute',
    inset: '-35% -35% auto auto',
    width: '240px',
    height: '240px',
    background: 'radial-gradient(circle, rgba(59,130,246,0.35), transparent 60%)',
    filter: 'blur(10px)',
    pointerEvents: 'none'
  });

  var title = document.createElement('div');
  Object.assign(title.style, {
    fontSize: '18px',
    fontWeight: '700',
    letterSpacing: '0.3px',
    color: '#60a5fa',
    marginBottom: '6px'
  });
  title.textContent = 'Credits';

  var body = document.createElement('div');
  Object.assign(body.style, {
    fontSize: '14px',
    lineHeight: '1.6',
    color: '#cbd5e1',
    marginBottom: '10px',
    textAlign: 'center'
  });
  body.innerHTML = [
    'Prototipo realizzato da Team App\u00e0re',
    'Dip. di Medicina Veterinaria \u00b7 Universit\u00e0 di Sassari',
    '2025'
  ].join('<br>');

  var imgWrap = document.createElement('div');
  Object.assign(imgWrap.style, {
    marginBottom: '12px',
    textAlign: 'center'
  });
  var img = document.createElement('img');
  img.src = 'landing/dipartimento.png';
  img.alt = 'Dipartimento di Medicina Veterinaria';
  Object.assign(img.style, {
    maxWidth: '260px',
    width: '80%',
    filter: 'drop-shadow(0 12px 22px rgba(0,0,0,0.30))'
  });
  img.onerror = function() { imgWrap.remove(); };
  imgWrap.appendChild(img);

  var close = document.createElement('button');
  Object.assign(close.style, {
    position: 'absolute',
    top: '10px',
    right: '10px',
    width: '28px',
    height: '28px',
    borderRadius: '8px',
    border: '1px solid rgba(148,163,184,0.35)',
    background: 'rgba(15,23,42,0.6)',
    color: '#e2e8f0',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: '1',
    transition: 'all 150ms ease'
  });
  close.textContent = '\u00d7';
  close.onmouseenter = function() { close.style.background = 'rgba(59,130,246,0.25)'; };
  close.onmouseleave = function() { close.style.background = 'rgba(15,23,42,0.6)'; };
  close.onclick = function() {
    overlay.style.opacity = '0';
    setTimeout(function() { overlay.remove(); }, 180);
  };

  panel.appendChild(accent);
  panel.appendChild(close);
  panel.appendChild(title);
  panel.appendChild(imgWrap);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  requestAnimationFrame(function() { overlay.style.opacity = '1'; });
}

(function bindCreditButton() {
  var btn = document.getElementById('credit');
  if (!btn) return;

  btn.style.cursor = 'pointer';
  btn.addEventListener('mouseenter', function() { btn.style.opacity = '0.85'; });
  btn.addEventListener('mouseleave', function() { btn.style.opacity = '1'; });
  btn.addEventListener('click', showCredit);
})();




