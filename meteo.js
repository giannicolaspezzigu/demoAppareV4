// meteo.js
// Gestisce i grafici della sezione Meteo in indexAllevatore.html (vista Performance).
(function () {
  const SRC = './meteo_monthly_by_farm.json?v=' + Date.now();
  const MONTHS_LACT = ['Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set'];
  const NETWORK_FARMS_SHOW_AT_ZOOM_LE = 14;
  const THI_BACKGROUND_BANDS = {
    annotations: {
      thiComfort: {
        type: 'box',
        xMin: 0,
        xMax: 12,
        yMin: 0,
        yMax: 65,
        backgroundColor: 'rgba(199, 237, 230, 0.45)',
        borderWidth: 0,
      },
      thiAlert: {
        type: 'box',
        xMin: 0,
        xMax: 12,
        yMin: 65,
        yMax: 70,
        backgroundColor: 'rgba(255, 243, 191, 0.45)',
        borderWidth: 0,
      },
      thiModerate: {
        type: 'box',
        xMin: 0,
        xMax: 12,
        yMin: 70,
        yMax: 75,
        backgroundColor: 'rgba(255, 214, 165, 0.45)',
        borderWidth: 0,
      },
      thiHigh: {
        type: 'box',
        xMin: 0,
        xMax: 12,
        yMin: 75,
        yMax: 80,
        backgroundColor: 'rgba(255, 173, 173, 0.45)',
        borderWidth: 0,
      },
      thiSevere: {
        type: 'box',
        xMin: 0,
        xMax: 12,
        yMin: 80,
        yMax: 100,
        backgroundColor: 'rgba(230, 57, 70, 0.35)',
        borderWidth: 0,
      },
    },
  };

  let bound = false;
  let lastSig = '';
  let lastRenderedKey = '';
  let lastRenderedWindKey = '';
  let lastRenderedTempHumKey = '';
  let lastRenderedMapKey = '';
  let meteoPromise = null;
  let farmIndex = null; // Map(normalizedName -> originalKey)
  let thiChart = null;
  let windChart = null;
  let tempHumChart = null;
  let leafletPromise = null;
  let farmMap = null;
  let farmMarker = null;
  let networkFarmsLayer = null;
  let farmMapMode = null; // 'leaflet' | 'iframe' | null
  let renderTimer = null;

  function normalizeKey(v) {
    return String(v || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function getAzienda() {
    if (window.state?.azienda) return String(window.state.azienda);
    return document.getElementById('aziendaHeader')?.textContent?.trim() || '';
  }

  function getActiveLactationStarts() {
    return Array.from(document.querySelectorAll('#md-year-boxes input[type="checkbox"]:checked'))
      .map((i) => Number(i.value))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }

  function lactationLabelSafe(yStart) {
    if (typeof window.lactationLabel === 'function') return window.lactationLabel(yStart);
    return `${yStart}-${String((yStart + 1) % 100).padStart(2, '0')}`;
  }

  function colorForLactationStart(yStart) {
    const input = document.querySelector(`#md-year-boxes input[type="checkbox"][value="${yStart}"]`);
    const dot = input?.parentElement?.querySelector('span');
    const c = dot?.style?.background || (dot ? getComputedStyle(dot).backgroundColor : '');
    return c || '#0ea5e9';
  }

  function withAlpha(color, alpha) {
    const c = String(color || '').trim();
    if (!c) return `rgba(14, 165, 233, ${alpha})`;

    if (c.startsWith('#')) {
      let hex = c.slice(1);
      if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if ([r, g, b].every((n) => Number.isFinite(n))) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }

    const m = c.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(',').map((p) => p.trim());
      if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }

    return c;
  }

  function monthKeyForLactation(yStart, lactMonthIndex) {
    // lactMonthIndex: 0..11 corrisponde a Ott..Set
    const month = ((lactMonthIndex + 9) % 12) + 1; // Ott(10)=0 ... Set(9)=11
    const year = lactMonthIndex <= 2 ? yStart : yStart + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  function getChart1Canvas() {
    return document.querySelector('#meteoChart1Host canvas');
  }

  function getChart2Canvas() {
    return document.querySelector('#meteoChart2Host canvas');
  }

  function getChart3Canvas() {
    return document.querySelector('#meteoChart3Host canvas');
  }

  function getChart4Host() {
    return document.getElementById('meteoChart4Host');
  }

  function setChart1Title(text) {
    const strong = document
      .getElementById('meteoChart1Host')
      ?.closest('.card')
      ?.querySelector('.head strong');
    if (strong) strong.textContent = text;
  }

  function setChart2Title(text) {
    const strong = document
      .getElementById('meteoChart2Host')
      ?.closest('.card')
      ?.querySelector('.head strong');
    if (strong) strong.textContent = text;
  }

  function setChart3Title(text) {
    const strong = document
      .getElementById('meteoChart3Host')
      ?.closest('.card')
      ?.querySelector('.head strong');
    if (strong) strong.textContent = text;
  }

  function setChart4Title(text) {
    const strong = document
      .getElementById('meteoChart4Host')
      ?.closest('.card')
      ?.querySelector('.head strong');
    if (strong) strong.textContent = text;
  }

  async function loadMeteoMonthlyByFarm() {
    if (meteoPromise) return meteoPromise;
    meteoPromise = (async () => {
      try {
        const resp = await fetch(SRC, { cache: 'no-store' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        farmIndex = new Map();
        if (json && typeof json === 'object') {
          for (const k of Object.keys(json)) farmIndex.set(normalizeKey(k), k);
        }
        return json;
      } catch (err) {
        console.warn('[meteo] fetch fallito:', err);
        meteoPromise = null; // consenti retry
        farmIndex = null;
        return null;
      }
    })();
    return meteoPromise;
  }

  function destroyChartIfAny(canvas) {
    if (typeof Chart === 'undefined') return;
    const existing = canvas ? Chart.getChart(canvas) : null;
    if (existing) existing.destroy();
    if (thiChart && thiChart !== existing) {
      thiChart.destroy();
    }
    thiChart = null;
    lastRenderedKey = '';
  }

  function destroyWindChartIfAny(canvas) {
    if (typeof Chart === 'undefined') return;
    const existing = canvas ? Chart.getChart(canvas) : null;
    if (existing) existing.destroy();
    if (windChart && windChart !== existing) {
      windChart.destroy();
    }
    windChart = null;
    lastRenderedWindKey = '';
  }

  function destroyTempHumChartIfAny(canvas) {
    if (typeof Chart === 'undefined') return;
    const existing = canvas ? Chart.getChart(canvas) : null;
    if (existing) existing.destroy();
    if (tempHumChart && tempHumChart !== existing) {
      tempHumChart.destroy();
    }
    tempHumChart = null;
    lastRenderedTempHumKey = '';
  }

  function destroyFarmMapIfAny() {
    const host = getChart4Host();
    if (farmMap) {
      farmMap.remove();
      farmMap = null;
    }
    farmMarker = null;
    networkFarmsLayer = null;
    farmMapMode = null;
    leafletPromise = null;
    lastRenderedMapKey = '';
    if (host && host.dataset?.meteoMap === '1') {
      host.innerHTML = '<canvas></canvas>';
      delete host.dataset.meteoMap;
    }
  }

  function updateNetworkFarmsVisibility() {
    if (!farmMap || !networkFarmsLayer) return;
    const z = typeof farmMap.getZoom === 'function' ? farmMap.getZoom() : null;
    const shouldShow = Number.isFinite(z) && z <= NETWORK_FARMS_SHOW_AT_ZOOM_LE;
    const hasLayer = typeof farmMap.hasLayer === 'function' && farmMap.hasLayer(networkFarmsLayer);
    if (shouldShow && !hasLayer) networkFarmsLayer.addTo(farmMap);
    if (!shouldShow && hasLayer) farmMap.removeLayer(networkFarmsLayer);
  }

  function loadLeaflet() {
    if (window.L && typeof window.L.map === 'function') return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;

    leafletPromise = new Promise((resolve, reject) => {
      const cssId = 'leaflet-css';
      const jsId = 'leaflet-js';

      if (!document.getElementById(cssId)) {
        const link = document.createElement('link');
        link.id = cssId;
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
        link.crossOrigin = '';
        document.head.appendChild(link);
      }

      if (window.L && typeof window.L.map === 'function') {
        resolve(window.L);
        return;
      }

      const existing = document.getElementById(jsId);
      if (existing) {
        existing.addEventListener('load', () => resolve(window.L));
        existing.addEventListener('error', () => reject(new Error('Leaflet load failed')));
        return;
      }

      const script = document.createElement('script');
      script.id = jsId;
      script.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
      script.defer = true;
      script.onload = () =>
        window.L && typeof window.L.map === 'function'
          ? resolve(window.L)
          : reject(new Error('Leaflet disponibile ma non inizializzato'));
      script.onerror = () => reject(new Error('Leaflet load failed'));
      document.head.appendChild(script);
    });

    return leafletPromise;
  }

  function scheduleRender(delayMs = 0) {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, delayMs);
  }

  function renderAll() {
    renderThiMean();
    renderTempHumMean();
    renderWindMean();
    renderFarmMap();
  }

  async function renderThiMean() {
    const viewMiei = document.getElementById('view-miei');
    if (!viewMiei?.classList.contains('active')) return;

    const details = document.getElementById('meteoDetails');
    if (!details?.open) return;

    if (typeof Chart === 'undefined') return;

    const canvas = getChart1Canvas();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setChart1Title('THI medio');

    const azienda = getAzienda();
    const years = getActiveLactationStarts();
    const renderKey = `${normalizeKey(azienda)}|${years.join(',')}`;
    if (renderKey && thiChart && renderKey === lastRenderedKey) return;

    if (!azienda || !years.length) {
      destroyChartIfAny(canvas);
      return;
    }

    const data = await loadMeteoMonthlyByFarm();
    if (!data || typeof data !== 'object' || !farmIndex) {
      destroyChartIfAny(canvas);
      return;
    }

    const farmKey = farmIndex.get(normalizeKey(azienda));
    const farm = farmKey ? data[farmKey] : null;
    const monthly = Array.isArray(farm?.monthly) ? farm.monthly : [];

    if (!monthly.length) {
      setChart1Title('THI medio (dati non disponibili)');
      destroyChartIfAny(canvas);
      return;
    }

    const thiByMonth = new Map();
    const daysByMonth = new Map();
    for (const row of monthly) {
      if (!row || !row.month) continue;
      const v = Number(row.thi_mean);
      thiByMonth.set(String(row.month), Number.isFinite(v) ? v : null);

      const days = Number(row.days_thi_gt_threshold);
      daysByMonth.set(String(row.month), Number.isFinite(days) ? days : null);
    }

    const thiThreshold = Number(farm?.thi_threshold);
    const thiThresholdLabel = Number.isFinite(thiThreshold) ? thiThreshold : 70;

    const datasets = [];
    for (const yStart of years) {
      const lineColor = colorForLactationStart(yStart);
      const thiPoints = [];
      const dayPoints = [];
      for (let i = 0; i < 12; i++) {
        const monthKey = monthKeyForLactation(yStart, i);
        thiPoints.push({ x: i, y: thiByMonth.get(monthKey) ?? null, month: monthKey });
        dayPoints.push({ x: i, y: daysByMonth.get(monthKey) ?? null, month: monthKey });
      }

      if (dayPoints.some((p) => p.y != null)) {
        datasets.push({
          type: 'bar',
          label: lactationLabelSafe(yStart),
          data: dayPoints,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          yAxisID: 'yDays',
          backgroundColor: withAlpha(lineColor, 0.22),
          borderColor: withAlpha(lineColor, 0.5),
          borderWidth: 1,
          order: 1,
        });
      }

      if (thiPoints.some((p) => p.y != null)) {
        datasets.push({
          type: 'line',
          label: lactationLabelSafe(yStart),
          data: thiPoints,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          yAxisID: 'y',
          borderColor: lineColor,
          backgroundColor: 'rgba(0,0,0,0)',
          tension: 0.25,
          pointRadius: 3,
          spanGaps: false,
          order: 2,
        });
      }
    }

    destroyChartIfAny(canvas);
    if (!datasets.length) {
      setChart1Title('THI medio (dati non disponibili)');
      return;
    }

    thiChart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: 12,
            ticks: { stepSize: 1, callback: (v) => (Number.isInteger(v) ? MONTHS_LACT[v] || '' : '') },
          },
          y: {
            min: 50,
            max: 90,
            title: { display: true, text: 'THI' },
          },
          yDays: {
            position: 'right',
            min: 0,
            max: 31,
            grid: { drawOnChartArea: false },
            title: { display: true, text: `Giorni THI > ${thiThresholdLabel}` },
            ticks: { precision: 0 },
          },
        },
        plugins: {
          legend: { display: true },
          annotation: THI_BACKGROUND_BANDS,
          tooltip: {
            callbacks: {
              title(items) {
                const raw = items?.[0]?.raw;
                if (raw?.month) return String(raw.month);
                const x = items?.[0]?.parsed?.x;
                return Number.isFinite(x) ? (MONTHS_LACT[Math.round(x)] || '') : '';
              },
              label(ctx) {
                const v = ctx.parsed?.y;
                const isDays = ctx.dataset?.yAxisID === 'yDays' || ctx.dataset?.type === 'bar';
                if (isDays) {
                  return Number.isFinite(v)
                    ? `Giorni THI > ${thiThresholdLabel} (${ctx.dataset?.label || ''}): ${Math.round(v)}`
                    : `Giorni THI > ${thiThresholdLabel} (${ctx.dataset?.label || ''}): n/d`;
                }
                return Number.isFinite(v)
                  ? `THI medio (${ctx.dataset?.label || ''}): ${v.toFixed(1)}`
                  : `THI medio (${ctx.dataset?.label || ''}): n/d`;
              },
            },
          },
        },
        elements: { line: { tension: 0.25 } },
      },
    });

    lastRenderedKey = renderKey;
  }

  async function renderTempHumMean() {
    const viewMiei = document.getElementById('view-miei');
    if (!viewMiei?.classList.contains('active')) return;

    const details = document.getElementById('meteoDetails');
    if (!details?.open) return;

    if (typeof Chart === 'undefined') return;

    const canvas = getChart2Canvas();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setChart2Title('Temperatura media e Umidità media');

    const azienda = getAzienda();
    const years = getActiveLactationStarts();
    const renderKey = `${normalizeKey(azienda)}|${years.join(',')}`;
    if (renderKey && tempHumChart && renderKey === lastRenderedTempHumKey) return;

    if (!azienda || !years.length) {
      destroyTempHumChartIfAny(canvas);
      return;
    }

    const data = await loadMeteoMonthlyByFarm();
    if (!data || typeof data !== 'object' || !farmIndex) {
      destroyTempHumChartIfAny(canvas);
      return;
    }

    const farmKey = farmIndex.get(normalizeKey(azienda));
    const farm = farmKey ? data[farmKey] : null;
    const monthly = Array.isArray(farm?.monthly) ? farm.monthly : [];

    if (!monthly.length) {
      setChart2Title('Temperatura/Umidità (dati non disponibili)');
      destroyTempHumChartIfAny(canvas);
      return;
    }

    const tempByMonth = new Map();
    const rhByMonth = new Map();
    for (const row of monthly) {
      if (!row || !row.month) continue;
      const monthKey = String(row.month);
      const t = Number(row.temp_mean_c);
      const rh = Number(row.rh_mean_pct);
      tempByMonth.set(monthKey, Number.isFinite(t) ? t : null);
      rhByMonth.set(monthKey, Number.isFinite(rh) ? rh : null);
    }

    const datasets = [];
    for (const yStart of years) {
      const baseColor = colorForLactationStart(yStart);
      const tempPoints = [];
      const rhPoints = [];

      for (let i = 0; i < 12; i++) {
        const monthKey = monthKeyForLactation(yStart, i);
        tempPoints.push({ x: i, y: tempByMonth.get(monthKey) ?? null, month: monthKey });
        rhPoints.push({ x: i, y: rhByMonth.get(monthKey) ?? null, month: monthKey });
      }

      const lab = lactationLabelSafe(yStart);

      if (tempPoints.some((p) => p.y != null)) {
        datasets.push({
          type: 'line',
          label: `${lab} · Temp`,
          meteoMetric: 'tempMean',
          data: tempPoints,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          yAxisID: 'yTemp',
          borderColor: baseColor,
          backgroundColor: 'rgba(0,0,0,0)',
          tension: 0.25,
          pointRadius: 3,
          spanGaps: false,
          order: 2,
        });
      }

      if (rhPoints.some((p) => p.y != null)) {
        datasets.push({
          type: 'line',
          label: `${lab} · Umidità`,
          meteoMetric: 'rhMean',
          data: rhPoints,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          yAxisID: 'yHum',
          borderColor: withAlpha(baseColor, 0.7),
          backgroundColor: 'rgba(0,0,0,0)',
          borderDash: [6, 4],
          tension: 0.25,
          pointRadius: 3,
          spanGaps: false,
          order: 3,
        });
      }
    }

    destroyTempHumChartIfAny(canvas);
    if (!datasets.length) {
      setChart2Title('Temperatura/Umidità (dati non disponibili)');
      return;
    }

    tempHumChart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: 12,
            ticks: { stepSize: 1, callback: (v) => (Number.isInteger(v) ? MONTHS_LACT[v] || '' : '') },
          },
          yTemp: {
            position: 'left',
            title: { display: true, text: 'Temperatura (°C)' },
            grace: '10%',
          },
          yHum: {
            position: 'right',
            min: 0,
            max: 100,
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Umidità (%)' },
          },
        },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              title(items) {
                const raw = items?.[0]?.raw;
                if (raw?.month) return String(raw.month);
                const x = items?.[0]?.parsed?.x;
                return Number.isFinite(x) ? (MONTHS_LACT[Math.round(x)] || '') : '';
              },
              label(ctx) {
                const v = ctx.parsed?.y;
                const metric = ctx.dataset?.meteoMetric;
                if (metric === 'tempMean') {
                  return Number.isFinite(v) ? `${ctx.dataset.label}: ${v.toFixed(1)} °C` : `${ctx.dataset.label}: n/d`;
                }
                if (metric === 'rhMean') {
                  return Number.isFinite(v) ? `${ctx.dataset.label}: ${v.toFixed(1)} %` : `${ctx.dataset.label}: n/d`;
                }
                return Number.isFinite(v) ? `${ctx.dataset.label}: ${v}` : `${ctx.dataset.label}: n/d`;
              },
            },
          },
        },
        elements: { line: { tension: 0.25 } },
      },
    });

    lastRenderedTempHumKey = renderKey;
  }

  function buildWindBackgroundBands(thr1Kmh, thr2Kmh) {
    const low = Number.isFinite(thr1Kmh) ? thr1Kmh : 20;
    const high = Number.isFinite(thr2Kmh) ? thr2Kmh : 30;
    const xMin = 0;
    const xMax = 12;

    return {
      annotations: {
        windNormal: {
          type: 'box',
          xMin,
          xMax,
          yMin: 0,
          yMax: low,
          backgroundColor: 'rgba(199, 237, 230, 0.35)',
          borderWidth: 0,
        },
        windAttention: {
          type: 'box',
          xMin,
          xMax,
          yMin: low,
          yMax: high,
          backgroundColor: 'rgba(255, 243, 191, 0.35)',
          borderWidth: 0,
        },
        windStrong: {
          type: 'box',
          xMin,
          xMax,
          yMin: high,
          yMax: 100,
          backgroundColor: 'rgba(255, 173, 173, 0.28)',
          borderWidth: 0,
        },
      },
    };
  }

  async function renderWindMean() {
    const viewMiei = document.getElementById('view-miei');
    if (!viewMiei?.classList.contains('active')) return;

    const details = document.getElementById('meteoDetails');
    if (!details?.open) return;

    if (typeof Chart === 'undefined') return;

    const canvas = getChart3Canvas();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setChart3Title('Vento medio (km/h)');

    const azienda = getAzienda();
    const years = getActiveLactationStarts();
    const renderKey = `${normalizeKey(azienda)}|${years.join(',')}`;
    if (renderKey && windChart && renderKey === lastRenderedWindKey) return;

    if (!azienda || !years.length) {
      destroyWindChartIfAny(canvas);
      return;
    }

    const data = await loadMeteoMonthlyByFarm();
    if (!data || typeof data !== 'object' || !farmIndex) {
      destroyWindChartIfAny(canvas);
      return;
    }

    const farmKey = farmIndex.get(normalizeKey(azienda));
    const farm = farmKey ? data[farmKey] : null;
    const monthly = Array.isArray(farm?.monthly) ? farm.monthly : [];

    if (!monthly.length) {
      setChart3Title('Vento medio (dati non disponibili)');
      destroyWindChartIfAny(canvas);
      return;
    }

    const thresholdsKmh = Array.isArray(farm?.wind_thresholds_kmh)
      ? farm.wind_thresholds_kmh.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    thresholdsKmh.sort((a, b) => a - b);
    const windThrKmh1 = thresholdsKmh.length >= 1 ? thresholdsKmh[0] : 20;
    const windThrKmh2 = thresholdsKmh.length >= 2 ? thresholdsKmh[1] : 30;

    const windKmhByMonth = new Map();
    const daysWindGt1ByMonth = new Map();
    const daysWindGt2ByMonth = new Map();
    for (const row of monthly) {
      if (!row || !row.month) continue;
      const monthKey = String(row.month);

      const meanKmh = Number(row.wind_mean_kmh);
      windKmhByMonth.set(monthKey, Number.isFinite(meanKmh) ? meanKmh : null);

      const daysObj = row.days_wind_gt_kmh && typeof row.days_wind_gt_kmh === 'object' ? row.days_wind_gt_kmh : null;
      const days1 = daysObj ? Number(daysObj[String(windThrKmh1)]) : null;
      const days2 = daysObj ? Number(daysObj[String(windThrKmh2)]) : null;
      daysWindGt1ByMonth.set(monthKey, Number.isFinite(days1) ? days1 : null);
      daysWindGt2ByMonth.set(monthKey, Number.isFinite(days2) ? days2 : null);
    }

    const yMaxWind = 60;
    const yMaxDays = 31;

    const datasets = [];
    for (const yStart of years) {
      const lineColor = colorForLactationStart(yStart);

      const meanPoints = [];
      const daysPointsThr1 = [];
      const daysPointsThr2 = [];
      for (let i = 0; i < 12; i++) {
        const monthKey = monthKeyForLactation(yStart, i);
        meanPoints.push({ x: i, y: windKmhByMonth.get(monthKey) ?? null, month: monthKey });
        daysPointsThr1.push({ x: i, y: daysWindGt1ByMonth.get(monthKey) ?? null, month: monthKey });
        daysPointsThr2.push({ x: i, y: daysWindGt2ByMonth.get(monthKey) ?? null, month: monthKey });
      }

      if (daysPointsThr1.some((p) => p.y != null)) {
        datasets.push({
          type: 'bar',
          label: `${lactationLabelSafe(yStart)} > ${windThrKmh1.toFixed(1)} km/h`,
          meteoMetric: 'daysWindGt',
          meteoThresholdKmh: windThrKmh1,
          data: daysPointsThr1,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          yAxisID: 'yDays',
          backgroundColor: withAlpha(lineColor, 0.18),
          borderColor: withAlpha(lineColor, 0.35),
          borderWidth: 1,
          order: 1,
        });
      }

      if (daysPointsThr2.some((p) => p.y != null)) {
        datasets.push({
          type: 'bar',
          label: `${lactationLabelSafe(yStart)} > ${windThrKmh2.toFixed(1)} km/h`,
          meteoMetric: 'daysWindGt',
          meteoThresholdKmh: windThrKmh2,
          data: daysPointsThr2,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          yAxisID: 'yDays',
          backgroundColor: withAlpha(lineColor, 0.32),
          borderColor: withAlpha(lineColor, 0.55),
          borderWidth: 1,
          order: 2,
        });
      }

      if (meanPoints.some((p) => p.y != null)) {
        datasets.push({
          type: 'line',
          label: lactationLabelSafe(yStart),
          meteoMetric: 'windMean',
          data: meanPoints,
          parsing: { xAxisKey: 'x', yAxisKey: 'y' },
          yAxisID: 'y',
          borderColor: lineColor,
          backgroundColor: 'rgba(0,0,0,0)',
          tension: 0.25,
          pointRadius: 3,
          spanGaps: false,
          order: 3,
        });
      }
    }

    destroyWindChartIfAny(canvas);
    if (!datasets.length) {
      setChart3Title('Vento medio (dati non disponibili)');
      return;
    }

    windChart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: 12,
            ticks: {
              stepSize: 1,
              callback: (v) => (Number.isInteger(v) ? MONTHS_LACT[v] || '' : ''),
            },
          },
          y: {
            min: 0,
            max: yMaxWind,
            title: { display: true, text: 'Vento medio (km/h)' },
          },
          yDays: {
            position: 'right',
            min: 0,
            max: yMaxDays,
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Giorni sopra soglia' },
            ticks: { precision: 0 },
          },
        },
        plugins: {
          legend: { display: true },
          annotation: buildWindBackgroundBands(windThrKmh1, windThrKmh2),
          tooltip: {
            callbacks: {
              title(items) {
                const raw = items?.[0]?.raw;
                if (raw?.month) return String(raw.month);
                const x = items?.[0]?.parsed?.x;
                return Number.isFinite(x) ? (MONTHS_LACT[Math.round(x)] || '') : '';
              },
              label(ctx) {
                const v = ctx.parsed?.y;
                const metric = ctx.dataset?.meteoMetric;
                if (metric === 'daysWindGt') {
                  const thr = Number(ctx.dataset?.meteoThresholdKmh);
                  const thrLbl = Number.isFinite(thr) ? thr.toFixed(1) : '?';
                  return Number.isFinite(v) ? `Giorni vento > ${thrLbl} km/h: ${Math.round(v)}` : `Giorni vento > ${thrLbl} km/h: n/d`;
                }
                if (metric === 'windMean') {
                  return Number.isFinite(v) ? `Vento medio: ${v.toFixed(1)} km/h` : 'Vento medio: n/d';
                }
                return Number.isFinite(v) ? `${v}` : 'n/d';
              },
            },
          },
        },
        elements: { line: { tension: 0.25 } },
      },
    });

    lastRenderedWindKey = renderKey;
  }

  async function renderFarmMap() {
    const viewMiei = document.getElementById('view-miei');
    if (!viewMiei?.classList.contains('active')) return;

    const details = document.getElementById('meteoDetails');
    if (!details?.open) return;

    const host = getChart4Host();
    if (!host) return;

    setChart4Title('Mappa azienda e rete Appàre');

    const azienda = getAzienda();
    const renderKey = normalizeKey(azienda);
    if (renderKey && farmMapMode && renderKey === lastRenderedMapKey) {
      if (farmMap && typeof farmMap.invalidateSize === 'function') setTimeout(() => farmMap.invalidateSize(), 0);
      return;
    }

    if (!azienda) {
      destroyFarmMapIfAny();
      host.dataset.meteoMap = '1';
      host.innerHTML = '<div class="placeholder">Seleziona un\'azienda</div>';
      return;
    }

    const data = await loadMeteoMonthlyByFarm();
    if (!data || typeof data !== 'object' || !farmIndex) {
      destroyFarmMapIfAny();
      host.dataset.meteoMap = '1';
      host.innerHTML = '<div class="placeholder">Dati meteo non disponibili</div>';
      return;
    }

    const farmKey = farmIndex.get(renderKey);
    const farm = farmKey ? data[farmKey] : null;
    const lat = Number(farm?.lat);
    const lon = Number(farm?.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      destroyFarmMapIfAny();
      host.dataset.meteoMap = '1';
      host.innerHTML = '<div class="placeholder">Coordinate azienda non disponibili</div>';
      return;
    }

    try {
      const L = await loadLeaflet();
      if (!L) throw new Error('Leaflet non disponibile');

      host.dataset.meteoMap = '1';
      host.style.overflow = 'hidden';
      host.style.borderRadius = '14px';

      if (!farmMap || farmMapMode !== 'leaflet') {
        if (farmMap) {
          farmMap.remove();
          farmMap = null;
          farmMarker = null;
          networkFarmsLayer = null;
        }

        host.innerHTML = '';
        farmMapMode = 'leaflet';
        farmMap = L.map(host, {
          zoomControl: false,
          attributionControl: true,
          scrollWheelZoom: false,
        });
        L.control.zoom({ position: 'bottomright' }).addTo(farmMap);
        L.control.scale({ imperial: false }).addTo(farmMap);

        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19,
          attribution: 'Tiles (c) Esri',
        }).addTo(farmMap);

        L.tileLayer(
          'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          {
            maxZoom: 19,
            opacity: 0.85,
            attribution: 'Labels (c) Esri',
          },
        ).addTo(farmMap);

        farmMarker = L.circleMarker([lat, lon], {
          radius: 7,
          color: '#16a34a',
          weight: 2,
          fillColor: '#22c55e',
          fillOpacity: 0.9,
        }).addTo(farmMap);

        networkFarmsLayer = L.layerGroup();
        farmMap.on('zoomend', updateNetworkFarmsVisibility);
      }

      const zoom = 16;
      farmMap.setView([lat, lon], zoom, { animate: false });
      if (farmMarker && typeof farmMarker.setLatLng === 'function') farmMarker.setLatLng([lat, lon]);

      const label = String(farm?.farm || azienda || '').trim();
      if (label && farmMarker && typeof farmMarker.bindTooltip === 'function') {
        if (typeof farmMarker.setTooltipContent === 'function') {
          farmMarker.setTooltipContent(label);
        } else {
          farmMarker.bindTooltip(label, { direction: 'top', offset: [0, -10] });
        }
      }

      if (!networkFarmsLayer) {
        networkFarmsLayer = L.layerGroup();
        farmMap.on('zoomend', updateNetworkFarmsVisibility);
      } else if (typeof networkFarmsLayer.clearLayers === 'function') {
        networkFarmsLayer.clearLayers();
      }

      for (const [otherKey, otherFarm] of Object.entries(data)) {
        if (normalizeKey(otherKey) === renderKey) continue;
        if (!otherFarm || typeof otherFarm !== 'object') continue;
        const lat2 = Number(otherFarm.lat);
        const lon2 = Number(otherFarm.lon);
        if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) continue;

        const m = L.circleMarker([lat2, lon2], {
          radius: 5,
          color: '#1d4ed8',
          weight: 2,
          fillColor: '#60a5fa',
          fillOpacity: 0.8,
        }).addTo(networkFarmsLayer);

        const otherLabel = String(otherFarm.farm || otherKey || '').trim();
        if (otherLabel && typeof m.bindTooltip === 'function') {
          m.bindTooltip(otherLabel, { direction: 'top', offset: [0, -8], opacity: 0.9 });
        }
      }

      updateNetworkFarmsVisibility();
      if (farmMarker && typeof farmMarker.bringToFront === 'function') farmMarker.bringToFront();

      setTimeout(() => farmMap && farmMap.invalidateSize && farmMap.invalidateSize(), 0);
      lastRenderedMapKey = renderKey;
      return;
    } catch (err) {
      console.warn('[meteo] Leaflet non disponibile, fallback iframe:', err);
    }

    if (farmMap) {
      farmMap.remove();
      farmMap = null;
    }
    farmMarker = null;
    networkFarmsLayer = null;
    farmMapMode = 'iframe';

    host.dataset.meteoMap = '1';
    host.style.overflow = 'hidden';
    host.style.borderRadius = '14px';

    const q = encodeURIComponent(`${lat},${lon}`);
    const src = `https://www.google.com/maps?q=${q}&z=16&t=k&output=embed`;
    host.innerHTML = `<iframe title="Mappa azienda" src="${src}" style="border:0;width:100%;height:100%;" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
    lastRenderedMapKey = renderKey;
  }

  function bind() {
    if (bound) return;
    bound = true;

    // Attivazione: disegna quando si apre la sezione Meteo.
    const details = document.getElementById('meteoDetails');
    if (details) {
      details.addEventListener('toggle', () => {
        if (details.open) scheduleRender(0);
        else {
          const canvas1 = getChart1Canvas();
          if (canvas1) destroyChartIfAny(canvas1);
          const canvas2 = getChart2Canvas();
          if (canvas2) destroyTempHumChartIfAny(canvas2);
          const canvas3 = getChart3Canvas();
          if (canvas3) destroyWindChartIfAny(canvas3);
          destroyFarmMapIfAny();
        }
      });
    }

    // Cambio lattazione (checkbox in md-year-boxes) -> aggiorna.
    const yearHost = document.getElementById('md-year-boxes');
    if (yearHost) {
      yearHost.addEventListener('change', (e) => {
        const t = e.target;
        if (t && t.matches && t.matches('input[type="checkbox"]')) scheduleRender(0);
      });
    }

    // Cambio azienda: tipicamente cambia l'header e/o state.azienda.
    const hdr = document.getElementById('aziendaHeader');
    if (hdr && 'MutationObserver' in window) {
      const mo = new MutationObserver(() => scheduleRender(80));
      mo.observe(hdr, { childList: true, characterData: true, subtree: true });
    }

    const miei = document.getElementById('miei-dati');
    if (miei) miei.addEventListener('change', () => miei.checked && scheduleRender(120));

    // Fallback: cattura cambi di state.azienda non riflessi subito nel DOM.
    setInterval(() => {
      const detailsOpen = !!document.getElementById('meteoDetails')?.open;
      const viewActive = !!document.getElementById('view-miei')?.classList.contains('active');
      const sig = `${normalizeKey(getAzienda())}|${getActiveLactationStarts().join(',')}|${detailsOpen}|${viewActive}`;
      if (sig !== lastSig) {
        lastSig = sig;
        if (detailsOpen && viewActive) scheduleRender(0);
      }
    }, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
