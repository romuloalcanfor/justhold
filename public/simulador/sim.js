// Simulador: "Se eu tivesse colocado X em Y no dia Z e seguido o setup S, hoje eu teria…"
// Preços diários reais da Binance (sem chave), as mesmas regras do bot (js/setups.js) e,
// em português, o dólar de cada dia pela PTAX do Banco Central (via /api/dolar).
import { t, lang, locale, applyI18n, langSwitch } from '/js/i18n.js';
import { fetchKlines } from '/grafico/js/api.js';
import { SETUPS, DEFAULT_SLOTS, simulate, warmup, makeCtx } from '/js/setups.js';

// Funciona com layouts diferentes: todo campo e todo bloco de resultado é opcional (só é
// preenchido se existir na página), botões com data-pick="asset|setup|amount|years|date" e
// data-value escolhem com um toque, e a página pode desenhar o que quiser ouvindo o evento
// "sim:render" (ou usar window.sim).
applyI18n();
document.title = t('meta.simTitle');
document.querySelector('meta[name=description]').content = t('meta.simDesc');
document.getElementById('lang')?.replaceWith(langSwitch());
const $ = s => document.querySelector(s);
const setText = (sel, text) => { const n = $(sel); if (n) n.textContent = text; };
const nav = $('#nav');
addEventListener('scroll', () => nav?.classList.toggle('scrolled', scrollY > 8), { passive: true });

const DAY = 864e5;
const ASSETS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT', XRP: 'XRPUSDT' };
// a data mínima vem das três estratégias principais (as do catálogo que precisam de mais
// histórico ficam de fora até ter dados suficientes)
const MIN_INDEX = Math.max(...DEFAULT_SLOTS.map(warmup));
const BRL = lang === 'pt'; // em português o valor é em reais; em inglês, em dólares
const currency = BRL ? 'BRL' : 'USD';
document.querySelectorAll('#cur, .cur').forEach(n => { n.textContent = BRL ? 'R$' : '$'; });

// ---------- formatação ----------
const intFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
const money = v => new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2, minimumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v);
const compact = new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 });
// valor curto para frases: R$ 153 mil, R$ 1,2 mi
const short = v => (Math.abs(v) >= 1e4 ? compact.format(v) : money(v));
const pct = x => {
  const p = Math.abs(x * 100);
  const s = new Intl.NumberFormat(locale, { maximumFractionDigits: p >= 100 ? 0 : 1 }).format(p);
  return `${x >= 0 ? '+' : '−'}${s}%`;
};
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const dateLong = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// ---------- estado (vai no endereço, para dar para compartilhar) ----------
const q = new URLSearchParams(location.search);
const state = {
  asset: ASSETS[q.get('ativo')] ? q.get('ativo') : 'BTC',
  amount: Math.min(1e9, Math.max(1, parseInt(q.get('valor'), 10) || 10000)),
  date: /^\d{4}-\d{2}-\d{2}$/.test(q.get('data') ?? '') ? q.get('data') : '2020-01-01',
  setup: SETUPS[q.get('setup')] ? q.get('setup') : 'so50',
  // as três estratégias que aparecem na comparação (a pessoa pode trocar cada uma)
  slots: (() => {
    const s = (q.get('comparar') ?? '').split(',').filter(id => SETUPS[id]);
    return new Set(s).size === 3 ? s : [...DEFAULT_SLOTS];
  })(),
};
if (!state.slots.includes(state.setup)) state.setup = state.slots[1];
const amountEl = $('#amount'), assetEl = $('#asset'), dateEl = $('#date'), dateText = $('#date-text'), setupEl = $('#setup');
if (amountEl) amountEl.value = intFmt.format(state.amount);
if (assetEl) assetEl.value = state.asset;
if (dateEl) dateEl.value = state.date;
if (setupEl) setupEl.value = state.setup;
const showDate = () => { if (dateText) dateText.textContent = sampleDate(state.date); };
let bounds = null; // { min, max }: datas possíveis para a moeda escolhida

function saveUrl() {
  const p = new URLSearchParams({ ativo: state.asset, valor: state.amount, data: state.date, setup: state.setup });
  if (state.slots.join() !== DEFAULT_SLOTS.join()) p.set('comparar', state.slots.join());
  history.replaceState(null, '', `?${p}`);
}

// ---------- largura dos campos: do tamanho do texto, como palavras da frase ----------
// (só no layout de frase, .ask; nos outros os campos têm largura própria)
const sentence = $('.ask');
const measurer = document.createElement('span');
measurer.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
sentence?.append(measurer);
function fit(el, text, extraEm = 0) {
  if (!sentence || !el || !sentence.contains(el)) return;
  measurer.textContent = text;
  const em = parseFloat(getComputedStyle(el).fontSize);
  el.style.width = `${Math.ceil(measurer.getBoundingClientRect().width + extraEm * em + 1)}px`;
}
const sampleDate = iso => {
  const [y, m, d] = iso.split('-');
  return lang === 'pt' ? `${d}/${m}/${y}` : `${m}/${d}/${y}`;
};
function fitAll() {
  showDate();
  syncPickers();
  if (amountEl) fit(amountEl, amountEl.value || '0', 0.05);
  if (assetEl) fit(assetEl, assetEl.selectedOptions[0].textContent, 0.66);
  if (setupEl) fit(setupEl, setupEl.selectedOptions[0].textContent, 0.66);
}

// ---------- escolha com um toque (data-pick) ----------
const yearsAgo = n => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return isoDay(d.getTime()); };
function pickTarget(kind, value) {
  if (kind === 'years') return yearsAgo(+value);
  return value;
}
function syncPickers() {
  for (const b of document.querySelectorAll('[data-pick]')) {
    const kind = b.dataset.pick, v = b.dataset.value;
    const on = kind === 'asset' ? v === state.asset
      : kind === 'setup' ? v === state.setup
      : kind === 'amount' ? +v === state.amount
      : kind === 'years' || kind === 'date' ? pickTarget(kind, v) === state.date || (bounds && pickTarget(kind, v) < bounds.min && state.date === bounds.min)
      : false;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  const kind = b.dataset.pick, v = b.dataset.value;
  if (kind === 'asset') setAsset(v);
  else if (kind === 'setup') setSetup(v);
  else if (kind === 'amount') setAmount(+v);
  else if (kind === 'years' || kind === 'date') setDate(pickTarget(kind, v));
});
document.fonts?.ready.then(fitAll);
addEventListener('resize', () => { fitAll(); drawChart(); });

// ---------- dados ----------
const barsCache = new Map();
function loadBars(asset) {
  if (!barsCache.has(asset)) {
    const p = (async () => {
      let all = [], endTime;
      for (let n = 0; n < 12; n++) { // a Binance devolve até 1000 dias por vez; volta no tempo até o início
        const rows = await fetchKlines(ASSETS[asset], '1d', { endTime, limit: 1000 });
        all = rows.concat(all);
        if (rows.length < 1000) break;
        endTime = rows[0].t - 1;
      }
      const now = Date.now();
      return all.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, closed: b.t + DAY <= now }));
    })();
    p.catch(() => barsCache.delete(asset));
    barsCache.set(asset, p);
  }
  return barsCache.get(asset);
}

let fxPromise = null;
function loadFx() {
  if (!BRL) return Promise.resolve(null);
  fxPromise ??= (async () => {
    let rows;
    try {
      const res = await fetch('/api/dolar');
      if (!res.ok) throw new Error(`dolar ${res.status}`);
      rows = await res.json();
    } catch {
      rows = await bcbDirect(); // reserva: direto do Banco Central
    }
    return { days: rows.map(r => r[0]), vals: rows.map(r => r[1]) };
  })();
  fxPromise.catch(() => { fxPromise = null; });
  return fxPromise;
}
async function bcbDirect() {
  const br = d => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const now = new Date(), out = [];
  for (let y = 2017; y <= now.getUTCFullYear(); y += 5) {
    const to = new Date(Math.min(Date.UTC(y + 4, 11, 31), now.getTime()));
    const res = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json&dataInicial=01/01/${y}&dataFinal=${br(to)}`);
    if (!res.ok) throw new Error(`BCB ${res.status}`);
    for (const r of await res.json()) { const [d, m, yy] = r.data.split('/'); out.push([`${yy}-${m}-${d}`, +r.valor]); }
  }
  return out;
}
// cotação do dia (ou do último dia útil antes dele)
function fxAt(fx, day) {
  let lo = 0, hi = fx.days.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fx.days[mid] <= day) lo = mid; else hi = mid - 1; }
  return fx.vals[lo];
}

// ---------- cálculo ----------
let base = null; // o que o último cálculo usou, para calcular outras estratégias sob demanda
function resultFor(id) {
  const { bars, i0, rate, units, x, amount } = base;
  const sim = simulate(bars, id, i0, undefined, x);
  const series = sim.equity.map((e, k) => e * units * rate(i0 + k));
  let peak = amount, worst = 0, worstVal = amount, worstPeak = amount;
  for (const v of series) {
    if (v > peak) peak = v;
    if (v / peak - 1 < worst) { worst = v / peak - 1; worstVal = v; worstPeak = peak; }
  }
  const fees = sim.trades.reduce((sum, tr) => sum + tr.fee * units * rate(tr.i), 0);
  // estratégia que ainda não tinha histórico suficiente no começo
  const late = SETUPS[id].warmup > i0;
  return { series, final: series.at(-1), trades: sim.trades.length, fees, worst, worstVal, worstPeak, late };
}
function compute(bars, fx) {
  let i0 = bars.findIndex(b => isoDay(b.t) >= state.date);
  if (i0 < 0) i0 = bars.length - 1;
  i0 = Math.max(i0, MIN_INDEX);
  const rate = i => (fx ? fxAt(fx, isoDay(bars[i].t)) : 1);
  const units = state.amount / rate(i0); // dólares comprados no primeiro dia
  base = { bars, i0, rate, units, x: makeCtx(bars), amount: state.amount };
  const res = {};
  for (const id of new Set([...state.slots, state.setup, 'hold'])) res[id] = resultFor(id); // "só segurar" sempre, para comparar
  return { i0, days: bars.slice(i0).map(b => isoDay(b.t)), res, amount: state.amount };
}
// ---------- tela ----------
let current = null, runId = 0;

function render() {
  const out = current;
  const r = out.res[state.setup];
  const final = $('#final');
  if (final) {
    final.textContent = money(r.final);
    final.classList.remove('loading');
  }
  const ch = r.final / out.amount - 1;
  const chg = $('#chg');
  if (chg) {
    chg.textContent = pct(ch);
    chg.className = `chg ${ch >= 0 ? 'up' : 'down'}`;
  }
  setText('#how', t(`sim.how.${state.setup}`));

  const worst = $('#worst');
  if (worst) {
    worst.textContent = r.worst <= -0.0005 ? pct(r.worst) : '0%';
    worst.className = r.worst <= -0.0005 ? 'down' : '';
  }
  setText('#worst-sub', r.worst <= -0.0005 ? t('sim.worstSub', { a: short(r.worstPeak), b: short(r.worstVal) }) : '');
  setText('#trades', intFmt.format(r.trades));
  setText('#fees', money(r.fees));

  const max = Math.max(...state.slots.map(id => out.res[id].final));
  $('#rows')?.replaceChildren(...state.slots.map(id => {
    const x = out.res[id];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `row${id === state.setup ? ' on' : ''}`;
    row.setAttribute('aria-pressed', id === state.setup);
    const name = document.createElement('span');
    name.textContent = t(`sim.name.${id}`);
    if (x.final === max && state.slots.some(o => out.res[o].final !== max)) {
      const best = document.createElement('span');
      best.className = 'best';
      best.textContent = t('sim.best');
      name.append(best);
    }
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(1, (x.final / max) * 100)}%`;
    bar.append(fill);
    const val = document.createElement('span');
    val.className = 'val';
    const pc = document.createElement('small');
    const c = x.final / out.amount - 1;
    pc.textContent = pct(c);
    pc.className = c >= 0 ? 'up' : 'down';
    val.append(money(x.final), pc);
    row.append(name, bar, val);
    row.onclick = () => { if (state.setup !== id) setSetup(id); };
    return row;
  }));

  setText('#fine', t('sim.fine', { fx: BRL ? t('sim.fineFx') : '' }));
  drawChart();
  syncPickers();
  document.dispatchEvent(new CustomEvent('sim:render', { detail: { current: out, state: { ...state, slots: [...state.slots] }, bounds } }));
}

async function run() {
  const token = ++runId;
  $('#final')?.classList.add('loading');
  const err = $('#error');
  if (err) err.hidden = true;
  document.dispatchEvent(new CustomEvent('sim:loading'));
  try {
    const [bars, fx] = await Promise.all([loadBars(state.asset), loadFx()]);
    if (token !== runId) return;
    // datas possíveis: a partir de quando a moeda tem histórico suficiente para as médias, até ontem
    bounds = { min: isoDay(bars[MIN_INDEX].t), max: isoDay(Date.now() - DAY) };
    if (dateEl) { dateEl.min = bounds.min; dateEl.max = bounds.max; }
    current = compute(bars, fx);
    const used = current.days[0];
    if (used !== state.date && (state.date < used || state.date > bounds.max)) { // data fora do histórico: ajusta
      state.date = used;
      if (dateEl) dateEl.value = used;
      fitAll();
    }
    saveUrl();
    render();
  } catch (e) {
    if (token !== runId) return;
    console.error(e);
    if (err) err.hidden = false;
    $('#final')?.classList.remove('loading');
  }
}

// ---------- gráfico (SVG próprio: só o necessário para um leigo ler) ----------
const svg = $('#svg');
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
let hover = null;

function niceStep(range, count) {
  const raw = range / count, mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw);
}

function drawChart() {
  if (!current || !svg) return;
  const W = svg.clientWidth, H = svg.clientHeight;
  if (!W || !H) return;
  const main = current.res[state.setup].series;
  const cmp = state.setup === 'hold' ? null : current.res.hold.series;
  const n = main.length;
  const vals = main.concat(cmp ?? [], [current.amount]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { hi *= 1.05; lo *= 0.95; }
  const padV = (hi - lo) * 0.08;
  lo = Math.max(0, lo - padV); hi += padV;
  const top = 6, bottom = H - 26;
  const x = k => (n > 1 ? (k / (n - 1)) * W : W / 2);
  const y = v => top + (1 - (v - lo) / (hi - lo)) * (bottom - top);
  const line = s => s.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('');

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-label', `${t(`sim.name.${state.setup}`)}: ${money(current.amount)} → ${money(main.at(-1))}`);
  const defs = el('defs', {});
  const grad = el('linearGradient', { id: 'area', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(el('stop', { offset: '0%', 'stop-color': '#fff', 'stop-opacity': 0.13 }), el('stop', { offset: '100%', 'stop-color': '#fff', 'stop-opacity': 0 }));
  defs.append(grad);
  const nodes = [defs];

  // linhas de grade com o valor (poucas, discretas)
  const step = niceStep(hi - lo, 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    if (y(v) < top + 10 || y(v) > bottom - 4) continue;
    nodes.push(el('line', { x1: 0, x2: W, y1: y(v), y2: y(v), stroke: 'rgba(255,255,255,.06)' }));
    const label = el('text', { x: 0, y: y(v) - 6, class: 'axis' });
    label.textContent = compact.format(v);
    nodes.push(label);
  }
  // datas embaixo: anos, ou meses quando o período é curto
  const d0 = Date.parse(current.days[0]), d1 = Date.parse(current.days.at(-1));
  const spanDays = (d1 - d0) / DAY;
  const ticks = [];
  if (spanDays > 540) {
    for (let yr = new Date(d0).getUTCFullYear() + 1; yr <= new Date(d1).getUTCFullYear(); yr++) ticks.push([`${yr}-01-01`, String(yr)]);
  } else {
    const every = spanDays > 240 ? 3 : spanDays > 90 ? 2 : 1;
    const s = new Date(d0);
    for (let m = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)); m.getTime() <= d1; m.setUTCMonth(m.getUTCMonth() + every)) {
      ticks.push([isoDay(m.getTime()), m.toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' })]);
    }
  }
  for (const [iso, text] of ticks) {
    const k = current.days.findIndex(d => d >= iso);
    if (k < 0) continue;
    const px = x(k);
    if (px < 24 || px > W - 24) continue;
    const label = el('text', { x: px, y: H - 6, class: 'axis', 'text-anchor': 'middle' });
    label.textContent = text;
    nodes.push(label);
  }

  // valor investido (linha pontilhada de referência)
  nodes.push(el('line', { x1: 0, x2: W, y1: y(current.amount), y2: y(current.amount), stroke: 'rgba(255,255,255,.22)', 'stroke-dasharray': '2 5' }));
  const inv = el('text', { x: W, y: y(current.amount) - 6, class: 'axis', 'text-anchor': 'end' });
  inv.textContent = t('sim.invested');
  nodes.push(inv);

  if (cmp) nodes.push(el('path', { d: line(cmp), fill: 'none', stroke: '#6b6b70', 'stroke-width': 1.6, 'stroke-dasharray': '5 5', 'stroke-linejoin': 'round' }));
  nodes.push(el('path', { d: `${line(main)}L${x(n - 1)},${bottom}L${x(0)},${bottom}Z`, fill: 'url(#area)' }));
  nodes.push(el('path', { d: line(main), fill: 'none', stroke: '#f0f0f0', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // marcador do cursor
  const guide = el('line', { y1: top, y2: bottom, stroke: 'rgba(255,255,255,.25)', visibility: 'hidden' });
  const dotMain = el('circle', { r: 4.5, fill: '#f0f0f0', stroke: '#000', 'stroke-width': 2, visibility: 'hidden' });
  const dotCmp = el('circle', { r: 3.5, fill: '#6b6b70', stroke: '#000', 'stroke-width': 2, visibility: 'hidden' });
  nodes.push(guide, dotCmp, dotMain);
  svg.replaceChildren(...nodes);
  hover = { W, n, x, y, main, cmp, guide, dotMain, dotCmp };

  $('#legend')?.replaceChildren(...(cmp ? [legendItem(t(`sim.name.${state.setup}`), ''), legendItem(t('sim.name.hold'), 'dash')] : []));
}

function legendItem(text, cls) {
  const s = document.createElement('span');
  const i = document.createElement('i');
  if (cls) i.className = cls;
  s.append(i, text);
  return s;
}

const tip = $('#tip');
function showHover(clientX) {
  if (!hover || !tip) return;
  const rect = svg.getBoundingClientRect();
  const k = Math.max(0, Math.min(hover.n - 1, Math.round(((clientX - rect.left) / rect.width) * (hover.n - 1))));
  const px = hover.x(k);
  for (const a of ['x1', 'x2']) hover.guide.setAttribute(a, px);
  hover.guide.setAttribute('visibility', 'visible');
  hover.dotMain.setAttribute('cx', px);
  hover.dotMain.setAttribute('cy', hover.y(hover.main[k]));
  hover.dotMain.setAttribute('visibility', 'visible');
  if (hover.cmp) {
    hover.dotCmp.setAttribute('cx', px);
    hover.dotCmp.setAttribute('cy', hover.y(hover.cmp[k]));
    hover.dotCmp.setAttribute('visibility', 'visible');
  }
  const b = document.createElement('b');
  b.textContent = dateLong(current.days[k]);
  const lines = [b, document.createTextNode(`${t(`sim.name.${state.setup}`)}: ${money(hover.main[k])}`)];
  if (hover.cmp) {
    const h = document.createElement('div');
    h.className = 'hold';
    h.textContent = `${t('sim.name.hold')}: ${money(hover.cmp[k])}`;
    lines.push(h);
  }
  tip.replaceChildren(...lines);
  tip.hidden = false;
  const tw = tip.offsetWidth;
  tip.style.left = `${px + 14 + tw > hover.W ? Math.max(0, px - 14 - tw) : px + 14}px`;
}
function hideHover() {
  if (!hover || !tip) return;
  tip.hidden = true;
  for (const n of [hover.guide, hover.dotMain, hover.dotCmp]) n.setAttribute('visibility', 'hidden');
}
svg?.addEventListener('pointermove', e => showHover(e.clientX));
svg?.addEventListener('pointerdown', e => showHover(e.clientX));
svg?.addEventListener('pointerleave', hideHover);

// ---------- campos ----------
function setAmount(v) {
  state.amount = Math.min(1e9, Math.max(1, Math.round(v)));
  if (amountEl) amountEl.value = intFmt.format(state.amount);
  fitAll();
  run();
}
function setAsset(a) {
  if (!ASSETS[a]) return;
  state.asset = a;
  if (assetEl) assetEl.value = a;
  fitAll();
  run();
}
function setDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  state.date = iso;
  if (dateEl) dateEl.value = iso;
  fitAll();
  run();
}
// troca a estratégia de uma das três posições da comparação (e escolhe a nova)
function setSlot(index, id) {
  if (!SETUPS[id] || !state.slots[index]) return;
  const at = state.slots.indexOf(id);
  if (at >= 0 && at !== index) state.slots[at] = state.slots[index]; // já estava: troca de lugar
  state.slots[index] = id;
  state.setup = id;
  if (setupEl) setupEl.value = id;
  fitAll();
  run();
}
function setSetup(id) {
  if (!SETUPS[id]) return;
  if (!state.slots.includes(id)) { setSlot(state.slots.indexOf(state.setup), id); return; }
  state.setup = id;
  if (setupEl) setupEl.value = id;
  fitAll();
  if (current) { saveUrl(); render(); } else run();
}

let typing;
amountEl?.addEventListener('input', () => {
  const digits = amountEl.value.replace(/\D/g, '').slice(0, 10);
  const v = parseInt(digits, 10);
  amountEl.value = digits ? intFmt.format(v) : '';
  amountEl.setSelectionRange(amountEl.value.length, amountEl.value.length);
  fit(amountEl, amountEl.value || '0', 0.05);
  if (!v) return;
  state.amount = Math.min(v, 1e9);
  syncPickers();
  clearTimeout(typing);
  typing = setTimeout(run, 150);
});
amountEl?.addEventListener('blur', () => {
  if (!amountEl.value) { amountEl.value = intFmt.format(state.amount); fitAll(); }
});
amountEl?.addEventListener('focus', () => amountEl.select());
assetEl?.addEventListener('change', () => setAsset(assetEl.value));
dateEl?.addEventListener('click', () => { try { dateEl.showPicker?.(); } catch {} });
dateEl?.addEventListener('change', () => { if (dateEl.value) setDate(dateEl.value); });
setupEl?.addEventListener('change', () => setSetup(setupEl.value));
document.querySelector('form')?.addEventListener('submit', e => e.preventDefault());
$('#retry')?.addEventListener('click', run);

// para as páginas desenharem o resultado do seu jeito
window.sim = {
  state, setAmount, setAsset, setDate, setSetup, setSlot, money, short, pct, intFmt, t, locale, sampleDate, dateLong,
  // resultado de qualquer estratégia do catálogo com as escolhas atuais (para a busca)
  resultFor: id => (base ? resultFor(id) : null),
  get current() { return current; }, get bounds() { return bounds; }, redraw: drawChart,
};

fitAll();
run();
