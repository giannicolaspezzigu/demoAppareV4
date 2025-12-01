// benchmarkTrasformatore.js - Vista "Benchmark" per il caseificio
/**
 * Modulo principale per la vista Benchmark del trasformatore.
 * - Gestisce i grafici Chart.js: KPI storico (line) e distribuzione (istogramma).
 * - Usa i dati grezzi caricati da dataLoader/loaderCaseificio (data.json) e li aggrega.
 * - Filtri disponibili: KPI selezionato, modalita' gruppo vs caseificio, periodo (lattazione o range).
 * Flusso principale:
 *   1) init() -> bindUi() -> primo render (KPI + istogramma) e setup preset istogramma.
 *   2) renderKpiChart() costruisce i dataset con buildKpiData() e aggiorna badge/legenda.
 *   3) renderHistogram() legge histPeriod, prepara bins e annotazioni, mostra percentile.
 * Sorgenti dati:
 *   - window.CAO_TANK da datiCAO.json (storico cisterna CAO, medie ponderate mensili).
 *   - window.CAO_RAW da conferitoriCAO-*.json (campioni conferitori per lattazione) via loaderCaseificio.
 *   - window.RAW da dataLoader.js (data.json) per il benchmark inter-aziendale intraAppare.
 * Controlli UI collegati: select KPI (indicatore), provincia, aziendaSelect, distPreset/customPeriod,
 * toggle benchmarkType e checkbox lattazioni (year-boxes), toggle showMedian, selettori date.
 * Stato/trigger: histPeriod governa l'istogramma; rawReady segnala arrivo dati RAW; eventi
 * "raw:loaded" (dataLoader) e "cao:loaded" (loaderCaseificio) riattivano renderKpiChart/renderHistogram.
 * La logica esistente resta invariata: il commento riassume flussi, dipendenze e punti di ingresso.
 */
(function () {
  /** @type {Chart|null} handler Chart.js per il grafico KPI storico */
  let kpiChart = null;

  /** @type {Chart|null} handler Chart.js per l'istogramma distribuzione */
  let histChart = null;

  // Etichette asse X per lattazione (Ott-Set)
  const LATT_MONTH_LABELS = ['Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set'];

  // Palette colori per le lattazioni (max 3, come in app.js)
  const LAC_COLORS = ['#3b82f6', '#f59e0b', '#22c55e'];

  // Mappa stabile: startYear (string) -> colore, così colori e pallini restano allineati
  const LAC_COLOR_MAP = {};

  // Flag per non ricostruire 100 volte le checkbox
  let yearBoxesInitialized = false;

  // Flag per capire se i dati RAW (data.json) sono arrivati
  let rawReady = false;

  // Stato periodo istogramma (lattazione o intervallo custom) usato da renderHistogram/ensureHistPreset
  let histPeriod = { type: 'lactation', start: null, from: null, to: null };

  // ---------- KPI: unità e alias (qui i KPI sono leggermente diversi dall'allevatore) ----------
  /**
   * Dizionari di supporto per i KPI specifici della vista trasformatore:
   * - KPI_UNITS mappa KPI -> unita' di misura per etichette e tooltip.
   * - KPI_ALIASES definisce sinonimi accettati per collegare select/label ai dati.
   */
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
    caseina:   ['caseina', 'caseine'],
    urea:      ['urea']
  };

  /**
   * Normalizza la chiave KPI omogeneizzando sinonimi e maiuscole/minuscole.
   * Serve per collegare select UI, alias e mappa unita' usando la stessa chiave interna.
   * @param {string} key Nome KPI selezionato o alias possibile.
   * @returns {string} Chiave KPI normalizzata (es. 'grasso', 'caseina').
   */
  function normalizeKpiKey(key) {
    const k = String(key || '').toLowerCase();
    if (k === 'caseine') return 'caseina';
    if (k === 'caseina') return 'caseina';
    if (k === 'grassi')  return 'grassi';
    if (k === 'grasso') return 'grasso';
    return k;
  }

  /**
   * Legge il KPI scelto nella select e lo riporta nella forma normalizzata.
   * @returns {string} Chiave KPI valida; default 'grasso' se select assente.
   */
  function getSelectedKpi() {
    const sel = document.getElementById('indicatore');
    if (!sel) return 'grasso';
    return normalizeKpiKey(sel.value || 'grasso');
  }

  /**
   * Restituisce l'unita' di misura per il KPI selezionato.
   * @param {string} k Chiave o alias KPI.
   * @returns {string} Unita' testuale (es. 'mg/dL').
   */
  function getKpiUnit(k) {
    const key = normalizeKpiKey(k);
    return KPI_UNITS[key] || '';
  }

  /**
   * Ritorna l'elenco di alias ammessi per un KPI, in minuscolo.
   * @param {string} k Chiave KPI.
   * @returns {string[]} Lista alias utilizzata per matching case-insensitive.
   */
  function getAliasesFor(k) {
    const key = normalizeKpiKey(k);
    return (KPI_ALIASES[key] || [key]).map(s => String(s).toLowerCase());
  }

  /**
   * Calcola la media aritmetica ignorando valori non numerici.
   * @param {Array<number>} values Lista di valori da mediare.
   * @returns {number|null} Media o null se lista vuota/invalidi.
   */
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

  /**
   * Indica se il KPI va aggregato in scala logaritmica (cellule/cbt).
   * @param {string} k Chiave KPI.
   * @returns {boolean} True se usa scala log.
   */
  function isLogKpi(k) {
    return k === 'cellule' || k === 'carica';
  }

  /**
   * Calcola la media geometrica (per KPI log) filtrando numeri finiti > 0.
   * @param {Array<number>} values Valori grezzi.
   * @returns {number|null} Media geometrica o null se non calcolabile.
   */
  function aggGeometric(values) {
    let sum = 0;
    let n   = 0;
    for (const v of values) {
      const num = Number(v);
      if (Number.isFinite(num) && num > 0) {
        sum += Math.log(num);
        n++;
      }
    }
    return n ? Math.exp(sum / n) : null;
  }

  /**
   * Calcola il percentile rank di un valore rispetto a un array numerico.
   * @param {Array<number>} arr Serie valori grezzi (vengono filtrati e ordinati).
   * @param {number} v Valore di cui stimare il percentile.
   * @returns {number|null} Percentile arrotondato o null se non valutabile.
   */
  function percentileRank(arr, v) {
    const nums = arr
      .filter(x => typeof x === 'number' && Number.isFinite(x))
      .sort((a, b) => a - b);

    if (!nums.length || typeof v !== 'number' || !Number.isFinite(v)) return null;

    let count = 0;
    let ties  = 0;
    for (const x of nums) {
      if (x < v) count++;
      else if (x === v) ties++;
    }
    return Math.round(((count + 0.5 * ties) / nums.length) * 100);
  }

  // ---------- Mappa Anno/Mese -> lattazione (Ott-Set) ----------
  /**
   * Converte anno/mese gregoriano nella lattazione (Ott-Set) e indice 0..11.
   * Esempi: 2022-10 -> startYear=2022, index=0; 2023-01 -> startYear=2022, index=3.
   * @param {number} anno Anno gregoriano.
   * @param {number} mese Mese 1..12.
   * @returns {{startYear:number|null,index:number|null}} Anno avvio lattazione e indice mese.
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
   * Raggruppa i campioni per lattazione (startYear) mantenendo indice mese.
   * @param {Array<Object>} rows Record grezzi con anno/mese e KPI.
   * @returns {Map<string, Array<Object>>} Mappa startYear -> lista campioni per quella lattazione.
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
   * Costruisce una checkbox per ogni lattazione disponibile (max 3) se non gia' presenti.
   * Mantiene colori stabili usando LAC_COLOR_MAP.
   * @param {Map<string, Array<Object>>} lactMap Dati raggruppati per lattazione.
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
      // solo l'ultima lattazione (più recente) è selezionata di default
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

  /**
   * Ritorna la lista di lattazioni attive (checkbox selezionate) per il grafico KPI.
   * @returns {Array<string>} Chiavi startYear per le lattazioni abilitate.
   */
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

  /**
   * Legge il toggle gruppo/caseificio per sapere quale confronto usare.
   * @returns {'intraCaseificio'|'interGruppo'} Modalita' selezionata.
   */
  function getBenchmarkMode() {
    const sel = document.getElementById('benchmarkType');
    return sel && sel.value ? String(sel.value) : 'intraAppare';
  }

  /**
   * Recupera il nome provincia selezionato nel dropdown.
   * @returns {string|null} Nome provincia o null se non impostato.
   */
  function getSelectedProvinceName() {
    const provSel = document.getElementById('provinciaFilter');
    const provVal = provSel && provSel.value ? provSel.value : 'tutte';
    if (provVal === 'sassari')       return 'Sassari';
    if (provVal === 'nuoro')         return 'Nuoro';
    if (provVal === 'oristano')      return 'Oristano';
    if (provVal === 'cagliari')      return 'Cagliari';
    return null;
  }
  // ---------- filtri benchmark / RAW intraAppare ----------
  /**
   * Filtra i dati grezzi caricati in window.BENCHMARK_TRASFORMATORE_RAW per caseificio e provincia.
   * - Provincia: se il selector non e' su "tutte" mantiene solo la provincia selezionata.
   * - Caseificio: filtra per caseificioName presente nei campi del dataset.
   * Dipendenze: usa getBenchmarkMode per capire se servono RAW (intraAppare) o CAO_RAW (intraCaseificio).
   * @returns {Array<Object>} Lista record filtrati da usare per le aggregazioni KPI.
   */
  function filterRawByCaseificioAndProvincia() {
    const mode = getBenchmarkMode();

    // Intracaseificio: usa dataset CAO
    if (mode === 'intraCaseificio') {
      const base = Array.isArray(window.CAO_RAW) ? window.CAO_RAW : [];
      const provName = getSelectedProvinceName();
      const rows = provName
        ? base.filter(r => r && String(r.Provincia || '').trim() === provName)
        : base.slice();
      return { rows, nAziende: 0, nCampioni: rows.length };
    }

    // IntraAppare: usa RAW (data.json)
    const base = Array.isArray(window.RAW) ? window.RAW : [];
    if (!base.length) {
      return { rows: [], nAziende: 0, nCampioni: 0 };
    }

    if (mode !== 'intraAppare') {
      return { rows: [], nAziende: 0, nCampioni: 0 };
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

    const provName = getSelectedProvinceName();
    if (provName) {
      rows = rows.filter(r => {
        if (!r) return false;
        return String(r.Provincia || '').trim() === provName;
      });
    }

    const aziSet = new Set();
    for (const r of rows) {
      if (r && r.Azienda) aziSet.add(String(r.Azienda));
    }

    return { rows, nAziende: aziSet.size, nCampioni: rows.length };
  }
  /**
   * Aggrega per mese calcolando la media per KPI per ogni azienda e poi la media del gruppo.
   * - Lavora su rawRows filtrate, raggruppa per azienda, poi fa media aritmetica o geometrica.
    * - Flusso: filtra per KPI -> media per (azienda, anno, mese) -> media delle aziende per mese.
   * @param {Array<Object>} rawRows Dati grezzi filtrati.
   * @param {string} kpiKey Chiave KPI normalizzata.
   * @returns {Array<Object>} Lista con {year, month, value, by: Map(azienda->media)}.
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

  /**
   * Calcola la media per mese aggregando direttamente i campioni (tutti i caseifici inclusi).
   * Usato per la modalita' gruppo senza distinguere per azienda.
   * @param {Array<Object>} rawRows Dati grezzi filtrati.
   * @param {string} kpiKey Chiave KPI normalizzata.
   * @returns {Array<Object>} Lista {year, month, value}.
   */
  function computeSampleMonthlyMeans(rawRows, kpiKey) {
    if (!Array.isArray(rawRows) || !rawRows.length) return [];
    const aliases = getAliasesFor(kpiKey);
    const ym = new Map(); // "Anno|Mese" -> [valori]

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

      const key = anno + '|' + mese;
      if (!ym.has(key)) ym.set(key, []);
      ym.get(key).push(val);
    }

    const out = [];
    ym.forEach((vals, key) => {
      const parts = key.split('|');
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      const agg = isLogKpi(kpiKey) ? aggGeometric(vals) : arithmeticMean(vals);
      if (agg != null) out.push({ Anno: y, Mese: m, Valore: agg });
    });

    return out;
  }
  /**
   * Estrae dai dati grezzi solo i record che contengono il KPI richiesto.
   * @param {Array<Object>} rawRows Dati grezzi.
   * @param {string} kpiKey KPI normalizzato.
   * @returns {Array<Object>} Record con {year, month, value, caseificioName, provinciaName, aziendaId}.
   */
  function rowsForKpi(rawRows, kpiKey) {
    if (!Array.isArray(rawRows) || !rawRows.length) return [];
    const aliases = getAliasesFor(kpiKey);
    const out = [];

    for (const r of rawRows) {
      if (!r) continue;
      const k = String(r.KPI || '').toLowerCase();
      if (!aliases.includes(k)) continue;

      let y, m;
      if (r.Anno != null && r.Mese != null) {
        y = Number(r.Anno);
        m = Number(r.Mese) - 1; // 0-based
      } else if (r.Data) {
        const d = new Date(r.Data);
        if (!Number.isFinite(d.getTime())) continue;
        y = d.getFullYear();
        m = d.getMonth();
      } else {
        continue;
      }

      const v = Number(r.Valore);
      if (!Number.isFinite(v)) continue;

      out.push({ Azienda: String(r.Azienda || ''), year: y, month: m, value: v });
    }

    return out;
  }

  /**
   * Aggrega mensilmente un KPI per il caseificio corrente (media su campioni).
   * @param {Array<Object>} rawRows Dati grezzi filtrati per caseificio/provincia.
   * @param {string} kpiKey KPI normalizzato.
   * @returns {Array<Object>} Record mensili {year, month, value}.
   */
  function monthlyAggregate(rawRows, kpiKey) {
    const byKey = new Map();
    const useGeo = isLogKpi(kpiKey);

    rawRows.forEach(r => {
      const key = r.year + '|' + r.month + '|' + r.Azienda;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r.value);
    });

    const out = [];
    byKey.forEach((vals, keyStr) => {
      const [y, m, az] = keyStr.split('|');
      const agg = useGeo ? aggGeometric(vals) : arithmeticMean(vals);
      if (agg != null) {
        out.push({ Azienda: az, year: Number(y), month: Number(m), value: agg });
      }
    });

    return out;
  }

  /**
   * Costruisce una mappa year-month -> media mensile del KPI.
   * Utile per confrontare per mese i valori caseificio vs gruppo.
   * @param {Array<Object>} rawRows Dati grezzi filtrati.
   * @param {string} kpiKey KPI normalizzato.
   * @returns {Map<string, Object>} Mappa "YYYY-M" -> {year, month, value, by?:Map}.
   */
  function buildYMMap(rawRows, kpiKey) {
    const agg = monthlyAggregate(rawRows, kpiKey);
    const map = new Map();

    agg.forEach(r => {
      const key = r.year + '-' + r.month;
      if (!map.has(key)) {
        map.set(key, { year: r.year, month: r.month, by: new Map() });
      }
      map.get(key).by.set(r.Azienda, r.value);
    });

    return map;
  }

  /**
   * Genera l'etichetta testuale di una lattazione (es. 2023/24).
   * @param {number} yStart Anno di inizio (Ottobre).
   * @returns {string} Etichetta friendly.
   */
  function lactationLabel(yStart) {
    const yEnd = (yStart + 1).toString().slice(-2);
    return yStart + '-' + yEnd;
  }

  // ---------- costruzione dati per il grafico KPI ----------
  /**
   * Prepara labels e datasets per il grafico KPI:
   *  - serie CAO cisterna da window.CAO_TANK (datiCAO.json) + campioni conferitori window.CAO_RAW.
   *  - opzionalmente serie "media gruppo" calcolata da RAW (data.json) quando benchmarkType = intraAppare.
   */
  /**
   * Prepara tutte le strutture dati KPI necessarie al grafico linea e ai calcoli istogramma.
   * - Filtra i dati grezzi per caseificio/provincia (CAO_RAW/RAW) e KPI.
   * - Costruisce mappe per lattazione, mese, caseificio (CAO_TANK) e gruppo (RAW) per il confronto.
   * Dipendenze: usa ensureYearBoxes per la UI lattazioni, getBenchmarkMode per sapere se includere il gruppo.
   * @returns {{lactMap: Map<string, Array>, caseificioYM: Map<string, Object>, groupYM: Map<string, Object>, kpiKey: string, kpiRows: Array<Object>}} Raccolta dataset pronti per il rendering.
   */
  function buildKpiData() {
    const mode = getBenchmarkMode();
    if (!window.CAO || !Array.isArray(window.CAO_RAW)) {
      return { labels: LATT_MONTH_LABELS, datasets: [], nAziende: 0, nCampioni: 0, unit: '' };
    }

    const kpi = getSelectedKpi();
    const unit = '%';
    const provName = getSelectedProvinceName();

    const rowsTank = window.CAO.filterTank
      ? window.CAO.filterTank({ kpi, provincia: provName || undefined })
      : [];
    if (!rowsTank.length) {
      return { labels: LATT_MONTH_LABELS, datasets: [], nAziende: 0, nCampioni: 0, unit };
    }

    // i valori cisterna sono già mensili: li mappiamo per lattazione
    const lactMapCao = groupByLactation(rowsTank);

    // Costruisco UNA sola volta le checkbox delle lattazioni (con regola "minimo 4 mesi")
    if (!yearBoxesInitialized) {
      ensureYearBoxes(lactMapCao);
    }

    const activeKeys = getActiveLactationKeys();
    if (!activeKeys.length) {
      return {
        labels: LATT_MONTH_LABELS,
        datasets: [],
        nAziende: 0,
        nCampioni: 0,
        unit
      };
    }

    const datasets = [];
    activeKeys.forEach((key, idx) => {
      const l = lactMapCao[key];
      if (!l) return;
      const color = LAC_COLOR_MAP[key] || LAC_COLORS[idx % LAC_COLORS.length];
      datasets.push({
        label: l.label + ' - CAO',
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

    let nAziende = 0;
    let nCampioni = 0;
    const medianToggle = ensureGroupToggle();
    const showGroup    = !medianToggle || !!medianToggle.checked;

    if (mode === 'intraAppare' && Array.isArray(window.RAW) && window.RAW.length) {
      const { rows, nAziende: nAz } = filterRawByCaseificioAndProvincia();
      nAziende = nAz;

      if (rows.length && nAziende > 0) {
        const groupMonthly = computeGroupMonthlyMeans(rows, kpi);
        const lactMapGroup = groupByLactation(groupMonthly);

        activeKeys.forEach((key, idx) => {
          const lg = lactMapGroup[key];
          if (!lg) return;
          const color = LAC_COLOR_MAP[key] || LAC_COLORS[idx % LAC_COLORS.length];
          datasets.push({
            label: lg.label + ' - media gruppo',
            data: lg.values,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderDash: [5, 4],
            spanGaps: true,
            hidden: !showGroup,
            _seriesType: 'group'
          });
        });
      }
    }

    if (mode === 'intraCaseificio') {
      const { rows } = filterRawByCaseificioAndProvincia();
      // consideriamo solo i campioni del KPI selezionato (alias inclusi)
      const aliases = getAliasesFor(kpi);
      const rowsKpi = rows.filter(r => aliases.includes(String(r.KPI || '').toLowerCase()));
      if (rowsKpi.length) {
        const monthSet = new Set(rowsKpi.map(r => `${r.Anno}-${r.Mese}`));
        const monthly = computeSampleMonthlyMeans(rowsKpi, kpi);
        const lactMapGroup = groupByLactation(monthly);

        activeKeys.forEach((key, idx) => {
          const lg = lactMapGroup[key];
          if (!lg) return;
          const color = LAC_COLOR_MAP[key] || LAC_COLORS[idx % LAC_COLORS.length];
          datasets.push({
            label: lg.label + ' - media campioni',
            data: lg.values,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            tension: 0.25,
            pointRadius: 0,
            pointHoverRadius: 4,
            borderDash: [5, 4],
            spanGaps: true,
            hidden: !showGroup,
            _seriesType: 'group'
          });
        });

        if (monthSet.size > 0) {
          nCampioni = Math.round(rowsKpi.length / monthSet.size); // campioni medi al mese (solo KPI selezionato)
        } else {
          nCampioni = 0;
        }
      }
    }

    return {
      labels: LATT_MONTH_LABELS,
      datasets,
      nAziende,
      nCampioni,
      unit
    };
  }

  // ---------- titolo (uno solo, con N aziende/campioni) ----------
  /**
   * Aggiorna il titolo/sottotitolo della card KPI con contatori aziende/campioni.
   * Dipendenze: usa getBenchmarkMode per capire se mostrare anche il badge provinciale.
   * @param {number} nAziende Numero aziende considerate.
   * @param {number} nCampioni Numero campioni nel periodo.
   */
  function updateTitle(nAziende, nCampioni) {
    const card = document.querySelector('#kpiChartHost')?.closest('.card');
    if (!card) return;

    const titleEl  = card.querySelector('.card-title');
    const legendEl = card.querySelector('.legend');
    const mode     = getBenchmarkMode();

    if (titleEl) {
      if (mode === 'intraCaseificio' && nCampioni && nCampioni > 0) {
        titleEl.textContent = 'Dati Caseificio vs media di circa ' + nCampioni + ' campioni mensili';
      } else if (nAziende && nAziende > 0) {
        titleEl.textContent = 'Dati Caseificio vs media del gruppo di ' + nAziende + ' aziende';
      } else {
        titleEl.textContent = 'Dati Caseificio';
      }
    }

  }


  // Crea, se manca, la checkbox "Mostra media gruppo" accanto al titolo
  /**
   * Inizializza il toggle "confronto gruppo" assicurando un default coerente.
   * Se ci sono poche aziende o KPI log, forza il caso 'intraCaseificio' per evitare rumore.
   */
  function ensureGroupToggle() {
    const head = document.getElementById('kpiChartHost')?.previousElementSibling;
    if (!head) return null;

    let toggle = document.getElementById('showMedian');
    if (toggle) {
      const lbl = toggle._labelNode || toggle.nextElementSibling;
      if (lbl) {
        const mode = getBenchmarkMode();
        lbl.textContent = (mode === 'intraCaseificio') ? 'Mostra media gruppo' : 'Mostra media aziende';
      }
      return toggle;
    }

    const legendHost = head.querySelector('.legend') || head;
    legendHost.textContent = '';
    legendHost.style.display = 'block';
    legendHost.style.marginTop = '6px';

    const row = document.createElement('div');
    row.style.display = 'inline-flex';
    row.style.alignItems = 'center';
    row.style.gap = '12px';
    row.style.fontSize = '14px';
    row.style.marginTop = '0';
    row.style.color = '#0f172a';

    const wrap = document.createElement('label');
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';

    // se esiste già, riusalo per non perdere gli handler
    toggle = document.getElementById('showMedian') || document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'showMedian';
    // all'avvio/refresh la vogliamo selezionata
    toggle.checked = true;

    const txt = document.createElement('span');
    const mode = getBenchmarkMode();
    txt.textContent = 'Mostra media';
    toggle._labelNode = txt;

    wrap.appendChild(toggle);
    wrap.appendChild(txt);

    /**
     * Costruisce un elemento legenda inline con linea piena o tratteggiata.
     * @param {string} label Testo etichetta.
     * @param {boolean} dashed True se linea tratteggiata.
     * @returns {HTMLSpanElement} Nodo legenda pronto per l'uso.
     */
    function legendItem(label, dashed) {
      const item = document.createElement('span');
      item.style.display = 'inline-flex';
      item.style.alignItems = 'center';
      item.style.gap = '6px';

      const line = document.createElement('span');
      line.style.display = 'inline-block';
      line.style.width = '28px';
      line.style.height = '0';
      line.style.borderTop = dashed ? '2px dashed currentColor' : '2px solid currentColor';

      const lab = document.createElement('span');
      lab.textContent = label;

      item.appendChild(line);
      item.appendChild(lab);
      return item;
    }

    const groupLabel = (mode === 'intraCaseificio') ? 'Media campioni' : 'Media aziende';
    row.appendChild(legendItem('Media caseificio', false));
    row.appendChild(legendItem(groupLabel, true));
    row.appendChild(wrap);

    legendHost.appendChild(row);

    return toggle;
  }
  // ---------- render grafico KPI ----------
  /**
   * Disegna/aggiorna il grafico KPI storico (linee per lattazioni selezionate).
   * Flusso: costruisce i dataset da buildKpiData(), seleziona le lattazioni attive,
   * imposta le serie Chart.js e sincronizza badge percentile e legenda.
   * Gestisce anche l'avvio di rendering istogramma dopo l'update del line chart.
   */
  function renderKpiChart() {
    const canvas = document.querySelector('#kpiChartHost canvas');
    if (!canvas || !canvas.getContext || typeof Chart === 'undefined') return;

    const ctx = canvas.getContext('2d');

    const mode = getBenchmarkMode();
    if (mode === 'intraCaseificio' && window.CAO && typeof window.CAO.ensureLoaded === 'function') {
      const hasData = Array.isArray(window.CAO_RAW) && window.CAO_RAW.length > 0;
      const loading = window.CAO.isLoading ? window.CAO.isLoading() : false;
      if (!hasData && !loading) window.CAO.ensureLoaded();
    }

    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (kpiChart) {
      kpiChart.destroy();
      kpiChart = null;
    }

    const cfg = buildKpiData();
    updateTitle(cfg.nAziende, cfg.nCampioni);
    const kpiSelect = document.getElementById('indicatore');
    const kpiLabel =
      (kpiSelect && kpiSelect.options && kpiSelect.selectedIndex >= 0)
        ? (kpiSelect.options[kpiSelect.selectedIndex].text || cfg.kpi || '')
        : (cfg.kpi || '');

    kpiChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: cfg.labels,
        datasets: cfg.datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'nearest',
          intersect: false
        },
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
            mode: 'nearest',
            intersect: false,
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
              display: !!(cfg.unit || kpiLabel),
              text: cfg.unit ? `${kpiLabel} (${cfg.unit})` : kpiLabel
            },
            beginAtZero: false,
            ticks: {
              callback: (v) => {
                const num = Number(v);
                return Number.isFinite(num) ? `${num.toFixed(1)} %` : `${v} %`;
              }
            }
          }
        }
      }
    });
  }

  // Per ora lascio un placeholder per l'istogramma (a destra)
  /**
   * Mostra un istogramma vuoto con placeholder e nasconde badge percentile.
   * Usato quando non ci sono dati nel range selezionato.
   */
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

  // Nuova implementazione istogramma (dataset gruppo + linea media caseificio)
  /**
   * Crea lazily l'istanza Chart.js per l'istogramma se non gia' esistente.
   * Conserva le opzioni base e aggiorna solo dataset/opzioni successivamente.
   * Dataset: barre (frequenza %), scatter per la media caseificio, linea orizzontale per la media gruppo.
   * @returns {Chart|null} Riferimento al grafico.
   */
  function ensureHistChart() {
    const canvas = document.querySelector('#histChartHost canvas');
    if (!canvas || !canvas.getContext || typeof Chart === 'undefined') return null;

    if (histChart && histChart.canvas === canvas) return histChart;

    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    const ctx = canvas.getContext('2d');
    histChart = new Chart(ctx, {
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
            label: 'Caseificio',
            data: [],
            backgroundColor: '#f43f5e',
            borderColor: '#f43f5e',
            pointRadius: 2.5,
            pointHoverRadius: 7,
            pointHitRadius: 10,
            showLine: false,
            _tag: 'caseificio'
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
            ticks: { callback: (v) => v + '%' }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          annotation: { annotations: {} }
        }
      }
    });

    return histChart;
  }

  /**
   * Restituisce la mappa mensile del KPI per il caseificio (CAO) filtrata per provincia.
   * @param {string} kpiKey KPI normalizzato.
   * @param {string|null} provinciaName Nome provincia o null per tutte.
   * @returns {Map<string, {year:number, month:number, value:number}>} Mappa "YYYY-M" -> valore.
   */
  function getCaoMonthMap(kpiKey, provinciaName = null) {
    if (!window.CAO) return new Map();
    const rows = window.CAO.filterTank
      ? window.CAO.filterTank({ kpi: kpiKey, provincia: provinciaName || undefined })
      : [];
    const tmp = new Map();

    rows.forEach(r => {
      if (!r) return;
      const y = Number(r.Anno);
      const m = Number(r.Mese) - 1;
      const v = Number(r.Valore);
      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(v)) return;
      const key = y + '-' + m;
      if (!tmp.has(key)) tmp.set(key, []);
      tmp.get(key).push(v);
    });

    const out = new Map();
    tmp.forEach((vals, keyStr) => {
      const agg = arithmeticMean(vals);
      if (agg == null) return;
      const parts = keyStr.split('-').map(Number);
      out.set(keyStr, { year: parts[0], month: parts[1], value: agg });
    });

    return out;
  }

  /**
   * Calcola le lattazioni disponibili per l'istogramma (ultime 3 con almeno 4 mesi).
   * @param {string} kpiKey KPI normalizzato.
   * @returns {Array<number>} Lista anni di inizio lattazione ordinata crescente.
   */
  function availableLactationStarts(kpiKey) {
    const map = getCaoMonthMap(kpiKey, getSelectedProvinceName());
    const counts = new Map(); // startYear -> mesi con valore

    map.forEach(obj => {
      if (!obj) return;
      const start = obj.month >= 9 ? obj.year : (obj.year - 1);
      const key = String(start);
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const all = Array.from(counts.entries())
      .map(([k, c]) => ({ start: Number(k), count: c }))
      .filter(x => Number.isFinite(x.start))
      .sort((a, b) => a.start - b.start);

    // Applica la regola "almeno 4 campioni" per considerare l'ultima lattazione
    const filtered = all.filter(x => x.count >= 4);
    const useList = filtered.length ? filtered : all;

    return useList.slice(-3).map(x => x.start);
  }

  /**
   * Aggiorna il testo dell'opzione "custom" con il range selezionato (YYYY-MM -> YYYY-MM).
   * @param {HTMLSelectElement} selectEl Select dei preset.
   * @param {Date|null} from Data inizio.
   * @param {Date|null} to Data fine.
   */
  function setCustomLabelText(selectEl, from, to) {
    if (!selectEl) return;
    const opt = selectEl.querySelector('option[value="custom"]');
    if (!opt) return;
    if (from && to) {
      opt.textContent = 'Intervallo ' + formatMonth(from) + ' -> ' + formatMonth(to);
    } else {
      opt.textContent = 'Intervallo personalizzato';
    }
  }

  /**
   * Formatta una data al primo giorno del mese in stringa YYYY-MM.
   * @param {Date} d Data da formattare.
   * @returns {string} Stringa mese normalizzata.
   */
  function formatMonth(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }

  /**
   * Sincronizza i controlli UI (select preset e input date) con lo stato histPeriod.
   * Nasconde o mostra l'area custom in base al tipo selezionato.
   */
  function updatePeriodUIFromState() {
    const preset = document.getElementById('distPreset');
    const wrap   = document.getElementById('customPeriod');
    const fm     = document.getElementById('fromMonth');
    const tm     = document.getElementById('toMonth');

    if (!preset) return;

    if (histPeriod.type === 'lactation') {
      preset.value = 'lac:' + histPeriod.start;
      if (wrap) wrap.style.display = 'none';
    } else {
      preset.value = 'custom';
      if (wrap) wrap.style.display = 'flex';
      if (histPeriod.from && fm) fm.value = formatMonth(histPeriod.from);
      if (histPeriod.to && tm)   tm.value = formatMonth(histPeriod.to);
      setCustomLabelText(preset, histPeriod.from, histPeriod.to);
    }
  }

  /**
   * Trova la prima e ultima data disponibili per il KPI del caseificio.
   * Serve per limitare i range custom nell'istogramma.
   * @param {string} kpiKey KPI normalizzato.
   * @returns {{min: Date|null, max: Date|null}} Estremi temporali.
   */
  function getCaoBounds(kpiKey) {
    const map = getCaoMonthMap(kpiKey, getSelectedProvinceName());
    let minD = null;
    let maxD = null;
    map.forEach(obj => {
      if (!obj) return;
      const d = new Date(obj.year, obj.month, 1);
      if (!minD || d < minD) minD = d;
      if (!maxD || d > maxD) maxD = d;
    });
    return { min: minD, max: maxD };
  }

  /**
   * Popola la select dei preset istogramma con le lattazioni disponibili + opzione custom.
   * @param {boolean} preserveSelection Se true tenta di mantenere la scelta precedente.
   * Dipendenze: usa availableLactationStarts (su CAO), aggiorna histPeriod tramite updatePeriodUIFromState.
   */
  function ensureHistPreset(preserveSelection = false) {
    const preset = document.getElementById('distPreset');
    if (!preset) return;

    const prev = preset.value;
    const kpi  = getSelectedKpi();
    const starts = availableLactationStarts(kpi);

    preset.innerHTML = '';
    starts.forEach(y => {
      const opt = document.createElement('option');
      opt.value = 'lac:' + y;
      opt.textContent = 'Lattazione ' + lactationLabel(y);
      preset.appendChild(opt);
    });

    const optCustom = document.createElement('option');
    optCustom.value = 'custom';
    optCustom.textContent = 'Intervallo personalizzato';
    preset.appendChild(optCustom);

    let target = null;
    if (preserveSelection && prev) target = prev;

    const startList = starts.map(Number);
    if (target && target.startsWith('lac:')) {
      const ySel = Number(target.split(':')[1]);
      if (!startList.includes(ySel)) target = null;
    }

    if (!target) {
      const last = startList[startList.length - 1];
      if (Number.isFinite(last)) {
        target = 'lac:' + last;
        histPeriod = { type: 'lactation', start: last, from: null, to: null };
      } else {
        target = 'custom';
      }
    }

    preset.value = target;
    if (target === 'custom') {
      const bounds = getCaoBounds(kpi);
      if (histPeriod.type !== 'custom') {
        if (bounds.min && bounds.max) {
          histPeriod = { type: 'custom', from: bounds.min, to: bounds.max };
        } else {
          histPeriod = { type: 'custom', from: null, to: null };
        }
      } else {
        if ((!histPeriod.from || !histPeriod.to) && bounds.min && bounds.max) {
          histPeriod.from = histPeriod.from || bounds.min;
          histPeriod.to   = histPeriod.to   || bounds.max;
        }
      }
      setCustomLabelText(preset, histPeriod.from, histPeriod.to);
    } else if (target.startsWith('lac:')) {
      const ySel = Number(target.split(':')[1]);
      histPeriod = { type: 'lactation', start: ySel, from: null, to: null };
    }

    updatePeriodUIFromState();
  }

  /**
   * Costruisce e aggiorna l'istogramma di distribuzione per il KPI selezionato.
   * Flusso: legge histPeriod (lattazione o custom), filtra i mesi validi, calcola valori
   * per caseificio o gruppo, agg/rank percentile, setta annotazioni e badge percentile.
   * Dipendenze principali: ensureHistPreset per i preset, ensureHistChart per il canvas Chart.js,
   * freedmanBins per il numero di bin, getCaoMonthMap/computeGroupMonthlyMeans per i dati sorgente.
   * Gestisce fallback vuoto se non ci sono dati nel range.
   */
  function renderHistogram() {
    const chart = ensureHistChart();
    const posBadge = document.getElementById('posBadge');
    if (!chart) return;

    const mode = getBenchmarkMode();
    const kpi = getSelectedKpi();
    ensureHistPreset(true);

    const groupFiltered = filterRawByCaseificioAndProvincia();
    const rowsKpi = rowsForKpi(groupFiltered.rows, kpi);
    const by = buildYMMap(rowsKpi, kpi);

    const ymKeys = Array.from(by.keys())
      .map(k => {
        const parts = k.split('-').map(Number);
        return { y: parts[0], m: parts[1] };
      })
      .sort((a, b) => (a.y - b.y) || (a.m - b.m));

    if (!ymKeys.length) {
      chart.data.datasets[0].data = [];
      chart.options.plugins.annotation.annotations = {};
      chart.update();
      if (posBadge) posBadge.textContent = '-- percentile';
      return;
    }

    const fmEl = document.getElementById('fromMonth');
    const tmEl = document.getElementById('toMonth');
    const bounds = getCaoBounds(kpi);
    if (bounds.min && bounds.max) {
      const minStr = formatMonth(bounds.min);
      const maxStr = formatMonth(bounds.max);
      if (fmEl) { fmEl.min = minStr; fmEl.max = maxStr; }
      if (tmEl) { tmEl.min = minStr; tmEl.max = maxStr; }
    }

    if (histPeriod.type === 'lactation' && !Number.isFinite(histPeriod.start)) {
      const starts = availableLactationStarts(kpi);
      const last = starts[starts.length - 1];
      if (Number.isFinite(last)) histPeriod.start = last;
    }

    const inRangeMonths = [];
    if (histPeriod.type === 'lactation') {
      const y0 = Number(histPeriod.start);
      ymKeys.forEach(k => {
        if ((k.y === y0 && k.m >= 9) || (k.y === y0 + 1 && k.m <= 8)) {
          inRangeMonths.push(k);
        }
      });
    } else if (histPeriod.type === 'custom') {
      let fromD = histPeriod.from;
      let toD   = histPeriod.to;
      if (!fromD || !toD) {
        fromD = bounds.min;
        toD   = bounds.max;
        histPeriod.from = fromD;
        histPeriod.to   = toD;
        updatePeriodUIFromState();
      }
      if (fromD && toD && fromD > toD) {
        const tmp = fromD;
        fromD = toD;
        toD = tmp;
      }
      ymKeys.forEach(k => {
        const d = new Date(k.y, k.m, 1);
        if (fromD && toD && d >= fromD && d <= toD) {
          inRangeMonths.push(k);
        }
      });
    }

    const useGeo = isLogKpi(kpi);
    let vals = [];

    if (mode === 'intraCaseificio') {
      const ymSet = new Set(inRangeMonths.map(ym => ym.y + '-' + ym.m));
      vals = rowsKpi
        .filter(r => ymSet.has(r.year + '-' + r.month))
        .map(r => Number(r.value))
        .filter(Number.isFinite);
    } else {
      const perAz = new Map();
      inRangeMonths.forEach(ym => {
        const bucket = by.get(ym.y + '-' + ym.m);
        if (!bucket) return;
        bucket.by.forEach((val, az) => {
          if (!Number.isFinite(val)) return;
          if (!perAz.has(az)) perAz.set(az, []);
          perAz.get(az).push(val);
        });
      });

      perAz.forEach(list => {
        const agg = useGeo ? aggGeometric(list) : arithmeticMean(list);
        if (agg != null) vals.push(agg);
      });
    }

    const caoMap = getCaoMonthMap(kpi, getSelectedProvinceName());
    const caoVals = [];
    inRangeMonths.forEach(ym => {
      const c = caoMap.get(ym.y + '-' + ym.m);
      if (c && Number.isFinite(c.value)) caoVals.push(c.value);
    });
    const caseificioAgg = caoVals.length
      ? (useGeo ? aggGeometric(caoVals) : arithmeticMean(caoVals))
      : null;

    if (!vals.length) {
      chart.data.datasets[0].data = [];
      chart.options.plugins.annotation.annotations = {};
      chart.update();
      if (posBadge) posBadge.textContent = '-- percentile';
      return;
    }

    /**
     * Stima il numero di bin con la regola Freedman-Diaconis (fallback minimo 6).
     * @param {number[]} values Valori numerici finiti.
     * @returns {number} Numero bin consigliato.
     */
    function freedmanBins(values) {
      const n = values.length;
      if (n < 2) return 6;
      const s = values.slice().sort((a, b) => a - b);
      const q1 = s[Math.floor(0.25 * (n - 1))];
      const q3 = s[Math.floor(0.75 * (n - 1))];
      let iqr = (q3 - q1);
      if (!Number.isFinite(iqr) || iqr === 0) {
        iqr = (s[n - 1] - s[0]) / 4;
        if (!Number.isFinite(iqr) || iqr === 0) iqr = 1;
      }
      const h = 2 * iqr * Math.pow(n, -1 / 3);
      let bins = Math.ceil((s[n - 1] - s[0]) / (h || 1)) || 6;
      if (bins < 6) bins = 6;
      if (bins > 15) bins = 15;
      return bins;
    }

    let bins = freedmanBins(vals);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    let centers;
    let counts;
    let step;

    let edges = [];
    if (mn === mx) {
      bins = 1;
      step = 1;
      edges = [mn - 0.5, mn + 0.5];
      centers = [mn];
      counts = [vals.length];
    } else {
      step = (mx - mn) / bins;
      if (!Number.isFinite(step) || step <= 0) step = 1;
      edges = [];
      for (let i = 0; i <= bins; i++) edges.push(mn + i * step);
      centers = [];
      for (let i = 0; i < bins; i++) {
        centers.push(mn + (i + 0.5) * step);
      }
      counts = new Array(bins).fill(0);
      for (const v of vals) {
        let idx = Math.floor((v - mn) / step);
        if (idx >= bins) idx = bins - 1;
        if (idx < 0) idx = 0;
        counts[idx]++;
      }
    }

    const total = counts.reduce((a, c) => a + c, 0) || 1;
    const data = centers.map((c, i) => ({
      x: c,
      y: Math.round((counts[i] / total) * 1000) / 10,
      count: counts[i],
      from: edges[i],
      to: edges[i + 1]
    }));

    const pr = percentileRank(vals, caseificioAgg);
    const unit = getKpiUnit(kpi) || '%';

    chart.data.datasets[0].data = data;
    chart.data.datasets[1].data = (caseificioAgg != null)
      ? [{
          x: caseificioAgg,
          y: 0,
          caseificioValue: caseificioAgg,
          unit
        }]
      : [];
    let axisMin = mn;
    let axisMax = mx;
    if (axisMin === axisMax) {
      axisMin = mn - 0.5;
      axisMax = mn + 0.5;
    }
    // includi la posizione del caseificio nell'asse X per renderla sempre visibile
    if (caseificioAgg != null && Number.isFinite(caseificioAgg)) {
      const pad = Number.isFinite(step) && step > 0 ? (step * 0.3) : 0.5;
      axisMin = Math.min(axisMin, caseificioAgg - pad);
      axisMax = Math.max(axisMax, caseificioAgg + pad);
    }

    chart.options.scales.x = {
      type: 'linear',
      min: axisMin,
      max: axisMax,
      bounds: 'ticks',
      offset: false,
      title: { display: !!unit, text: unit ? (unit + ' ' + (kpi || '')) : '' },
      ticks: {
        callback: (v) => Number.isFinite(v) ? v.toFixed(2) : v
      },
      afterBuildTicks: (scale) => {
        const tks = edges.map(v => ({ value: v }));
        scale.ticks = tks;
      }
    };

    chart.options.plugins.annotation.annotations = (caseificioAgg != null)
      ? {
          caseificio: {
            type: 'line',
            xMin: caseificioAgg,
            xMax: caseificioAgg,
            borderColor: '#ef4444',
            borderWidth: 2,
            label: {
              enabled: true,
              content: 'Caseificio: ' + caseificioAgg.toFixed(2) + (unit ? (' ' + unit) : ''),
              rotation: 90,
              backgroundColor: 'rgba(244,63,94,0.18)',
              color: '#f43f5e'
            }
          }
        }
      : {};

    chart.options.plugins.tooltip = {
      enabled: true,
      displayColors: false,
      filter(item) {
        if (item.dataset && item.dataset._tag === 'bars') {
          const c = item.raw?.count;
          return Number.isFinite(c) && c > 0;
        }
        return true;
      },
      callbacks: {
        label(ctx) {
          if (ctx.dataset && ctx.dataset._tag === 'caseificio') {
            const d = ctx.raw || {};
            const val = Number.isFinite(d.caseificioValue) ? d.caseificioValue.toFixed(2) : '';
            return val ? ['Caseificio: ' + val + (unit ? ' ' + unit : '')] : '';
          }
          const d = ctx.raw || {};
          const left = Number.isFinite(d.from) ? d.from.toFixed(2) : '?';
          const right = Number.isFinite(d.to) ? d.to.toFixed(2) : '?';
          const isLast = ctx.dataIndex === (ctx.chart.data.datasets[0].data.length - 1);
          const range = 'Range: [' + left + ' ; ' + right + (isLast ? ' ]' : ' [');
          const pct = Number.isFinite(d.y) ? 'Frequenza: ' + d.y.toFixed(1) + '%' : '';
          const noun = (getBenchmarkMode() === 'intraCaseificio') ? 'Campioni' : 'Aziende';
          const cnt = Number.isFinite(d.count) ? (noun + ': ' + d.count) : '';
          return [range, pct, cnt].filter(Boolean);
        }
      }
    };

    chart.update();

    if (posBadge) {
      posBadge.textContent = (pr != null) ? (pr + '° percentile') : '-- percentile';
    }
  }

  // ---------- binding UI ----------
  /**
   * Collega tutti i controlli UI (select KPI, provincia, range, toggle gruppo) agli handler.
   * Gestisce anche il datepicker min/max e i bottoni di condivisione/credits.
   */
  function bindUi() {
    // cambio KPI
    const kpiSel = document.getElementById('indicatore');
    if (kpiSel) {
      kpiSel.addEventListener('change', () => {
        renderKpiChart();
        renderHistogram();
        // opzionale: se definita globalmente, aggiorna legenda stile KPI
        ensureKpiStyleLegend();
      });
    }

    // cambio tipo di benchmark o provincia o caseificio
    ['benchmarkType', 'provinciaFilter', 'aziendaSelect'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => {
          ensureGroupToggle(); // aggiorna la label/legenda in base al mode
          renderKpiChart();
          renderHistogram();
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
        renderHistogram();
      }
    });

    // toggle media gruppo (checkbox "Mostra media gruppo")
    const medianToggle = ensureGroupToggle();
    if (medianToggle && !medianToggle._bound) {
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
      medianToggle._bound = true;
    }

    // cambio preset istogramma (lattazioni/custom)
    const presetSel = document.getElementById('distPreset');
    const customWrap = document.getElementById('customPeriod');
    if (presetSel && !presetSel._bound) {
      presetSel.addEventListener('change', () => {
        const v = presetSel.value;
        if (v && v.startsWith('lac:')) {
          const y = Number(v.split(':')[1]);
          histPeriod = { type: 'lactation', start: y, from: null, to: null };
          if (customWrap) customWrap.style.display = 'none';
          renderHistogram();
        } else if (v === 'custom') {
          if (customWrap) customWrap.style.display = 'flex';
        }
      });
      presetSel._bound = true;
    }

    const applyCustom = document.getElementById('applyCustom');
    if (applyCustom && !applyCustom._bound) {
      applyCustom.addEventListener('click', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        const fm = document.getElementById('fromMonth');
        const tm = document.getElementById('toMonth');
        if (!fm || !tm || !fm.value || !tm.value) return;

        const fParts = fm.value.split('-').map(Number);
        const tParts = tm.value.split('-').map(Number);
        let fromD = new Date(fParts[0], (fParts[1] || 1) - 1, 1);
        let toD   = new Date(tParts[0], (tParts[1] || 1) - 1, 1);
        if (fromD > toD) {
          const tmp = fromD;
          fromD = toD;
          toD = tmp;
        }

        histPeriod = { type: 'custom', from: fromD, to: toD };
        setCustomLabelText(presetSel, fromD, toD);
        if (presetSel) presetSel.value = 'custom';
        renderHistogram();
      });
      applyCustom._bound = true;
    }
  }

  /**
   * Entry point del modulo: controlla presenza dati raw e avvia bindUi + primo rendering.
   * Viene chiamato dopo il caricamento del dataset (dataLoader/loaderCaseificio).
   * Attiva listener sugli eventi "raw:loaded" (data.json) e "cao:loaded" (datiCAO/conferitori) per rerender.
   */
  function init() {
    bindUi();
    renderKpiChart();
    ensureHistPreset(false);
    renderHistogram();

    // ascolta il caricamento di RAW (data.json) per aggiornare la media del gruppo
    document.addEventListener('raw:loaded', () => {
      rawReady = true;
      renderKpiChart();
      ensureHistPreset(true);
      renderHistogram();
    });

    // rinfresca quando arriva il dataset CAO on-demand
    document.addEventListener('cao:loaded', () => {
      renderKpiChart();
      ensureHistPreset(false);
      renderHistogram();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// --- Credit popover (riuso stile hi-tech della UI allevatore) ---
  /**
   * Crea un overlay modale con i crediti del progetto e stile coerente alla UI.
   * Rimuove eventuali overlay preesistenti, costruisce DOM e attiva transizione fade-in.
   * Dipendenze: nessuna esterna; usa solo DOM API vanilla.
   */
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

// Binding del bottone "credit" per aprire la modale
(function bindCreditButton() {
  var btn = document.getElementById('credit');
  if (!btn) return;
  btn.style.cursor = 'pointer';
  btn.addEventListener('mouseenter', function() { btn.style.opacity = '0.85'; });
  btn.addEventListener('mouseleave', function() { btn.style.opacity = '1'; });
  btn.addEventListener('click', showCredit);
})();




