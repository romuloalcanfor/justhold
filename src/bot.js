// Bot simulado do JustHold: uma vez por dia, logo depois do fechamento do candle diário
// do BTC/USDT (00h UTC, 21h de Brasília), aplica as regras das médias numa carteira
// virtual e anota o que faria. Não manda ordem nenhuma para a corretora.
// Junto, busca o contexto do mercado em fontes gratuitas (Fed, sentimento, futuros,
// notícias) e monta alertas. O contexto só informa: quem decide a operação são as médias.

import { SETUPS, FEE, sma } from '../public/js/setups.js';

const SYMBOL = 'BTCUSDT';
const CAPITAL = 1000; // dólares virtuais por regra
const DAY_MS = 864e5;
const UA = 'JustHold bot (justhold.ai)';
const KLINES = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3'];

// As regras ficam em public/js/setups.js (as mesmas do simulador); aqui só os nomes.
export const STRATEGIES = {
  so50: { name: 'Média de 50', rule: 'Compra no fechamento acima da média de 50; vende no fechamento abaixo.' },
  m50_110: { name: 'Médias 50 + 110', rule: 'Compra quando fecha acima das duas; só vende quando fecha abaixo das duas.' },
  hold: { name: 'Só segurar', rule: 'Comprou no primeiro dia e não vende.' },
};
const decide = (id, ...args) => SETUPS[id].decide(...args);

// ---------- execução diária ----------
export async function runBot(env, now = Date.now()) {
  const bars = await fetchClosedDailyBars(now);
  const sma50 = sma(bars.map(b => b.c), 50);
  const sma110 = sma(bars.map(b => b.c), 110);
  const ma = i => ({ 50: sma50[i], 110: sma110[i] });
  const last = bars.length - 1;
  const today = bars[last];

  const rows = (await env.DB.prepare('SELECT * FROM bot_strategies').all()).results;
  const state = Object.fromEntries(rows.map(r => [r.id, r]));
  const trades = [];
  const signalChanges = [];
  const daySnapshots = new Map(); // dia -> equity, para os dias processados agora

  for (const id of Object.keys(STRATEGIES)) {
    let s = state[id];
    if (!s) {
      // primeira execução: descobre a posição atual repassando a regra no histórico
      let pos = 0;
      for (let i = 110; i <= last; i++) pos = decide(id, pos, bars[i].c, ma(i));
      s = { id, pos: 0, usdt: CAPITAL, btc: 0, started_on: today.day, last_day: today.day };
      if (pos) trades.push(trade(s, 'buy', today, 'início da simulação'));
      state[id] = s;
      continue;
    }
    const from = bars.findIndex(b => b.day > s.last_day);
    if (from < 0) continue; // nenhum candle novo
    for (let i = from; i <= last; i++) {
      const want = decide(id, s.pos, bars[i].c, ma(i));
      if (want !== s.pos) {
        const side = want ? 'buy' : 'sell';
        trades.push(trade(s, side, bars[i], reasonFor(id, side)));
        if (i === last) signalChanges.push({ id, side });
      }
      s.last_day = bars[i].day;
      if (i < last) {
        const snap = daySnapshots.get(bars[i].day) ?? { bar: bars[i], i, equity: {} };
        snap.equity[id] = { pos: s.pos, value: s.usdt + s.btc * bars[i].c };
        daySnapshots.set(bars[i].day, snap);
      }
    }
  }

  const equity = Object.fromEntries(Object.values(state).map(s => [s.id, { pos: s.pos, value: s.usdt + s.btc * today.c }]));
  const context = await fetchContext(now);
  context.alerts = buildAlerts({ state, signalChanges, context, now });
  const message = buildMessage({ state, today, context });

  const stmts = [];
  for (const s of Object.values(state)) {
    stmts.push(env.DB.prepare(
      `INSERT INTO bot_strategies (id, pos, usdt, btc, started_on, last_day) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pos = excluded.pos, usdt = excluded.usdt, btc = excluded.btc, last_day = excluded.last_day`,
    ).bind(s.id, s.pos, s.usdt, s.btc, s.started_on, s.last_day));
  }
  for (const t of trades) {
    stmts.push(env.DB.prepare('INSERT INTO bot_trades (strategy, day, side, price, qty, fee, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(t.strategy, t.day, t.side, t.price, t.qty, t.fee, t.reason));
  }
  // dias que ficaram para trás (o agendamento falhou em algum dia): guarda só preço e carteiras
  for (const snap of daySnapshots.values()) {
    stmts.push(upsertDay(env, snap.bar, ma(snap.i), snap.equity, null, 'Dia processado depois (sem contexto).', now));
  }
  stmts.push(upsertDay(env, today, ma(last), equity, context, message, now));
  await env.DB.batch(stmts);

  return { day: today.day, close: today.c, sma50: sma50[last], sma110: sma110[last], equity, trades, message, context };
}

function upsertDay(env, bar, m, equity, context, message, now) {
  return env.DB.prepare(
    `INSERT INTO bot_days (day, close, sma50, sma110, equity, context, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET close = excluded.close, sma50 = excluded.sma50, sma110 = excluded.sma110,
       equity = excluded.equity, context = excluded.context, message = excluded.message, updated_at = excluded.updated_at`,
  ).bind(bar.day, bar.c, m[50] ?? null, m[110] ?? null, JSON.stringify(equity), context ? JSON.stringify(context) : null, message, now);
}

// Compra ou vende tudo no fechamento do candle, descontando a taxa.
function trade(s, side, bar, reason) {
  let qty, fee;
  if (side === 'buy') {
    fee = s.usdt * FEE;
    qty = (s.usdt - fee) / bar.c;
    s.btc += qty; s.usdt = 0; s.pos = 1;
  } else {
    qty = s.btc;
    fee = qty * bar.c * FEE;
    s.usdt += qty * bar.c - fee; s.btc = 0; s.pos = 0;
  }
  return { strategy: s.id, day: bar.day, side, price: bar.c, qty, fee, reason };
}

function reasonFor(id, side) {
  if (id === 'so50') return side === 'buy' ? 'fechou acima da média de 50' : 'fechou abaixo da média de 50';
  if (id === 'm50_110') return side === 'buy' ? 'fechou acima das médias de 50 e 110' : 'fechou abaixo das médias de 50 e 110';
  return side;
}

// ---------- dados do BTC ----------
async function fetchClosedDailyBars(now) {
  let err;
  for (const base of KLINES) {
    try {
      const rows = await getJSON(`${base}/klines?symbol=${SYMBOL}&interval=1d&limit=400`);
      // só candles fechados; o do dia corrente ainda está mudando
      const bars = rows.filter(k => k[6] < now).map(k => ({ day: isoDay(k[0]), c: +k[4] }));
      if (bars.length > 120) return bars;
      err = new Error('Poucos candles');
    } catch (e) { err = e; }
  }
  throw err;
}

// ---------- contexto do mercado ----------
// Cada fonte é independente: se uma falhar (fora do ar, bloqueio por país), as outras seguem.
export async function fetchContext(now = Date.now()) {
  const names = ['fedRate', 'kalshi', 'polymarket', 'fearGreed', 'futures', 'news'];
  const jobs = [fedRate(), kalshiFed(now), polymarketFed(now), fearGreed(), binanceFutures(), cryptoNews()];
  const results = await Promise.allSettled(jobs);
  const ctx = { fetchedAt: now, errors: {} };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ctx[names[i]] = r.value;
    else ctx.errors[names[i]] = String(r.reason?.message ?? r.reason).slice(0, 200);
  });
  return ctx;
}

// Taxa de juros atual: última declaração do FOMC no site do Fed.
async function fedRate() {
  const rss = await getText('https://www.federalreserve.gov/feeds/press_monetary.xml');
  const item = rssItems(rss).find(it => /FOMC statement/i.test(it.title));
  if (!item) throw new Error('Declaração do FOMC não encontrada no RSS');
  const page = (await getText(item.link)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = page.match(/decided to (maintain|raise|lower) the target range for the federal funds rate (?:at|to) ([\d\-\/]+) to ([\d\-\/]+) percent/i);
  if (!m) throw new Error('Faixa de juros não encontrada na declaração');
  const action = { maintain: 'manteve', raise: 'subiu', lower: 'cortou' }[m[1].toLowerCase()];
  return { action, low: fraction(m[2]), high: fraction(m[3]), date: item.date, link: item.link };
}

// "3-3/4" -> 3.75
function fraction(s) {
  const [whole, frac] = s.split('-');
  if (!frac) return +whole;
  const [a, b] = frac.split('/');
  return +whole + a / b;
}

const fedBucket = s => (/hike|increase/i.test(s) ? 'alta' : /cut|decrease/i.test(s) ? 'corte' : /maintain|no change/i.test(s) ? 'manter' : null);

// Probabilidades da próxima reunião do Fed no Kalshi (mercado de previsão, API pública).
async function kalshiFed(now) {
  const d = await getJSON('https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFEDDECISION&status=open&with_nested_markets=true&limit=10');
  const ev = d.events
    .filter(e => Date.parse(e.strike_date) > now)
    .sort((a, b) => Date.parse(a.strike_date) - Date.parse(b.strike_date))[0];
  if (!ev) throw new Error('Nenhuma reunião aberta no Kalshi');
  const probs = { alta: 0, manter: 0, corte: 0 };
  for (const m of ev.markets) {
    const bucket = fedBucket(m.yes_sub_title ?? '');
    const bid = +m.yes_bid_dollars, ask = +m.yes_ask_dollars;
    const p = bid > 0 && ask > 0 ? (bid + ask) / 2 : +m.last_price_dollars;
    if (bucket && Number.isFinite(p)) probs[bucket] += p;
  }
  return { meeting: ev.strike_date.slice(0, 10), probs: normalize(probs), source: 'Kalshi', link: `https://kalshi.com/markets/kxfeddecision` };
}

// A mesma pergunta no Polymarket, como segunda opinião.
async function polymarketFed(now) {
  const d = await getJSON('https://gamma-api.polymarket.com/public-search?q=fed%20decision&limit_per_type=10');
  const ev = (d.events ?? [])
    .filter(e => !e.closed && /^fed-decision-in-/.test(e.slug ?? '') && Date.parse(e.endDate) > now)
    .sort((a, b) => Date.parse(a.endDate) - Date.parse(b.endDate))[0];
  if (!ev) throw new Error('Nenhuma reunião aberta no Polymarket');
  const probs = { alta: 0, manter: 0, corte: 0 };
  for (const m of ev.markets ?? []) {
    if (m.closed) continue;
    const bucket = fedBucket(m.groupItemTitle ?? m.question ?? '');
    const p = +JSON.parse(m.outcomePrices ?? '[]')[0];
    if (bucket && Number.isFinite(p)) probs[bucket] += p;
  }
  return { endDate: ev.endDate, probs: normalize(probs), source: 'Polymarket', link: `https://polymarket.com/event/${ev.slug}` };
}

function normalize(p) {
  const total = p.alta + p.manter + p.corte;
  if (!(total > 0)) throw new Error('Sem preços');
  return { alta: p.alta / total, manter: p.manter / total, corte: p.corte / total };
}

// Índice de medo e ganância do mercado cripto (0 = medo extremo, 100 = ganância extrema).
async function fearGreed() {
  const d = await getJSON('https://api.alternative.me/fng/?limit=2');
  const [now, prev] = d.data;
  return { value: +now.value, label: now.value_classification, previous: prev ? +prev.value : null };
}

// Futuros perpétuos da Binance: funding (custo de ficar alavancado) e % de contas compradas.
async function binanceFutures() {
  const [prem, ls] = await Promise.all([
    getJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${SYMBOL}`),
    getJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=1d&limit=1`),
  ]);
  return { funding: +prem.lastFundingRate, longAccounts: ls[0] ? +ls[0].longAccount : null };
}

// Manchetes do dia (CoinDesk, RSS gratuito). Só títulos e links, sem IA.
async function cryptoNews() {
  const rss = await getText('https://www.coindesk.com/arc/outboundfeeds/rss/');
  return rssItems(rss).slice(0, 6).map(({ title, link, date }) => ({ title, link, date }));
}

function rssItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const tag = name => decodeXml((it.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) ?? [])[1] ?? '');
    return { title: tag('title'), link: tag('link'), date: tag('pubDate') };
  });
}

function decodeXml(s) {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').trim();
}

// ---------- alertas e mensagem ----------
const pct = (x, d = 0) => `${(x * 100).toFixed(d).replace('.', ',')}%`;
const usd = x => `${Math.round(x).toLocaleString('pt-BR')}`;
const dayBR = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function buildAlerts({ state, signalChanges, context, now }) {
  const alerts = [];
  for (const { id, side } of signalChanges) {
    alerts.push({ level: 'sinal', text: `${STRATEGIES[id].name}: ${side === 'buy' ? 'COMPRAR' : 'VENDER'} — ${reasonFor(id, side)}.` });
  }
  const fed = context.kalshi ?? null;
  const poly = context.polymarket ?? null;
  if (fed) {
    const days = Math.ceil((Date.parse(fed.meeting) - now) / DAY_MS);
    const both = poly ? ` (Kalshi ${pct(fed.probs.alta)} · Polymarket ${pct(poly.probs.alta)})` : ` (Kalshi)`;
    if (fed.probs.alta >= 0.5) {
      alerts.push({ level: 'alerta', text: `O mercado espera ALTA de juros na reunião do Fed de ${dayBR(fed.meeting)}: ${pct(fed.probs.alta)} de chance${both}. Juros mais altos costumam pesar em ativos de risco como o BTC.` });
      if (state.so50?.pos || state.m50_110?.pos) {
        alerts.push({ level: 'alerta', text: 'Uma regra está comprada com alta de juros no horizonte. A média decide, mas vale você olhar.' });
      }
    } else if (fed.probs.corte >= 0.5) {
      alerts.push({ level: 'info', text: `O mercado espera CORTE de juros na reunião do Fed de ${dayBR(fed.meeting)}: ${pct(fed.probs.corte)} de chance. Juros menores costumam ajudar ativos de risco.` });
    }
    if (days >= 0 && days <= 7) alerts.push({ level: 'alerta', text: `Reunião do Fed em ${days === 0 ? 'hoje' : `${days} dia${days > 1 ? 's' : ''}`} (${dayBR(fed.meeting)}): costuma trazer volatilidade.` });
  }
  const fg = context.fearGreed;
  if (fg && fg.value <= 25) alerts.push({ level: 'info', text: `Medo extremo no mercado (Fear & Greed ${fg.value}).` });
  if (fg && fg.value >= 75) alerts.push({ level: 'alerta', text: `Ganância extrema no mercado (Fear & Greed ${fg.value}): euforia costuma anteceder correções.` });
  const fut = context.futures;
  if (fut && fut.funding >= 0.0005) alerts.push({ level: 'alerta', text: `Funding alto nos futuros (${pct(fut.funding, 3)} a cada 8h): muita gente alavancada comprada.` });
  if (fut && fut.funding <= -0.0001) alerts.push({ level: 'info', text: `Funding negativo (${pct(fut.funding, 3)}): os vendidos estão pagando para manter a posição.` });
  if (fut && fut.longAccounts >= 0.7) alerts.push({ level: 'alerta', text: `${pct(fut.longAccounts)} das contas de futuros da Binance estão compradas: varejo carregado de um lado só.` });
  return alerts;
}

function buildMessage({ state, today, context }) {
  const posText = id => (state[id]?.pos ? 'comprado' : 'de fora');
  const parts = [
    `BTC ${usd(today.c)}`,
    `Média 50: ${posText('so50')}`,
    `50 + 110: ${posText('m50_110')}`,
  ];
  const fed = context.kalshi;
  if (fed) {
    const [k, v] = Object.entries(fed.probs).sort((a, b) => b[1] - a[1])[0];
    parts.push(`Fed ${dayBR(fed.meeting)}: ${pct(v)} ${k}`);
  }
  if (context.fearGreed) parts.push(`Fear & Greed: ${context.fearGreed.value}`);
  if (context.futures) {
    const f = context.futures.funding;
    parts.push(`Funding: ${f >= 0.0005 ? 'alto' : f <= -0.0001 ? 'negativo' : 'neutro'}`);
    if (context.futures.longAccounts != null) parts.push(`${pct(context.futures.longAccounts)} das contas compradas`);
  }
  return parts.join(' · ');
}

// ---------- utilitários ----------
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.text();
}

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

// ---------- leitura para a página ----------
export async function botSummary(env) {
  const [strats, days, trades] = await Promise.all([
    env.DB.prepare('SELECT * FROM bot_strategies').all(),
    env.DB.prepare('SELECT day, close, sma50, sma110, equity, message FROM bot_days ORDER BY day DESC LIMIT 400').all(),
    env.DB.prepare('SELECT * FROM bot_trades ORDER BY day DESC, id DESC LIMIT 200').all(),
  ]);
  const latest = await env.DB.prepare('SELECT * FROM bot_days ORDER BY day DESC LIMIT 1').first();
  const close = latest?.close;
  return {
    capital: CAPITAL,
    fee: FEE,
    strategies: strats.results.map(s => ({
      ...s,
      name: STRATEGIES[s.id]?.name ?? s.id,
      rule: STRATEGIES[s.id]?.rule ?? '',
      value: close ? s.usdt + s.btc * close : null,
    })),
    latest: latest && { ...latest, equity: JSON.parse(latest.equity), context: latest.context ? JSON.parse(latest.context) : null },
    days: days.results.map(d => ({ ...d, equity: JSON.parse(d.equity) })),
    trades: trades.results,
  };
}
