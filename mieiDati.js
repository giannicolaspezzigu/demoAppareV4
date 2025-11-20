// mieiDati.js — Vista "I miei dati": solo azienda, punti giornalieri, nessuna mediana
(function () {
  //const MONTHS_LACT = ['Set','Ott','Nov','Dic','Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago'];
  const MONTHS_LACT = ['Ott','Nov','Dic','Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set'];

  const YEAR_COLORS = { 2023:'#3b82f6', 2024:'#f59e0b', 2025:'#22c55e', 2026:'#10b981' };

  let chart = null;                 // istanza Chart.js unica
  let bound = false;                // per evitare doppi listener
  let lastSig = '';                 // firma per il polling (azienda|kpi|visibilità|nRows)

  // ---------- utils ----------
  const daysInMonth = (y,m) => new Date(y, m+1, 0).getDate();

  function lactationFromDate(d) {
    const y = d.getFullYear(), m = d.getMonth();
    const start = (m >= 9) ? y : (y - 1);
    const label = `${start}-${String((start + 1) % 100).padStart(2,'0')}`;
    const xMonth = (m + 3) % 12; // Ott(9)->0 ... Set(8)->11
    const frac = (d.getDate() - 1) / daysInMonth(y, m);
    return { startYear: start, label, x: xMonth + frac };
  }

  function getAzienda() {
    if (window.state?.azienda) return String(window.state.azienda);
    return document.getElementById('aziendaHeader')?.textContent?.trim() || '';
  }

  function getKpi() {
    if (window.state?.currentKpi) return String(window.state.currentKpi).toLowerCase();
    const sel = document.getElementById('indicatore');
    return sel?.value ? String(sel.value).toLowerCase() : 'cellule';
  }

  function getAliases(k) {
    const key = String(k).toLowerCase();
    if (window.KPI_ALIASES && KPI_ALIASES[key]) return KPI_ALIASES[key].map(s => String(s).toLowerCase());
    return [key];
  }

  function rowsForCurrent() {
    const az = getAzienda();
    const aliases = getAliases(getKpi());
    const src = Array.isArray(window.RAW) ? window.RAW : [];
    const out = [];
    for (const r of src) {
      if (!r || !r.Data) continue;
      if (String(r.Azienda || '') !== az) continue;
      const kpi = String(r.KPI || '').toLowerCase();
      if (!aliases.includes(kpi)) continue;
      const d = new Date(r.Data);
      const v = Number(r.Valore);
      if (!isFinite(v) || isNaN(+d)) continue;
      out.push({ date: d, value: v });
    }
    return out;
  }

  function groupByLactation(rows) {
    const map = new Map(); // label -> {startYear, points}
    for (const r of rows) {
      const lx = lactationFromDate(r.date);
      if (!map.has(lx.label)) map.set(lx.label, { startYear: lx.startYear, points: [] });
      //map.get(lx.label).points.push({ x: lx.x, y: r.value });
      map.get(lx.label).points.push({ x: lx.x, y: r.value, date: r.date });
    }
    for (const v of map.values()) v.points.sort((a,b)=>a.x-b.x);
    return map;
  }

  //--------

  // Ultime 3 lattazioni presenti nei DATI (ordinate asc: es. [2022, 2023, 2024])
function yearsFromData(byMap) {
  const ys = Array.from(byMap.values())
    .map(o => o.startYear)
    .filter((v,i,a) => a.indexOf(v) === i)
    .sort((a,b) => a - b);
  return ys.slice(-3);
}

// Crea 3 checkbox locali per gli anni passati (sempre visibili)
function buildYearBoxesForYears(years) {
  const host = document.getElementById('md-year-boxes');
  if (!host) return [];
  // salva stato precedente (se c’è)
  const prev = new Set(
    Array.from(host.querySelectorAll('input[type="checkbox"]'))
      .filter(i => i.checked)
      .map(i => Number(i.value))
  );

  const palette = ['#3b82f6', '#f59e0b', '#22c55e']; // blu, arancio, verde
  host.innerHTML = '';

  return years.map((yStart, idx) => {
    const id  = `md-yr${yStart}`;
    const lab = (typeof lactationLabel === 'function')
      ? lactationLabel(yStart)
      : `${yStart}-${String((yStart+1)%100).padStart(2,'0')}`;

    const wrap = document.createElement('label');
    wrap.className = 'select compact';
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id = id;
    chk.value = String(yStart);
    // ripristina spunte; se è il primo render → seleziona solo l’ultima
    chk.checked = prev.size ? prev.has(yStart) : (yStart === Math.max(...years));

    const dot = document.createElement('span');
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '999px';
    dot.style.background = palette[idx] || '#64748b';
    dot.style.display = 'inline-block';
    dot.style.boxShadow = '0 0 0 1px rgba(0,0,0,.12) inset';

    const txt = document.createElement('span');
    txt.textContent = lab;

    wrap.appendChild(chk);
    wrap.appendChild(dot);
    wrap.appendChild(txt);
    host.appendChild(wrap);

    return { id, yStart };
  });
}



  //-------

  function lastThreeLabels(map) {
    return Array.from(map.entries())
      .map(([label,obj]) => ({label, startYear: obj.startYear}))
      .sort((a,b)=>b.startYear - a.startYear)
      .slice(0,3)
      .map(o => o.label);
  }


  /* 
  function buildYearBoxes(labels) {
    const host = document.getElementById('md-year-boxes');
    if (!host) return [];
    host.innerHTML = '';
    return labels.map(lab => {
      const y0 = parseInt(lab.split('-')[0], 10);
      const id = `md-${y0}`;
      const el = document.createElement('label');
      el.className = `select compact key-${y0}`;
      el.innerHTML = `<span class="swatch" style="background:${YEAR_COLORS[y0] || '#6366f1'}"></span>${lab}<input type="checkbox" id="${id}" checked style="display:none">`;
      host.appendChild(el);
      return { id, year: y0 };
    });
  }  */

    // === NUOVA buildYearBoxesFromApp ===
// Copiata dal KPI/Mediana: genera le 3 lattazioni [blu, arancio, verde]
function buildYearBoxesFromApp() {
  const host = document.getElementById('md-year-boxes');
  if (!host || !window.lastThreeLactations || !window.lactationLabel) return [];

 // 🔹 salva stato precedente (se esiste)
const prev = new Set(
   Array.from(host.querySelectorAll('input[type="checkbox"]'))
   .filter(i => i.checked)
     .map(i => Number(i.value))
  );


  const lacStarts = lastThreeLactations(); // es. [2023, 2024, 2025]
  const colors = {};
  colors[lacStarts[0]] = '#3b82f6'; // blu
  colors[lacStarts[1]] = '#f59e0b'; // arancio
  colors[lacStarts[2]] = '#22c55e'; // verde

  host.innerHTML = '';
  return lacStarts.map(yStart => {
    const id = `md-yr${yStart}`;
    const lab = lactationLabel(yStart);

    const wrap = document.createElement('label');
    wrap.className = 'select compact';
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id = id;
    chk.value = String(yStart);

    // seleziona di default solo l'ultima lattazione (la più recente)
    chk.checked = prev.size ? prev.has(yStart) : (yStart === Math.max(...lacStarts));

   
    //chk.checked = true;

    const dot = document.createElement('span');
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '999px';
    dot.style.background = colors[yStart] || '#64748b';
    dot.style.display = 'inline-block';
    dot.style.boxShadow = '0 0 0 1px rgba(0,0,0,.12) inset';

    const txt = document.createElement('span');
    txt.textContent = lab;

    wrap.appendChild(chk);
    wrap.appendChild(dot);
    wrap.appendChild(txt);
    host.appendChild(wrap);

    return { id, yStart };
  });
}

// restituisce Set degli anni selezionati
function activeYearsMD() {
  return new Set(
    Array.from(document.querySelectorAll('#md-year-boxes input[type="checkbox"]:checked'))
      .filter(i => i.checked)
      .map(i => Number(i.value))
  );
}




  function getActiveYears() {
    return new Set(
      Array.from(document.querySelectorAll('#md-year-boxes input[type="checkbox"]'))
        .filter(i => i.checked)
        .map(i => Number(i.id.replace('md-','')))
    );
  }

  // ---------- chart render ----------
  function render() {
    const canvas = document.getElementById('md-chart');
    if (!canvas) return;

    const rows = rowsForCurrent();
    const by = groupByLactation(rows);
    //const labs = lastThreeLabels(by);
    //const boxes = buildYearBoxes(labs);
    //const boxes = buildYearBoxesFromApp();
    const years = yearsFromData(by);
    const boxes = buildYearBoxesForYears(years);

    // collego i checkbox dopo che li ho creati
    setTimeout(() => {
      boxes.forEach(b => {
        const el = document.getElementById(b.id);
        if (el) el.addEventListener('change', () => draw(by));
      });
      draw(by);
    }, 0);
  }

  function draw(byMap) {
    const canvas = document.getElementById('md-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // distruggi eventuale chart associato a questo canvas (fix “Canvas is already in use”)
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (chart) { chart.destroy(); chart = null; }

    //const active = getActiveYears();
    const active = activeYearsMD();
    // Nessuna lattazione selezionata → svuota il grafico e termina
    if (!active.size) {
      const canvas = document.getElementById('md-chart');
      if (canvas) {
       const existing = Chart.getChart(canvas);
        if (existing) {
          existing.data.datasets = [];
          existing.update();
        } else if (chart) {
         chart.data.datasets = [];
          chart.update();
        }
     }
     return;
    }


    

    const datasets = [];
   

    const entries = Array.from(byMap.entries()).sort((a,b)=>a[1].startYear - b[1].startYear);

    // Costruisco i colori a partire dalle lattazioni REALI presenti nei dati
    const ordered = Array.from(byMap.values())
    .map(o => o.startYear)
    .filter((v, i, a) => a.indexOf(v) === i)   // unici
    .sort((a, b) => a - b)                     // ascendente
    .slice(-3);                                // ultime 3

    const palette = ['#3b82f6', '#f59e0b', '#22c55e']; // blu, arancio, verde
    const colorFor = {};
    ordered.forEach((y, idx) => {
    colorFor[y] = palette[idx] || '#64748b';
    });


////

    for (const [label, obj] of entries) {
      if (active.size && !active.has(obj.startYear)) continue;
      datasets.push({
        label,
        data: obj.points,
        parsing: { xAxisKey: 'x', yAxisKey: 'y' },
       // borderColor: YEAR_COLORS[obj.startYear] || '#6366f1',
        borderColor: colorFor[obj.startYear] || '#64748b',

        backgroundColor: 'rgba(0,0,0,0)',
        tension: .25,
        pointRadius: 3,
        spanGaps: true,
      });
    }


    // usa le stesse unità di app.js
    const unit = (window.KPI_UNITS && KPI_UNITS[getKpi()]) || '';

    const options = {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'linear', min: 0, max: 12,
          ticks: { stepSize: 1, callback: v => Number.isInteger(v) ? MONTHS_LACT[v] : '' }
        },
        //y: { beginAtZero: false, grace: '5%' }

        y: {
            beginAtZero: false,
            grace: '5%',
            title: { display: !!unit, text: unit }   // ← titolo asse Y con l’unità giusta
         }

      },
      
      
  plugins: {
  legend: { display: false },
  tooltip: {
    callbacks: {
      title(items) {
        const d = new Date(items[0].raw.date);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}`;
      },
      label(ctx) {
        const v = ctx.parsed.y;
        return `${v}`;
      }
    }
  }
},

      
      
         


      elements: { line: { tension: .25 } }
    };

    chart = new Chart(ctx, { type: 'line', data: { datasets }, options });
  }

  // ---------- wiring ----------
  function bind() {
    if (bound) return; // evita doppi binding
    bound = true;

    const miei = document.getElementById('miei-dati');
    const conf = document.getElementById('confronto');
    const toggle = document.getElementById('viewToggle');

    // quando entri in "Miei dati" disegna
    if (miei) miei.addEventListener('change', () => {
      if (miei.checked)  {
        if (toggle) toggle.dataset.active = 'miei'; 
        setTimeout(render, 0);
      }
    });

    // cambio KPI esterno
    const sel = document.getElementById('indicatore');
    if (sel) sel.addEventListener('change', () => {
      if (document.getElementById('view-miei')?.classList.contains('active')) render();
    });

    // osserva cambio azienda (se l’header cambia testo)
    const hdr = document.getElementById('aziendaHeader');
    if (hdr && 'MutationObserver' in window) {
      const mo = new MutationObserver(() => {
        if (document.getElementById('view-miei')?.classList.contains('active')) render();
      });
      mo.observe(hdr, { childList:true, characterData:true, subtree:true });
    }

    // piccolo polling per catturare cambi di state.azienda / currentKpi fuori dal DOM
    setInterval(() => {
      const sig = `${getAzienda()}|${getKpi()}|${document.getElementById('view-miei')?.classList.contains('active')}|${(window.RAW||[]).length}`;
      if (sig !== lastSig) {
        lastSig = sig;
        if (document.getElementById('view-miei')?.classList.contains('active')) render();
      }
    }, 600);

    // se all’avvio la vista è già attiva, disegna
    const active = document.getElementById('viewToggle')?.dataset?.active === 'miei';
    if (active) render();

    if (conf) conf.addEventListener('change', () => {
    if (conf.checked && toggle) toggle.dataset.active = 'conf';
    });


  }

  function waitRaw(tries=200) {
    if (Array.isArray(window.RAW) && window.RAW.length) { bind(); return; }
    if (tries <= 0) { bind(); return; }
    setTimeout(() => waitRaw(tries - 1), 80);
  }

  window.addEventListener('DOMContentLoaded', waitRaw);
})();
