import { INTERVAL_MS, fetchKlines, fetchSymbolsInfo, fetchAllSymbols, fetchTradingDay, openStream } from './api.js';
import { calc, NAMES, periodStart } from './indicators.js';
import { Ruler } from './ruler.js';
import { me, getPrefs, logout, loginUrl } from '/js/conta.js';
import { t, lang, locale, applyI18n, langSwitch } from '/js/i18n.js';

applyI18n();
document.title = t('meta.chartTitle');
document.getElementById('lang').replaceWith(langSwitch('tb-lang'));

const LW = window.LightweightCharts;

const C = {
  bg: '#131722', text: '#d1d4dc', grid: 'rgba(42, 46, 57, 0.5)', border: '#2a2e39',
  up: '#089981', down: '#f23645', upVol: 'rgba(8, 153, 129, 0.45)', downVol: 'rgba(242, 54, 69, 0.45)',
  accent: '#2962ff', cross: '#9598a1', crossLabel: '#363a45',
};
// Fuso de quem abre o gráfico, em segundos (com o horário de verão de cada data).
const tzOffset = ms => -new Date(ms).getTimezoneOffset() * 60;
const INTRADAY = new Set(['1m', '5m', '15m', '1h', '4h']);
const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['1d', 'D'], ['1w', 'W'], ['1M', 'M']];
const TF_LABEL = Object.fromEntries(TIMEFRAMES);
const TF_LEGEND = { ...TF_LABEL, '1d': '1D', '1w': '1W', '1M': '1M' };
const SLOPE = { up: '#4caf50', down: '#f23645' };
const DEFAULT_INDICATORS = [
  { id: 'ma50', type: 'SMA', period: 50, tf: null, color: '#4caf50', slope: true, visible: true },
  { id: 'ma200w', type: 'SMA', period: 200, tf: '1w', color: '#2962ff', slope: false, visible: true },
  { id: 'ma50w', type: 'SMA', period: 50, tf: '1w', color: '#ff9800', slope: false, visible: false },
];
// Pares da Binance da lista do TradingView do usuário + BRL.
const DEFAULT_WATCHLIST = [
  'BTCBRL', 'USDTBRL', 'SOLBRL', 'BNBBRL', 'ETHBRL',
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'BNBUSDT', 'LINKUSDT', 'XRPUSDT', 'ICPUSDT', 'RENDERUSDT',
  'INJUSDT', 'ENAUSDT', 'NEARUSDT', 'SUIUSDT', 'PENDLEUSDT', 'FILUSDT', 'AUDIOUSDT', 'TRXUSDT', 'MANTAUSDT', 'TRUMPUSDT',
];
// Botões de período da barra inferior: [rótulo, tempo gráfico, dias visíveis (null = tudo)]
const RANGES = [
  ['1D', '5m', 1], ['5D', '15m', 5], ['1M', '1h', 30], ['3M', '4h', 90], ['6M', '1d', 180],
  ['YTD', '1d', 'ytd'], [t('range.1Y'), '1d', 365], [t('range.5Y'), '1w', 1826], [t('range.all'), '1w', null],
];

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('grafico.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('grafico.' + k, JSON.stringify(v)); } catch {}
    if (user) uploadPrefsSoon();
  },
};

// ---------- conta: preferências salvas no servidor ----------
// Logado, tudo o que o gráfico guarda (watchlist, médias, linhas, layout...) vai para a
// conta; ao abrir em outro computador, as preferências da conta substituem as locais.
function localPrefs() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('grafico.')) out[k.slice(8)] = JSON.parse(localStorage.getItem(k));
    }
  } catch {}
  return out;
}
function applyPrefs(prefs) {
  try {
    for (const k of Object.keys(localPrefs())) localStorage.removeItem('grafico.' + k);
    for (const [k, v] of Object.entries(prefs)) localStorage.setItem('grafico.' + k, JSON.stringify(v));
  } catch {}
}
let uploadTimer = null;
function uploadPrefsSoon(delay = 1200) {
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(flushPrefs, delay);
}
function flushPrefs() {
  if (!user || uploadTimer == null) return;
  clearTimeout(uploadTimer);
  uploadTimer = null;
  // keepalive: o envio termina mesmo se a página estiver fechando
  fetch('/api/prefs', { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: localPrefs() }) })
    .catch(console.error);
}
addEventListener('pagehide', flushPrefs);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushPrefs(); });

let user = null;
try {
  user = await Promise.race([me(), new Promise(r => setTimeout(() => r(null), 2500))]);
  if (user) {
    const { prefs } = await getPrefs();
    if (prefs) applyPrefs(prefs);
    else uploadPrefsSoon(0); // primeira vez: a conta começa com o que já estava neste navegador
  }
} catch (e) {
  console.error(e);
}

const state = {
  symbol: store.get('symbol', lang === 'pt' ? 'BTCBRL' : 'BTCUSDT'), // quem é de fora começa em dólar
  interval: '1d', // sempre abre no diário; a troca de tempo gráfico vale só até recarregar
  watchlist: store.get('watchlist.v2', DEFAULT_WATCHLIST),
  indicators: store.get('indicators.v2', DEFAULT_INDICATORS),
  hlines: store.get('hlines', {}),
  log: store.get('log', false),
  info: null,
  bars: [],
  noMoreHistory: false,
  loadingOlder: false,
  tool: 'cursor',
  hoverIndex: null,
};

const $ = s => document.querySelector(s);
function h(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter(c => c != null));
  return n;
}

// ---------- formatação ----------
let priceFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPrice = p => priceFmt.format(p);
const pctFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const fmtPct = x => pctFmt.format(x).replace('-', '−') + '%';
// Volume no estilo do TradingView: 409,97K / 1,2M / 3,4B
const volFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
const fmtVol = v => {
  for (const [n, suf] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (Math.abs(v) >= n) return volFmt.format(v / n) + suf;
  return volFmt.format(v);
};
const tickFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
const fmtDelta = (x, f = fmtPrice) => (x > 0 ? '+' : x < 0 ? '−' : '') + f(Math.abs(x));
const numFmts = new Map();
const fmtWith = prec => {
  if (!numFmts.has(prec)) numFmts.set(prec, new Intl.NumberFormat(locale, { minimumFractionDigits: prec, maximumFractionDigits: prec }));
  return numFmts.get(prec);
};

const WD = lang === 'pt' ? ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = lang === 'pt'
  ? ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
function formatTime(t) {
  const d = new Date(t * 1000); // já deslocado para o fuso local, por isso lemos em UTC
  const yy = `'${String(d.getUTCFullYear()).slice(2)}`;
  if (state.interval === '1M') return `${MONTHS[d.getUTCMonth()]} ${yy}`;
  const day = `${WD[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${yy}`;
  return INTRADAY.has(state.interval) ? `${day}   ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}

const toTime = ms => ms / 1000 + (INTRADAY.has(state.interval) ? tzOffset(ms) : 0);
const candlePoint = b => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c });
const volumePoint = b => ({ time: toTime(b.t), value: b.v, color: b.c >= b.o ? C.upVol : C.downVol });

// ---------- gráfico ----------
const chartEl = $('#chart');
const chart = LW.createChart(chartEl, {
  autoSize: true,
  layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontSize: 12, fontFamily: getComputedStyle(document.body).fontFamily },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  crosshair: {
    mode: LW.CrosshairMode.Normal,
    vertLine: { color: C.cross, style: LW.LineStyle.Dashed, labelBackgroundColor: C.crossLabel },
    horzLine: { color: C.cross, style: LW.LineStyle.Dashed, labelBackgroundColor: C.crossLabel },
  },
  rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.1, bottom: 0.18 } },
  timeScale: { borderColor: C.border, rightOffset: 10, barSpacing: 8, timeVisible: true, secondsVisible: false },
  localization: { locale, timeFormatter: formatTime },
});

const priceFormat = () => ({ type: 'custom', formatter: fmtPrice, minMove: state.info?.tickSize ?? 0.01 });

const candles = chart.addSeries(LW.CandlestickSeries, {
  upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down,
  priceFormat: priceFormat(),
});
const volume = chart.addSeries(LW.HistogramSeries, {
  priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
});
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });

const ruler = new Ruler({
  chart, series: candles,
  svgEl: $('#overlay'), labelEl: $('#ruler-label'),
  getBars: () => state.bars,
  getIntervalMs: () => INTERVAL_MS[state.interval],
  fmt: { delta: x => fmtDelta(x), pct: fmtPct, vol: fmtVol, ticks: x => fmtDelta(x / (state.info?.tickSize ?? 0.01), v => tickFmt.format(v)) },
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}

// ---------- carregamento ----------
let loadToken = 0;
let klineStream = null;
const htfCache = new Map(); // tf -> barras do tempo gráfico maior (médias multi-tempo)

async function load(range) {
  const token = ++loadToken;
  const { symbol, interval } = state;
  ruler.clear();
  htfCache.clear();
  renderTopbar();
  state.loading = true;
  try {
    const [infos, bars] = await Promise.all([fetchSymbolsInfo([symbol]), fetchKlines(symbol, interval)]);
    if (token !== loadToken) return;
    state.info = infos.get(symbol);
    state.bars = bars;
    state.noMoreHistory = bars.length < 1000;
    priceFmt = fmtWith(state.info.precision);
    candles.applyOptions({ priceFormat: priceFormat() });

    chart.timeScale().applyOptions({ timeVisible: INTRADAY.has(interval) });
    candles.setData(bars.map(candlePoint));
    volume.setData(bars.map(volumePoint));
    const n = bars.length;
    if (range !== undefined) showRange(range);
    else if (n > 150) chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 10 });
    else chart.timeScale().fitContent();
    state.loading = false;

    restoreHLines();
    subscribeKlines();
    await loadIndicatorData();
    if (token !== loadToken) return;
    renderIndicators();
    renderLegend();
  } catch (e) {
    console.error(e);
    toast(t('chart.loadFail', { symbol, msg: e.message }));
  } finally {
    if (token === loadToken) state.loading = false;
  }
}

async function loadOlder() {
  if (state.loading || state.loadingOlder || state.noMoreHistory || !state.bars.length) return;
  state.loadingOlder = true;
  const token = loadToken;
  try {
    const older = await fetchKlines(state.symbol, state.interval, { endTime: state.bars[0].t - 1 });
    if (token !== loadToken) return;
    if (older.length < 1000) state.noMoreHistory = true;
    if (!older.length) return;
    // mantém a mesma janela na tela: os índices andam older.length para a direita
    const range = chart.timeScale().getVisibleLogicalRange();
    state.bars = older.concat(state.bars);
    candles.setData(state.bars.map(candlePoint));
    volume.setData(state.bars.map(volumePoint));
    renderIndicators();
    if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
  } catch (e) {
    console.error(e);
  } finally {
    state.loadingOlder = false;
  }
}

chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
  if (r && r.from < 50) loadOlder();
  updateRealtimeBtn(r);
});

// Botão de resetar a visão (como o do TradingView): aparece quando o candle atual sai da tela
// ou quando o eixo de preço foi arrastado/esticado; volta para hoje com a escala automática.
const realtimeBtn = $('#realtime-btn');
function resetView() {
  chart.priceScale('right').applyOptions({ autoScale: true });
  const n = state.bars.length;
  if (n > 150) chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 10 });
  else chart.timeScale().fitContent();
  updateRealtimeBtn();
}
realtimeBtn.addEventListener('click', resetView);
function updateRealtimeBtn(r = chart.timeScale().getVisibleLogicalRange()) {
  const auto = chart.priceScale('right').options().autoScale;
  $('#auto-btn').classList.toggle('active', auto);
  const away = state.bars.length > 0 && ((!!r && r.to < state.bars.length - 1) || !auto);
  realtimeBtn.hidden = !away;
  if (away) {
    realtimeBtn.style.left = `${chart.timeScale().width() - realtimeBtn.offsetWidth - 10}px`;
    realtimeBtn.style.top = `${chartEl.clientHeight - chart.timeScale().height() - realtimeBtn.offsetHeight - 10}px`;
  }
}
// a biblioteca não avisa quando a autoescala é desligada; confere depois de cada arrasto/rolagem
for (const ev of ['pointerup', 'mouseup', 'touchend', 'wheel', 'dblclick']) window.addEventListener(ev, () => requestAnimationFrame(() => updateRealtimeBtn()), { capture: true, passive: true });

function setStatus(on) {
  $('#status').className = on ? 'on' : 'off';
}

function subscribeKlines() {
  klineStream?.close();
  const token = loadToken;
  klineStream = openStream([`${state.symbol.toLowerCase()}@kline_${state.interval}`], d => {
    if (token !== loadToken) return;
    const k = d.k;
    onLiveBar({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
  }, setStatus);
}

function onLiveBar(bar) {
  const bars = state.bars;
  const last = bars[bars.length - 1];
  if (!last || bar.t < last.t) return;
  if (bar.t === last.t) {
    bars[bars.length - 1] = bar;
  } else {
    // buraco nos dados (ex.: computador dormiu): recarrega tudo
    if (bar.t > last.t + INTERVAL_MS[state.interval] * 1.5) { load(); return; }
    bars.push(bar);
  }
  candles.update(candlePoint(bar));
  volume.update(volumePoint(bar));
  updateIndicatorsLive(bar);
  if (state.hoverIndex == null) updateLegend();
}


// ---------- indicadores ----------
const indSeries = new Map(); // id -> { series, values }

const usesHtf = ind => ind.tf && ind.tf !== state.interval && INTERVAL_MS[ind.tf] > INTERVAL_MS[state.interval];
const htfInvalid = ind => ind.tf && INTERVAL_MS[ind.tf] < INTERVAL_MS[state.interval];

async function loadIndicatorData() {
  const tfs = new Set(state.indicators.filter(usesHtf).map(i => i.tf));
  const missing = [...tfs].filter(tf => !htfCache.has(tf));
  const symbol = state.symbol;
  const results = await Promise.all(missing.map(tf => fetchKlines(symbol, tf).catch(() => [])));
  if (symbol !== state.symbol) return;
  missing.forEach((tf, i) => htfCache.set(tf, results[i]));
}

function indicatorValues(ind) {
  const bars = state.bars;
  if (htfInvalid(ind)) return bars.map(() => null);
  if (!usesHtf(ind)) return calc[ind.type](bars.map(b => b.c), ind.period);
  const htf = htfCache.get(ind.tf);
  if (!htf?.length) return bars.map(() => null);
  const vals = calc[ind.type](htf.map(b => b.c), ind.period);
  const out = [];
  let j = -1;
  // No começo de cada semana (ou dia, mês...) vale a média da semana anterior, já
  // fechada; ao longo dela a linha caminha em reta até a média desta semana, em vez
  // de ficar parada e dar um degrau na virada.
  for (const b of bars) {
    while (j + 1 < htf.length && htf[j + 1].t <= b.t) j++;
    if (j < 1 || vals[j - 1] == null || vals[j] == null) { out.push(null); continue; }
    const start = htf[j].t;
    const end = htf[j + 1]?.t ?? start + (start - htf[j - 1].t);
    const frac = Math.min(1, (b.t - start) / (end - start));
    out.push(vals[j - 1] + (vals[j] - vals[j - 1]) * frac);
  }
  return out;
}

function ensureSeries(ind) {
  let entry = indSeries.get(ind.id);
  if (!entry) {
    const series = chart.addSeries(LW.LineSeries, {
      lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: true,
      priceFormat: { type: 'custom', formatter: fmtPrice, minMove: 1e-8 },
    });
    entry = { series, values: [] };
    indSeries.set(ind.id, entry);
  }
  entry.series.applyOptions({ color: ind.color, visible: ind.visible });
  return entry;
}

// Cor da linha no ponto i: fixa, ou verde/vermelha conforme a média sobe ou desce.
function indColor(ind, values, i) {
  if (!ind.slope) return ind.color;
  let j = i - 1;
  while (j >= 0 && values[j] === values[i]) j--;
  return j < 0 || values[j] == null || values[i] >= values[j] ? SLOPE.up : SLOPE.down;
}

function indPoint(ind, values, i) {
  const time = toTime(state.bars[i].t);
  return values[i] == null ? { time } : { time, value: values[i], color: indColor(ind, values, i) };
}

function renderIndicators() {
  const ids = new Set(state.indicators.map(i => i.id));
  for (const [id, e] of indSeries) {
    if (!ids.has(id)) { chart.removeSeries(e.series); indSeries.delete(id); }
  }
  for (const ind of state.indicators) {
    const entry = ensureSeries(ind);
    entry.values = indicatorValues(ind);
    entry.series.setData(state.bars.map((_, i) => indPoint(ind, entry.values, i)));
  }
}

function updateIndicatorsLive(bar) {
  for (const [tf, htf] of htfCache) {
    if (!htf.length) continue;
    const start = periodStart(bar.t, tf);
    const last = htf[htf.length - 1];
    if (start > last.t) htf.push({ t: start, o: bar.c, h: bar.c, l: bar.c, c: bar.c, v: 0 });
    else if (start === last.t) last.c = bar.c;
  }
  for (const ind of state.indicators) {
    const entry = indSeries.get(ind.id);
    if (!entry) continue;
    entry.values = indicatorValues(ind);
    const last = entry.values.length - 1;
    if (entry.values[last] != null) entry.series.update(indPoint(ind, entry.values, last));
  }
}

function saveIndicators() {
  store.set('indicators.v2', state.indicators);
}

async function indicatorsChanged() {
  saveIndicators();
  await loadIndicatorData();
  renderIndicators();
  renderLegend();
}

const indName = ind => `${ind.slope ? 'CC ' : ''}${NAMES[ind.type]}${ind.tf ? ' ' + TF_LEGEND[ind.tf] : ''} ${ind.period} close`;

// ---------- legenda ----------
const legend = $('#legend');
let legendRefs = null;

const ICONS = {
  eye: '<svg viewBox="0 0 18 18" width="16" height="16"><path fill="none" stroke="currentColor" d="M1.5 9s3-5.5 7.5-5.5S16.5 9 16.5 9 13.5 14.5 9 14.5 1.5 9 1.5 9Z"/><circle cx="9" cy="9" r="2.5" fill="none" stroke="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 18 18" width="16" height="16"><circle cx="9" cy="9" r="2.5" fill="none" stroke="currentColor"/><path fill="none" stroke="currentColor" d="M9 1.5v2.2M9 14.3v2.2M1.5 9h2.2M14.3 9h2.2M3.7 3.7l1.6 1.6M12.7 12.7l1.6 1.6M3.7 14.3l1.6-1.6M12.7 5.3l1.6-1.6"/></svg>',
  close: '<svg viewBox="0 0 18 18" width="16" height="16"><path stroke="currentColor" d="m5 5 8 8M13 5l-8 8"/></svg>',
};

function renderLegend() {
  const ohlc = h('span', { class: 'lg-ohlc' });
  const refs = { o: h('span'), h: h('span'), l: h('span'), c: h('span'), chg: h('span'), vol: h('span'), ind: new Map() };
  ohlc.append(
    h('span', {}, h('b', {}, t('chart.open')), refs.o), h('span', {}, h('b', {}, t('chart.high')), refs.h),
    h('span', {}, h('b', {}, t('chart.low')), refs.l), h('span', {}, h('b', {}, t('chart.close')), refs.c), refs.chg,
  );
  const rows = [
    h('div', { class: 'lg-main' },
      h('span', { class: 'lg-title' }, `${state.symbol} · ${TF_LEGEND[state.interval]} · Binance`),
      ohlc,
    ),
  ];
  for (const ind of state.indicators) {
    const val = h('span', { class: 'val', style: `color:${ind.color}` });
    refs.ind.set(ind.id, val);
    rows.push(h('div', { class: `lg-row${ind.visible ? '' : ' off'}` },
      h('span', { class: 'name' }, indName(ind)), val,
      h('span', { class: 'acts' },
        h('button', { title: ind.visible ? t('chart.hide') : t('chart.show'), html: ICONS.eye, onclick: () => { ind.visible = !ind.visible; indicatorsChanged(); } }),
        h('button', { title: t('chart.settings'), html: ICONS.gear, onclick: openIndicators }),
        h('button', { title: t('chart.remove'), html: ICONS.close, onclick: () => { state.indicators = state.indicators.filter(i => i !== ind); indicatorsChanged(); } }),
      ),
    ));
  }
  rows.push(h('div', { class: 'lg-row lg-vol' }, h('span', {}, 'Vol'), refs.vol));
  legend.replaceChildren(...rows);
  legendRefs = refs;
  updateLegend();
}

function updateLegend() {
  if (!legendRefs) return;
  const bars = state.bars;
  const i = state.hoverIndex ?? bars.length - 1;
  const b = bars[i];
  if (!b) return;
  const prev = bars[i - 1];
  const ref = prev ? prev.c : b.o;
  const cls = b.c >= b.o ? 'up' : 'down';
  for (const k of ['o', 'h', 'l', 'c']) {
    legendRefs[k].textContent = fmtPrice(b[k]);
    legendRefs[k].className = cls;
  }
  legendRefs.chg.textContent = `${fmtDelta(b.c - ref)} (${fmtPct(((b.c - ref) / ref) * 100)})`;
  legendRefs.chg.className = b.c >= ref ? 'up' : 'down';
  legendRefs.vol.textContent = fmtVol(b.v);
  legendRefs.vol.className = cls;
  for (const ind of state.indicators) {
    const node = legendRefs.ind.get(ind.id);
    const values = indSeries.get(ind.id)?.values ?? [];
    if (!node) continue;
    node.textContent = values[i] == null ? '∅' : fmtPrice(values[i]);
    node.style.color = values[i] == null ? '' : indColor(ind, values, i);
  }
}

// Contagem regressiva do candle, logo abaixo do preço no eixo (como no TradingView).
const countdownEl = $('#countdown');
function candleEnd(t) {
  if (state.interval !== '1M') return t + INTERVAL_MS[state.interval];
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
function formatLeft(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), hh = Math.floor(s / 3600) % 24, mm = Math.floor(s / 60) % 60, ss = s % 60;
  if (d) return `${d}d ${hh}h`;
  return hh ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}
function updateCountdown() {
  const b = state.bars[state.bars.length - 1];
  const y = b && candles.priceToCoordinate(b.c);
  const left = b ? candleEnd(b.t) - Date.now() : -1;
  if (y == null || left < 0 || y < 0 || y > chartEl.clientHeight - 40) {
    countdownEl.hidden = true;
  } else {
    countdownEl.hidden = false;
    countdownEl.textContent = formatLeft(left);
    countdownEl.style.background = b.c >= b.o ? C.up : C.down;
    countdownEl.style.left = `${chart.timeScale().width()}px`;
    countdownEl.style.width = `${chart.priceScale('right').width()}px`;
    countdownEl.style.top = `${Math.round(y + 9)}px`;
  }
  requestAnimationFrame(updateCountdown);
}

// ---------- barra superior ----------
function renderTopbar() {
  $('#symbol-label').textContent = state.symbol;
  const group = $('#tf-group');
  group.replaceChildren(...TIMEFRAMES.map(([tf, label]) =>
    h('button', { class: `tb-btn${tf === state.interval ? ' active' : ''}`, onclick: () => setInterval_(tf) }, label)));
  document.querySelectorAll('.wl-row').forEach(r => r.classList.toggle('current', r.dataset.sym === state.symbol));
}

function setSymbol(symbol) {
  if (symbol === state.symbol) return;
  state.symbol = symbol;
  store.set('symbol', symbol);
  load();
  loadPerf(symbol);
  renderWatchlist();
}

function showRange(days) {
  const bars = state.bars;
  if (days == null || !bars.length) { chart.timeScale().fitContent(); return; }
  const now = Date.now();
  const from = days === 'ytd' ? Date.UTC(new Date(now).getUTCFullYear(), 0, 1) : now - days * 864e5;
  const first = bars.findIndex(b => b.t >= from);
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, first < 0 ? 0 : first), to: bars.length + 3 });
}

function applyRange(tf, days) {
  if (tf !== state.interval) {
    state.interval = tf;
    store.set('interval', tf);
    load(days);
  } else {
    showRange(days);
  }
}

function setInterval_(tf) {
  if (tf === state.interval) return;
  state.interval = tf;
  store.set('interval', tf);
  load();
}

// ---------- modais ----------
function openModal(title, body, onClose) {
  const back = h('div', { class: 'modal-back' });
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.append(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('span', {}, title), h('button', { onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
  ));
  $('#modal-root').append(back);
  return close;
}

let allSymbols = null;
let symbolInfo = new Map();

async function openSearch(mode, initial = '') {
  const input = h('input', { class: 'search-input', placeholder: t('chart.searchPlaceholder'), value: initial, spellcheck: 'false' });
  const list = h('div');
  const close = openModal(mode === 'add' ? t('chart.addToWatchlist') : t('chart.searchSymbol'), h('div', {}, input, list));
  input.focus();
  input.setSelectionRange(initial.length, initial.length);
  let results = [], sel = 0;

  const pick = s => {
    close();
    if (mode === 'add') addToWatchlist(s.symbol);
    else setSymbol(s.symbol);
  };
  const render = () => {
    const q = input.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!allSymbols) { list.replaceChildren(h('div', { class: 'search-row' }, t('chart.loading'))); return; }
    const rank = s => (s.symbol === q ? 0 : s.symbol.startsWith(q) ? 1 : s.base.startsWith(q) ? 2 : 3) * 10 +
      (s.quote === 'BRL' ? 0 : s.quote === 'USDT' ? 1 : 2);
    results = allSymbols.filter(s => !q || s.symbol.includes(q)).sort((a, b) => rank(a) - rank(b)).slice(0, 60);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.replaceChildren(...results.map((s, i) =>
      h('div', { class: `search-row${i === sel ? ' sel' : ''}`, onclick: () => pick(s) },
        h('span', {}, h('span', { class: 's' }, s.symbol), ' ', h('span', { class: 'q' }, `${s.base} / ${s.quote}`)),
        h('span', { class: 'q' }, 'Binance'))));
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    if (e.key === 'Enter' && results[sel]) pick(results[sel]);
  });
  render();
  if (!allSymbols) {
    try {
      allSymbols = await fetchAllSymbols();
      for (const s of allSymbols) symbolInfo.set(s.symbol, s);
      render();
    } catch (e) {
      toast(t('chart.symbolsFail', { msg: e.message }));
    }
  }
}

function openIndicators() {
  const body = h('div');
  const TF_OPTS = [['', t('chart.indChart')], ...TIMEFRAMES.filter(([tf]) => !['1m', '5m'].includes(tf))];
  const render = () => {
    body.replaceChildren(
      h('div', { class: 'ind-row ind-head' }, h('span'), h('span', {}, t('chart.indType')), h('span', {}, t('chart.indPeriod')), h('span', {}, t('chart.indTf')), h('span', {}, t('chart.indColor')), h('span'), h('span')),
      ...state.indicators.map(ind => {
        const slope = h('label', { class: 'cc', title: t('chart.indSlope') },
          h('input', { type: 'checkbox', checked: !!ind.slope, onchange: e => { ind.slope = e.target.checked; indicatorsChanged(); } }), 'CC');
        const typeSel = h('select', { onchange: e => { ind.type = e.target.value; indicatorsChanged(); } },
          ...Object.entries(NAMES).map(([k, v]) => h('option', { value: k, selected: k === ind.type }, v)));
        const tfSel = h('select', { onchange: e => { ind.tf = e.target.value || null; indicatorsChanged(); } },
          ...TF_OPTS.map(([tf, label]) => h('option', { value: tf, selected: (ind.tf ?? '') === tf }, label)));
        return h('div', { class: 'ind-row' },
          h('input', { type: 'checkbox', checked: ind.visible, onchange: e => { ind.visible = e.target.checked; indicatorsChanged(); } }),
          typeSel,
          h('input', {
            type: 'number', min: 1, max: 1000, value: ind.period,
            onchange: e => { const n = Math.round(+e.target.value); if (n >= 1) { ind.period = n; indicatorsChanged(); } },
          }),
          tfSel,
          h('input', { type: 'color', value: ind.color, oninput: e => { ind.color = e.target.value; indicatorsChanged(); } }),
          slope,
          h('button', { class: 'del', title: t('chart.remove'), html: ICONS.close, onclick: () => { state.indicators = state.indicators.filter(i => i !== ind); indicatorsChanged(); render(); } }),
        );
      }),
      h('button', {
        class: 'add-btn',
        onclick: () => {
          const palette = ['#2962ff', '#ff9800', '#e040fb', '#00bcd4', '#ffeb3b', '#4caf50', '#f44336'];
          state.indicators.push({ id: 'i' + Date.now(), type: 'SMA', period: 20, tf: null, color: palette[state.indicators.length % palette.length], slope: false, visible: true });
          indicatorsChanged();
          render();
        },
      }, t('chart.addMa')),
    );
  };
  render();
  openModal(t('chart.indicators'), body);
}

// ---------- watchlist ----------
let wlStream = null;
let wlToken = 0;
let wlPoll = null;
const dayStats = new Map(); // símbolo -> { open, vol } do dia UTC
const wlRows = new Map();

function renderWatchlist() {
  wlRows.clear();
  $('#wl-rows').replaceChildren(...state.watchlist.map(sym => {
    const last = h('span', {}, '—'), chg = h('span', {}, '—'), pct = h('span', {}, '—');
    const row = h('div', { class: `wl-row${sym === state.symbol ? ' current' : ''}`, 'data-sym': sym, onclick: () => { if (performance.now() - wlDroppedAt > 300) setSymbol(sym); } },
      h('span', { class: 'wl-sym' }, h('i', { class: 'coin', style: `background:${coinColor(sym)}` }, sym[0]), sym), last, chg, pct,
      h('button', {
        class: 'wl-del', title: t('chart.remove'),
        onclick: e => { e.stopPropagation(); state.watchlist = state.watchlist.filter(s => s !== sym); store.set('watchlist.v2', state.watchlist); renderWatchlist(); },
      }, '×'));
    wlRows.set(sym, { last, chg, pct });
    return row;
  }));
  connectWatchlist();
}

// Segurar e arrastar uma linha muda a ordem da watchlist (clique simples continua abrindo o par).
let wlDrag = null;
let wlDroppedAt = 0;
const wlRowsEl = $('#wl-rows');
wlRowsEl.addEventListener('pointerdown', e => {
  const row = e.target.closest('.wl-row');
  if (!row || e.button !== 0 || e.target.closest('.wl-del')) return;
  wlDrag = { row, id: e.pointerId, y0: e.clientY, y: e.clientY, active: false, scroll: 0 };
});
wlRowsEl.addEventListener('pointermove', e => {
  if (!wlDrag || e.pointerId !== wlDrag.id) return;
  wlDrag.y = e.clientY;
  if (!wlDrag.active) {
    if (Math.abs(e.clientY - wlDrag.y0) < 5) return;
    wlDrag.active = true;
    wlRowsEl.setPointerCapture(e.pointerId);
    wlDrag.row.classList.add('dragging');
    document.body.classList.add('resizing-y');
    const autoScroll = () => {
      if (!wlDrag?.active) return;
      const r = wlRowsEl.getBoundingClientRect();
      const edge = 40;
      const dy = wlDrag.y < r.top + edge ? -(r.top + edge - wlDrag.y) : wlDrag.y > r.bottom - edge ? wlDrag.y - (r.bottom - edge) : 0;
      if (dy) { wlRowsEl.scrollTop += dy / 3; placeDragged(); }
      wlDrag.scroll = requestAnimationFrame(autoScroll);
    };
    autoScroll();
  }
  placeDragged();
});
function placeDragged() {
  const { row, y } = wlDrag;
  const others = [...wlRowsEl.children].filter(r => r !== row);
  const before = others.find(r => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
  if (before !== row.nextSibling) wlRowsEl.insertBefore(row, before ?? null);
}
function endWlDrag(e) {
  if (!wlDrag || e.pointerId !== wlDrag.id) return;
  const { row, active, scroll } = wlDrag;
  wlDrag = null;
  if (!active) return;
  cancelAnimationFrame(scroll);
  row.classList.remove('dragging');
  document.body.classList.remove('resizing-y');
  wlDroppedAt = performance.now(); // o clique que vem depois de soltar não troca o par do gráfico
  state.watchlist = [...wlRowsEl.children].map(r => r.dataset.sym);
  store.set('watchlist.v2', state.watchlist);
}
wlRowsEl.addEventListener('pointerup', endWlDrag);
wlRowsEl.addEventListener('pointercancel', endWlDrag);

function coinColor(sym) {
  let x = 0;
  for (const ch of sym.slice(0, 4)) x = (x * 31 + ch.charCodeAt(0)) % 360;
  return sym.startsWith('BTC') ? '#f7931a' : `hsl(${x} 55% 45%)`;
}

// Desempenho (1S, 1M, 3M, 6M, YTD, 1A) a partir de candles diários.
let perf = { symbol: null, bars: [] };
async function loadPerf(symbol) {
  perf = { symbol, bars: [] };
  try {
    const bars = await fetchKlines(symbol, '1d', { limit: 400 });
    if (perf.symbol === symbol) perf.bars = bars;
  } catch (e) {
    console.error(e);
  }
}
function perfHtml(last) {
  const bars = perf.bars;
  if (!bars.length) return '';
  const today = periodStart(Date.now(), '1d');
  const at = t => { // fechamento do último dia antes de t (mesma regra do TradingView)
    let i = bars.findIndex(b => b.t >= t);
    if (i < 0) i = bars.length;
    return i > 0 ? bars[i - 1].c : null;
  };
  const cells = [['1W', 7], ['1M', 30], ['3M', 90], ['6M', 180], ['YTD', 'ytd'], ['1Y', 365]].map(([label, d]) => {
    const t = d === 'ytd' ? Date.UTC(new Date(today).getUTCFullYear(), 0, 1) : today - d * 864e5;
    const ref = bars[0].t > t ? null : at(t);
    if (ref == null) return `<div class="pf"><b>—</b><span>${label}</span></div>`;
    const p = ((last - ref) / ref) * 100;
    return `<div class="pf ${p >= 0 ? 'pos' : 'neg'}"><b>${fmtPct(p)}</b><span>${label}</span></div>`;
  });
  return `<div class="d-title">${t('chart.performance')}</div><div class="perf">${cells.join('')}</div>`;
}

function updateDetail(sym, last, open, vol) {
  const info = symbolInfo.get(sym) ?? state.info;
  const f = fmtWith(info?.precision ?? 2);
  const d = last - open;
  const cls = d >= 0 ? 'up' : 'down';
  document.title = `${sym} ${f.format(last)} ${fmtPct((d / open) * 100)}`;
  $('#wl-detail').innerHTML =
    `<div class="d-sym">${sym}</div>` +
    `<div class="d-name">${info ? `${info.base} / ${info.quote}` : ''} · BINANCE</div>` +
    `<div class="d-price">${f.format(last)} <small>${info?.quote ?? ''}</small></div>` +
    `<div class="d-chg ${cls}">${fmtDelta(d, x => f.format(x))} ${fmtPct((d / open) * 100)}</div>` +
    (vol != null ? `<div class="d-vol"><span>${t('chart.volume')}</span><span>${fmtVol(vol)} ${info?.base ?? ''}</span></div>` : '') +
    perfHtml(last);
}

function updateWlRow(sym, last) {
  const day = dayStats.get(sym);
  if (!day) return;
  const { open, vol } = day;
  if (sym === state.symbol) updateDetail(sym, last, open, vol);
  const r = wlRows.get(sym);
  if (!r) return;
  const f = fmtWith(symbolInfo.get(sym)?.precision ?? 2);
  const d = last - open;
  const cls = d >= 0 ? 'up' : 'down';
  r.last.textContent = f.format(last);
  // a watchlist do TradingView não mostra "+" nos positivos
  r.chg.textContent = fmtDelta(d, x => f.format(x)).replace('+', '');
  r.pct.textContent = fmtPct((d / open) * 100).replace('+', '');
  r.chg.className = r.pct.className = cls;
}

async function refreshDayStats(syms) {
  const rows = await fetchTradingDay(syms);
  for (const t of rows) dayStats.set(t.symbol, { open: +t.openPrice, vol: +t.volume, last: +t.lastPrice });
  return rows;
}

async function connectWatchlist() {
  wlStream?.close();
  wlStream = null;
  clearInterval(wlPoll);
  const token = ++wlToken;
  const syms = [...new Set([...state.watchlist, state.symbol])]; // o símbolo do gráfico alimenta o painel de detalhes
  try {
    const missing = syms.filter(s => !symbolInfo.has(s));
    const [infos] = await Promise.all([missing.length ? fetchSymbolsInfo(missing) : new Map(), refreshDayStats(syms)]);
    for (const [k, v] of infos) symbolInfo.set(k, v);
    if (token !== wlToken) return;
    for (const s of syms) updateWlRow(s, dayStats.get(s)?.last);
  } catch (e) {
    console.error(e);
  }
  if (token !== wlToken) return;
  wlStream = openStream(syms.map(s => `${s.toLowerCase()}@miniTicker`), d => {
    const day = dayStats.get(d.s);
    if (day) day.last = +d.c;
    updateWlRow(d.s, +d.c);
  });
  // abertura e volume do dia: atualiza a cada minuto (e assim vira o dia às 21h de Brasília)
  wlPoll = setInterval(() => refreshDayStats(syms).catch(console.error), 60000);
}

function addToWatchlist(sym) {
  if (!state.watchlist.includes(sym)) {
    state.watchlist = [...state.watchlist, sym];
    store.set('watchlist.v2', state.watchlist);
    renderWatchlist();
  }
}

// ---------- ferramentas de desenho ----------
let priceLines = [];
let shiftDown = false;

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
}

function restoreHLines() {
  for (const pl of priceLines) candles.removePriceLine(pl);
  priceLines = (state.hlines[state.symbol] ?? []).map(price =>
    candles.createPriceLine({ price, color: C.accent, lineWidth: 1, lineStyle: LW.LineStyle.Solid, axisLabelVisible: true }));
}

function addHLine(price) {
  const tick = state.info?.tickSize ?? 0.01;
  const p = +(Math.round(price / tick) * tick).toFixed(state.info?.precision ?? 2);
  state.hlines[state.symbol] = [...(state.hlines[state.symbol] ?? []), p];
  store.set('hlines', state.hlines);
  restoreHLines();
}

function clearDrawings() {
  ruler.clear();
  delete state.hlines[state.symbol];
  store.set('hlines', state.hlines);
  restoreHLines();
}

function onChartClick(point, shift) {
  if (!state.bars.length) return;
  if (ruler.active) { ruler.finish(point); setTool('cursor'); return; }
  if (ruler.done) {
    ruler.clear();
    if (state.tool !== 'measure' && !shift) return;
  }
  if (state.tool === 'measure' || shift) { ruler.start(point); return; }
  if (state.tool === 'hline') {
    const price = candles.coordinateToPrice(point.y);
    if (price != null) addHLine(price);
    setTool('cursor');
  }
}

// Clique próprio (em vez do subscribeClick, que engole cliques rápidos como duplo clique).
let downAt = null;
chartEl.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
chartEl.addEventListener('pointerup', e => {
  if (!downAt || e.button !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  const r = chartEl.getBoundingClientRect();
  const point = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (point.x > chart.timeScale().width() || point.y > r.height - chart.timeScale().height()) return;
  onChartClick(point, e.shiftKey);
});

chart.subscribeCrosshairMove(param => {
  if (param.point && ruler.active) ruler.move(param.point);
  const i = param.logical != null ? Math.round(param.logical) : null;
  state.hoverIndex = param.point && i != null && i >= 0 && i < state.bars.length ? i : null;
  updateLegend();
});

// ---------- eventos da interface ----------
document.querySelectorAll('.tool[data-tool]').forEach(b => b.addEventListener('click', () => {
  ruler.clear();
  setTool(b.dataset.tool === state.tool ? 'cursor' : b.dataset.tool);
}));
$('#clear-drawings').addEventListener('click', clearDrawings);
$('#symbol-btn').addEventListener('click', () => openSearch('chart'));
$('#ind-btn').addEventListener('click', openIndicators);
$('#wl-add').addEventListener('click', () => openSearch('add'));
$('#wl-toggle').addEventListener('click', () => {
  const mobile = matchMedia('(max-width: 760px)').matches;
  $('#app').classList.toggle(mobile ? 'wl-show' : 'wl-hidden');
  store.set('wlHidden', $('#app').classList.contains('wl-hidden'));
});
if (store.get('wlHidden', false)) $('#app').classList.add('wl-hidden');

// Conta: "Entrar" quando deslogado; logado, a inicial do e-mail abre um menu com "Sair".
function renderAccount() {
  const box = $('#account');
  if (!user) {
    box.replaceChildren(h('a', { class: 'tb-btn', href: loginUrl(), title: t('chart.loginHint') }, t('nav.login')));
    return;
  }
  const menu = h('div', { class: 'acc-menu', hidden: true },
    h('div', { class: 'acc-email' }, user.email),
    h('div', { class: 'acc-note' }, t('chart.savedInAccount')),
    h('button', {
      onclick: async () => {
        flushPrefs();
        await logout().catch(console.error);
        location.reload();
      },
    }, t('nav.logout')));
  const btn = h('button', { class: 'tb-btn icon acc-btn', title: user.email, onclick: e => { e.stopPropagation(); menu.hidden = !menu.hidden; } },
    h('span', { class: 'acc-avatar' }, user.email[0].toUpperCase()));
  document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.hidden = true; });
  box.replaceChildren(btn, menu);
}
renderAccount();

// Divisórias arrastáveis: largura da watchlist e altura do painel de detalhes.
function splitter(el, axis, key, apply) {
  const saved = store.get(key, null);
  if (saved != null) apply(saved);
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    document.body.classList.add(`resizing-${axis}`);
    let last = null;
    const move = ev => { last = apply(axis === 'x' ? ev.clientX : ev.clientY, true); };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.classList.remove('drag');
      document.body.classList.remove(`resizing-${axis}`);
      if (last != null) store.set(key, last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  });
  el.addEventListener('dblclick', () => { apply(null); store.set(key, null); });
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
splitter($('#wl-resize-x'), 'x', 'wlWidth', (v, fromPointer) => {
  if (v == null) { $('#app').style.removeProperty('--wl-w'); return null; }
  const w = Math.round(clamp(fromPointer ? window.innerWidth - v : v, 220, window.innerWidth * 0.6));
  $('#app').style.setProperty('--wl-w', `${w}px`);
  return w;
});
splitter($('#wl-resize-y'), 'y', 'wlDetailH', (v, fromPointer) => {
  const wl = $('#watchlist');
  if (v == null) { wl.style.removeProperty('--wl-detail-h'); return null; }
  const hgt = Math.round(clamp(fromPointer ? wl.getBoundingClientRect().bottom - v : v, 80, wl.clientHeight - 160));
  wl.style.setProperty('--wl-detail-h', `${hgt}px`);
  return hgt;
});

function applyScale() {
  chart.priceScale('right').applyOptions({ mode: state.log ? LW.PriceScaleMode.Logarithmic : LW.PriceScaleMode.Normal });
  $('#log-btn').classList.toggle('active', state.log);
}
$('#log-btn').addEventListener('click', () => { state.log = !state.log; store.set('log', state.log); applyScale(); });
$('#auto-btn').addEventListener('click', () => { chart.priceScale('right').applyOptions({ autoScale: true }); updateRealtimeBtn(); });
applyScale();

document.addEventListener('keydown', e => {
  if (e.key === 'Shift') shiftDown = true;
  if ($('#modal-root').children.length || e.target.closest('input, select')) return;
  if (e.key === 'Escape') { ruler.clear(); setTool('cursor'); return; }
  if (e.altKey && e.code === 'KeyH') { e.preventDefault(); setTool('hline'); return; }
  if (e.altKey && e.code === 'KeyR') { e.preventDefault(); resetView(); return; }
  // como no TradingView: começar a digitar abre a busca de símbolo
  if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[a-z0-9]$/i.test(e.key)) {
    e.preventDefault();
    openSearch('chart', e.key.toUpperCase());
  }
});
document.addEventListener('keyup', e => { if (e.key === 'Shift') shiftDown = false; });
window.addEventListener('blur', () => { shiftDown = false; });

// barra inferior: períodos + relógio
$('#ranges').replaceChildren(...RANGES.map(([label, tf, days]) => h('button', { onclick: () => applyRange(tf, days) }, label)));
const clockEl = $('#clock');
const utcLabel = off => {
  const m = Math.abs(off / 60);
  return `UTC${off < 0 ? '-' : '+'}${Math.floor(m / 60)}${m % 60 ? ':' + pad(m % 60) : ''}`;
};
const tick = () => {
  const now = Date.now(), off = tzOffset(now);
  const d = new Date(now + off * 1000);
  clockEl.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${off ? utcLabel(off) : 'UTC'}`;
};
tick();
setInterval(tick, 1000);

renderWatchlist();
load();
loadPerf(state.symbol);
updateCountdown();

window.__grafico = { chart, state, ruler }; // para depuração pelo console
