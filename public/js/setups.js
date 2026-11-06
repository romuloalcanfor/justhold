// Setups (estratégias de compra e venda) do JustHold, usados pelo simulador (no navegador) e
// pelo bot simulado (no Worker). Tudo no candle diário: a decisão sai no fechamento do dia
// (nas semanais, no fechamento de domingo, que fecha a semana na Binance).

export const FEE = 0.001; // 0,1% por operação, a taxa padrão da Binance

// ---------- indicadores ----------
export function sma(values, n) {
  const out = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(undefined);
  const k = 2 / (n + 1);
  let e;
  for (let i = 0; i < values.length; i++) {
    e = e === undefined ? values[i] : values[i] * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
}

// máxima (ou mínima) dos n dias anteriores, sem contar o dia
function rolling(values, n, pick) {
  const out = new Array(values.length).fill(undefined);
  for (let i = n; i < values.length; i++) {
    let v = values[i - n];
    for (let j = i - n + 1; j < i; j++) v = pick(v, values[j]);
    out[i] = v;
  }
  return out;
}

// Indicadores de uma série de candles, calculados uma vez só e quando alguém pede.
export function makeCtx(bars) {
  const c = bars.map(b => b.c);
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const x = {
    c,
    o: i => bars[i].o ?? c[i],
    h: () => memo('h', () => bars.map(b => b.h ?? b.c)),
    l: () => memo('l', () => bars.map(b => b.l ?? b.c)),
    sma: n => memo(`s${n}`, () => sma(c, n)),
    ema: n => memo(`e${n}`, () => ema(c, n)),
    high: n => memo(`hi${n}`, () => rolling(x.h(), n, Math.max)),
    low: n => memo(`lo${n}`, () => rolling(x.l(), n, Math.min)),
    // fechamento de semana: o candle diário de domingo (UTC)
    weekEnd: () => memo('we', () => bars.map(b => new Date(b.t).getUTCDay() === 0)),
    // média de n semanas, só nos domingos
    wsma: n => memo(`w${n}`, () => {
      const out = new Array(c.length).fill(undefined), we = x.weekEnd(), weeks = [];
      for (let i = 0; i < c.length; i++) {
        if (!we[i]) continue;
        weeks.push(c[i]);
        if (weeks.length >= n) out[i] = weeks.slice(-n).reduce((a, b) => a + b, 0) / n;
      }
      return out;
    }),
  };
  return x;
}

// ---------- estratégias ----------
// Cada uma tem `warmup` (dias de histórico que precisa) e `step(x, i, st)`, chamado no fechamento
// do dia i: devolve { to: 1 } para ficar comprado, { to: 0 } para ficar de fora (e, se a ordem
// sair num preço que não é o fechamento, { to, price }), ou nada para manter. `st.pos` é a
// posição atual; a estratégia pode guardar mais coisas em `st`.
// As três originais também têm `decide(pos, fechamento, médias)`, usado pelo bot.
const above = (a, b) => (a > b ? 1 : 0);
const ready = (...v) => v.every(n => n !== undefined);

const crossMa = (kind, n) => ({
  group: 'medias', warmup: n,
  step: (x, i) => { const m = x[kind](n)[i]; return ready(m) ? { to: above(x.c[i], m) } : undefined; },
});

const twoMas = (a, b) => ({
  group: 'medias', warmup: b,
  decide: (pos, c, m) => (pos ? (c < m[a] && c < m[b] ? 0 : 1) : (c > m[a] && c > m[b] ? 1 : 0)),
  step(x, i, st) {
    const ma = x.sma(a)[i], mb = x.sma(b)[i];
    return ready(ma, mb) ? { to: this.decide(st.pos, x.c[i], { [a]: ma, [b]: mb }) } : undefined;
  },
});

const maCross = (fast, slow) => ({
  group: 'cruzamentos', warmup: slow,
  step: (x, i) => { const f = x.sma(fast)[i], s = x.sma(slow)[i]; return ready(f, s) ? { to: above(f, s) } : undefined; },
});

const weekly = n => ({
  group: 'semanais', warmup: n * 7 + 7,
  step: (x, i) => {
    if (!x.weekEnd()[i]) return undefined;
    const m = x.wsma(n)[i];
    return ready(m) ? { to: above(x.c[i], m) } : undefined;
  },
});

const breakout = (entry, exit) => ({
  group: 'rompimentos', warmup: entry + 1,
  step: (x, i, st) => {
    const hi = x.high(entry)[i], lo = x.low(exit)[i];
    if (!ready(hi, lo)) return undefined;
    if (!st.pos && x.c[i] > hi) return { to: 1 };
    if (st.pos && x.c[i] < lo) return { to: 0 };
    return undefined;
  },
});

// troca de lado só depois de k fechamentos seguidos do outro lado da média
const confirmed = (n, k) => ({
  group: 'medias', warmup: n + k,
  step: (x, i) => {
    const m = x.sma(n);
    let up = 0, down = 0;
    for (let j = 0; j < k; j++) {
      if (!ready(m[i - j])) return undefined;
      if (x.c[i - j] > m[i - j]) up++; else if (x.c[i - j] < m[i - j]) down++;
    }
    return up === k ? { to: 1 } : down === k ? { to: 0 } : undefined;
  },
});

// Média de 50 com reteste: fechou abaixo, espera o preço voltar na média para vender (ordem
// na média de ontem); fechou acima, espera voltar na média para comprar.
const retest = n => ({
  group: 'medias', warmup: n + 1,
  step: (x, i, st) => {
    const m = x.sma(n), prev = m[i - 1];
    if (!ready(m[i], prev)) return undefined;
    st.mode ??= st.pos ? 'long' : 'flat';
    let trade;
    if (st.mode === 'armedSell' && x.h()[i] >= prev) {
      trade = { to: 0, price: x.o(i) >= prev ? x.o(i) : prev };
      st.mode = 'flat';
    } else if (st.mode === 'armedBuy' && x.l()[i] <= prev) {
      trade = { to: 1, price: x.o(i) <= prev ? x.o(i) : prev };
      st.mode = 'long';
    }
    if (st.mode === 'long' && x.c[i] < m[i]) st.mode = 'armedSell';
    else if (st.mode === 'flat' && x.c[i] > m[i]) st.mode = 'armedBuy';
    return trade;
  },
});

export const SETUPS = {
  hold: { group: 'simples', warmup: 0, decide: () => 1, step: () => ({ to: 1 }) },
  so50: { ...crossMa('sma', 50), decide: (pos, c, m) => above(c, m[50]) },
  m50_110: twoMas(50, 110),
  so20: crossMa('sma', 20),
  so100: crossMa('sma', 100),
  so120: crossMa('sma', 120),
  so200: crossMa('sma', 200),
  ema21: crossMa('ema', 21),
  conf50: confirmed(50, 2),
  retest50: retest(50),
  x20_50: maCross(20, 50),
  golden: maCross(50, 200),
  w7: weekly(7),
  w20: weekly(20),
  w50: weekly(50),
  don20: breakout(20, 10),
  don55: breakout(55, 20),
};
export const GROUPS = ['simples', 'medias', 'cruzamentos', 'semanais', 'rompimentos'];
export const DEFAULT_SLOTS = ['hold', 'so50', 'm50_110'];

export const warmup = id => SETUPS[id].warmup;

// Simula uma estratégia a partir do candle `i0`, com 1 dólar de capital.
// bars: [{ t, o, h, l, c, closed }] em ordem; o último pode estar aberto (preço de agora).
// A posição do primeiro dia é a que a estratégia teria no fechamento anterior (compra na
// abertura, ou em `entry`, para quem começa no meio do dia, como na carteira demo); depois,
// cada fechamento pode comprar ou vender tudo, pagando a taxa.
export function simulate(bars, id, i0, fee = FEE, x = makeCtx(bars), entry) {
  const setup = SETUPS[id];
  const st = { pos: setup.warmup ? 0 : 1 };
  for (let i = Math.max(setup.warmup - 1, 0); i < i0; i++) {
    const d = setup.step(x, i, st);
    if (d) st.pos = d.to;
  }

  let cash = 1, qty = 0;
  const trades = [];
  const trade = (i, to, price) => {
    if (to) {
      const f = cash * fee;
      qty = (cash - f) / price; cash = 0;
      trades.push({ i, side: 'buy', price, fee: f });
    } else {
      const f = qty * price * fee;
      cash = qty * price - f; qty = 0;
      trades.push({ i, side: 'sell', price, fee: f });
    }
    st.pos = to;
  };
  if (st.pos) { st.pos = 0; trade(i0, 1, entry ?? x.o(i0)); }

  const equity = [];
  for (let i = i0; i < bars.length; i++) {
    if (bars[i].closed) {
      const d = setup.step(x, i, st);
      if (d && d.to !== st.pos) trade(i, d.to, d.price ?? x.c[i]);
    }
    equity.push(cash + qty * x.c[i]);
  }
  return { equity, trades, pos: st.pos };
}
