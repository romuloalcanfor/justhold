// Carteira demo: a pessoa "investe" dinheiro de mentira hoje, no preço de agora, seguindo uma
// estratégia (só segurar ou uma das regras do simulador), e acompanha dia a dia.
// Nada é guardado de preço: a carteira é só { cripto, estratégia, valor, quando, preço de
// entrada }, e o resultado é recalculado com os candles diários públicos da Binance, com as
// mesmas regras e a mesma taxa do simulador. Quem tem conta guarda na conta; quem não tem,
// neste navegador.
import { t, lang, locale, applyI18n, langSwitch } from '/js/i18n.js';
import { SETUPS, DEFAULT_SLOTS, GROUPS, FEE, makeCtx, simulate } from '/js/setups.js';
import { me, loginUrl } from '/js/conta.js';

const $ = s => document.querySelector(s);
const DAY = 864e5;
const KEY = 'justhold.demo';
const MAX = 20;
const NAMES = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP' };
const REST = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3'];
const STREAMS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
const BRL = lang === 'pt'; // carteiras novas: em reais em português, em dólares em inglês

applyI18n();
document.title = t('meta.demoTitle');
document.querySelector('meta[name=description]').content = t('meta.demoDesc');
$('#lang').replaceWith(langSwitch());
document.querySelectorAll('.cur').forEach(n => { n.textContent = BRL ? 'R$' : '$'; });

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

// ---------- formatação ----------
const money = (v, cur) => new Intl.NumberFormat(locale, { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2, minimumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v);
const pct = x => {
  const p = Math.abs(x) < 0.0005 ? 0 : x * 100;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(p))}%`;
};
const price = v => new Intl.NumberFormat(locale, { maximumFractionDigits: v >= 100 ? 0 : v >= 1 ? 2 : 4 }).format(v);
const dayFmt = ms => new Date(ms).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
// dia de um candle diário (a Binance fecha o dia às 00h UTC, 21h de Brasília: o mesmo dia)
const candleDay = ms => new Date(ms).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' });
const name = id => t(`sim.name.${id}`);

// ---------- estado ----------
const state = {
  wallets: load(),
  user: null,
  bars: {},   // ativo -> candles diários
  live: {},   // par -> preço de agora (BTCUSDT, USDTBRL, ...)
  form: { amount: 10000, asset: 'BTC', setup: 'hold' },
  open: new Set(), // carteiras com as operações abertas
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; }
}
function storeLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(state.wallets)); } catch {}
}
async function save() {
  storeLocal();
  if (!state.user) return;
  try {
    await fetch('/api/demo', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallets: state.wallets }) });
  } catch (e) { console.error(e); }
}

// ---------- preços ----------
async function getJSON(path) {
  let err;
  for (const base of REST) {
    try {
      const r = await fetch(base + path);
      if (r.ok) return await r.json();
      err = new Error(String(r.status));
    } catch (e) { err = e; }
  }
  throw err;
}

async function loadBars(asset) {
  const rows = await getJSON(`/klines?symbol=${asset}USDT&interval=1d&limit=1000`);
  const now = Date.now();
  state.bars[asset] = rows.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], closed: k[6] < now }));
  const last = state.bars[asset].at(-1);
  state.live[`${asset}USDT`] ??= last.c;
}

async function loadFx() {
  if (state.live.USDTBRL) return;
  const r = await getJSON('/ticker/price?symbol=USDTBRL');
  state.live.USDTBRL = +r.price;
}

// Preços ao vivo de tudo que aparece na tela, num WebSocket só.
let ws = null, wsKey = '';
function connectLive(i = 0) {
  const pairs = new Set([`${state.form.asset}USDT`, 'USDTBRL', ...state.wallets.map(w => `${w.asset}USDT`)]);
  const key = [...pairs].sort().join('/');
  if (ws && key === wsKey) return;
  wsKey = key;
  ws?.close();
  const streams = [...pairs].map(p => `${p.toLowerCase()}@miniTicker`).join('/');
  const sock = new WebSocket(`${STREAMS[i % STREAMS.length]}/stream?streams=${streams}`);
  ws = sock;
  let got = false;
  sock.onmessage = e => {
    got = true;
    const d = JSON.parse(e.data).data;
    state.live[d.s] = +d.c;
    scheduleRender();
  };
  sock.onclose = () => {
    if (ws !== sock) return; // trocamos de lista de pares
    ws = null;
    setTimeout(() => { wsKey = ''; connectLive(got ? i : i + 1); }, got ? 5000 : 1000);
  };
}

let raf = 0;
function scheduleRender() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; updateValues(); });
}

// ---------- cálculo ----------
// A simulação (posição e operações) só muda quando chegam candles novos; fica guardada por
// carteira. A cada preço novo, só o valor é refeito.
const sims = new Map(); // id da carteira -> { bars, main, hold }
const ctxs = new WeakMap(); // candles -> indicadores

function simFor(w) {
  const bars = state.bars[w.asset];
  if (!bars) return null;
  const cached = sims.get(w.id);
  if (cached?.bars === bars) return cached;
  const i0 = bars.findIndex(b => w.startedAt >= b.t && w.startedAt < b.t + DAY);
  if (i0 < 0) return null;
  if (!ctxs.has(bars)) ctxs.set(bars, makeCtx(bars));
  const x = ctxs.get(bars);
  const main = simulate(bars, w.setup, i0, FEE, x, w.startPrice);
  const hold = w.setup === 'hold' ? main : simulate(bars, 'hold', i0, FEE, x, w.startPrice);
  // a compra de entrada acontece na hora em que a carteira começou; as outras, no fechamento
  const trades = main.trades.map((tr, k) => ({ ...tr, day: k === 0 && tr.i === i0 && tr.price === w.startPrice ? dayFmt(w.startedAt) : candleDay(bars[tr.i].t) }));
  const out = { bars, main, hold, trades };
  sims.set(w.id, out);
  return out;
}

// Resultado de uma carteira agora: valor, posição, operações e o "só segurar" para comparar.
function evaluate(w) {
  const s = simFor(w);
  if (!s) return null;
  const lastC = s.bars.at(-1).c;
  const live = state.live[`${w.asset}USDT`] ?? lastC;
  // a última linha usa o preço de quando os candles chegaram; corrige para o preço de agora
  const final = r => (r.pos ? r.equity.at(-1) * (live / lastC) : r.equity.at(-1));
  const fxNow = w.currency === 'BRL' ? (state.live.USDTBRL ?? w.fx) : 1;
  const usd = w.amount / w.fx; // dólares no começo
  const value = usd * final(s.main) * fxNow;
  return { value, change: value / w.amount - 1, hold: usd * final(s.hold) * fxNow, pos: s.main.pos, trades: s.trades };
}

// ---------- formulário ----------
function renderForm() {
  const f = state.form;
  $('#cards').replaceChildren(...DEFAULT_SLOTS.map(id => h('div', {
    class: `sc${f.setup === id ? ' on' : ''}`, role: 'button', tabindex: 0, 'aria-pressed': String(f.setup === id),
    onclick: () => pick(id),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(id); } },
  }, h('span', { class: 'n' }, name(id)), h('span', { class: 'd' }, t(`sim.desc.${id}`)))));
  // escolhida pela lista de outras: aparece como um quarto cartão
  if (!DEFAULT_SLOTS.includes(f.setup)) {
    $('#cards').append(h('div', { class: 'sc on', 'aria-pressed': 'true' }, h('span', { class: 'n' }, name(f.setup)), h('span', { class: 'd' }, t(`sim.desc.${f.setup}`))));
  }
  const sel = $('#more');
  const others = Object.keys(SETUPS).filter(id => !DEFAULT_SLOTS.includes(id));
  sel.replaceChildren(
    h('option', { value: '' }, t('demo.more')),
    ...GROUPS.filter(g => others.some(id => SETUPS[id].group === g)).map(g => h('optgroup', { label: t(`sim.group.${g}`) },
      ...others.filter(id => SETUPS[id].group === g).map(id => h('option', { value: id, selected: f.setup === id ? '' : null }, name(id))))),
  );
  if (DEFAULT_SLOTS.includes(f.setup)) sel.value = '';
}
function pick(id) {
  state.form.setup = id;
  renderForm();
}

const amountIn = $('#amount');
const intFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
amountIn.value = intFmt.format(state.form.amount);
amountIn.addEventListener('input', () => {
  const n = +amountIn.value.replace(/\D/g, '');
  state.form.amount = Math.min(n, 1e9);
  amountIn.value = n ? intFmt.format(state.form.amount) : '';
});
$('#asset').addEventListener('change', e => { state.form.asset = e.target.value; connectLive(); });
$('#more').addEventListener('change', e => { if (e.target.value) pick(e.target.value); });

$('#form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#form-msg');
  msg.textContent = '';
  const f = state.form;
  if (!(f.amount >= 1)) { msg.textContent = t('demo.needAmount'); amountIn.focus(); return; }
  if (state.wallets.length >= MAX) { msg.textContent = t('demo.max', { n: MAX }); return; }
  const btn = $('#start');
  btn.disabled = true;
  try {
    await Promise.all([state.bars[f.asset] ? null : loadBars(f.asset), BRL ? loadFx() : null]);
    const pair = `${f.asset}USDT`;
    const w = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      asset: f.asset,
      setup: f.setup,
      amount: f.amount,
      currency: BRL ? 'BRL' : 'USD',
      fx: BRL ? state.live.USDTBRL : 1,
      startedAt: Date.now(),
      startPrice: state.live[pair],
    };
    state.wallets.unshift(w);
    await save();
    connectLive();
    renderWallets();
  } catch (err) {
    console.error(err);
    msg.textContent = t('demo.error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- carteiras ----------
// Monta os cartões. Os números de cada um ficam em `refs`, e updateValues() só troca o texto
// deles a cada preço novo (redesenhar tudo várias vezes por segundo engoliria os cliques).
const refs = new Map(); // id -> { big, chg, pos, hold, shape }
const shapeOf = r => (r ? `${r.pos}|${r.trades.length}` : 'none');

function renderWallets() {
  const list = $('#list');
  refs.clear();
  if (!state.wallets.length) {
    list.replaceChildren(h('p', { class: 'empty' }, t('demo.empty')));
    $('#total').textContent = '';
    return;
  }
  list.replaceChildren(...state.wallets.map(w => {
    const r = evaluate(w);
    const cur = w.currency;
    const weekly = SETUPS[w.setup].group === 'semanais';
    const open = state.open.has(w.id);
    // no "só segurar" a única operação é a compra do primeiro dia: não vale um botão
    const ops = r && w.setup !== 'hold' ? r.trades.length : 0;
    const big = h('span', { class: 'big' });
    const chg = h('span', { class: 'chg' });
    const pos = h('span', { class: 'pos' });
    const hold = h('span', {});
    refs.set(w.id, { big, chg, pos, hold, shape: shapeOf(r) });
    return h('article', { class: 'wallet' },
      h('div', { class: 'w-top' },
        h('span', { class: 'w-name' }, `${NAMES[w.asset]} · ${name(w.setup)}`),
        h('button', { type: 'button', class: 'x', 'aria-label': t('demo.remove'), title: t('demo.remove'), onclick: () => remove(w.id) }, '×')),
      h('div', { class: 'w-value' }, big, chg),
      h('p', { class: 'w-line' }, pos, h('span', { class: 'since' }, t('demo.started', { v: money(w.amount, cur), d: dayFmt(w.startedAt) }))),
      h('p', { class: 'w-meta' }, w.setup === 'hold' ? t('demo.next.hold') : t(weekly ? 'demo.next.weekly' : 'demo.next.daily'), hold),
      ops ? h('button', { type: 'button', class: 'btn uline sm ops', 'aria-expanded': String(open), onclick: () => toggle(w.id) },
        t(ops === 1 ? 'demo.ops1' : 'demo.ops', { n: ops })) : null,
      ops && open ? h('ul', { class: 'trades' }, ...r.trades.map(tr => h('li', {},
        h('span', { class: tr.side === 'buy' ? 'up' : 'down' }, t(tr.side === 'buy' ? 'demo.buy' : 'demo.sell')),
        h('span', {}, tr.day),
        h('span', {}, `US$ ${price(tr.price)}`)))) : null,
    );
  }));
  updateValues();
}

function updateValues() {
  let sum = 0, base = 0;
  for (const w of state.wallets) {
    const ref = refs.get(w.id);
    if (!ref) continue;
    const r = evaluate(w);
    // mudou de lado ou fez operação nova: aí sim redesenha o cartão inteiro
    if (shapeOf(r) !== ref.shape) { renderWallets(); return; }
    if (!r) { ref.big.textContent = '—'; ref.pos.textContent = '…'; continue; }
    sum += r.value; base += w.amount;
    ref.big.textContent = money(r.value, w.currency);
    ref.chg.textContent = pct(r.change);
    ref.chg.className = `chg ${Math.abs(r.change) < 0.0005 ? '' : r.change > 0 ? 'up' : 'down'}`;
    ref.pos.textContent = r.pos ? t('demo.in', { asset: NAMES[w.asset] }) : t('demo.out');
    ref.pos.className = `pos ${r.pos ? 'in' : 'flat'}`;
    ref.hold.textContent = w.setup !== 'hold' ? ` ${t('demo.vsHold', { v: money(r.hold, w.currency) })}` : '';
  }
  const sameCur = new Set(state.wallets.map(w => w.currency)).size === 1;
  const total = $('#total');
  total.textContent = state.wallets.length > 1 && sameCur && base ? `${money(sum, state.wallets[0].currency)} ${pct(sum / base - 1)}` : '';
  const d = base ? sum / base - 1 : 0;
  total.className = `total ${Math.abs(d) < 0.0005 ? '' : d > 0 ? 'up' : 'down'}`;
}

function toggle(id) {
  if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
  renderWallets();
}

async function remove(id) {
  if (!confirm(t('demo.confirmRemove'))) return;
  state.wallets = state.wallets.filter(w => w.id !== id);
  await save();
  connectLive();
  renderWallets();
}

function renderSaveNote() {
  const note = $('#save-note');
  if (state.user) { note.textContent = t('demo.savedAccount'); return; }
  const a = h('a', { href: loginUrl() }, t('demo.loginLink'));
  note.replaceChildren(t('demo.savedLocal') + ' ', a, ` ${t('demo.loginRest')}`);
}

// ---------- início ----------
renderForm();
renderWallets();
renderSaveNote();

(async () => {
  // conta: junta o que está no navegador com o que está salvo na conta
  state.user = await me();
  renderSaveNote();
  if (state.user) {
    try {
      const r = await fetch('/api/demo', { credentials: 'same-origin' }).then(r => r.json());
      const server = Array.isArray(r.wallets) ? r.wallets : [];
      const ids = new Set(server.map(w => w.id));
      const localOnly = state.wallets.filter(w => !ids.has(w.id));
      state.wallets = [...localOnly, ...server].slice(0, MAX);
      if (localOnly.length) await save(); else storeLocal();
    } catch (e) { console.error(e); }
  }
  const assets = new Set([state.form.asset, ...state.wallets.map(w => w.asset)]);
  await Promise.all([...assets].map(a => loadBars(a).catch(console.error)), loadFx().catch(console.error));
  connectLive();
  renderWallets();
  // de tempos em tempos, pega os candles de novo (para o fechamento do dia entrar na conta)
  setInterval(() => {
    const now = new Set(state.wallets.map(w => w.asset));
    Promise.all([...now].map(a => loadBars(a))).then(renderWallets).catch(console.error);
  }, 5 * 60 * 1000);
})();
