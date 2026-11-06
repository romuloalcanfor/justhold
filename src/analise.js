// Análise do mercado do JustHold, que aparece na home. Quem escreve é o Claude, na conversa
// do Claude Code, quando o dono pede (ele sempre traz detalhes da dúvida dele). Este módulo:
//  - calcula os números do gráfico (preço, médias, máximas, o que cada regra diz) com os dados
//    públicos da Binance, para o texto e para os blocos da home;
//  - confere o formato do texto antes de publicar;
//  - lê a análise mais recente para a home (no Worker).
// Publicar: node scripts/analise.mjs (ver o comentário no topo do script).

import { makeCtx, SETUPS } from '../public/js/setups.js';

const SYMBOL = 'BTCUSDT';
const BINANCE = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3'];
const UA = 'JustHold (justhold.ai)';
const BR_OFFSET_MS = -3 * 3600e3; // Brasília, sem horário de verão desde 2019
// regras que aparecem na análise gráfica (todas as do simulador ficariam longas demais)
const RULES = ['so50', 'm50_110', 'so200', 'golden', 'w20', 'don20'];

export const brDay = ms => new Date(ms + BR_OFFSET_MS).toISOString().slice(0, 10);

// A análise mais recente, para a home.
export async function latestAnalysis(env) {
  const row = await env.DB.prepare('SELECT id, slot, day, created_at, data FROM analyses ORDER BY created_at DESC LIMIT 1').first();
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}

// ---------- números do gráfico ----------
export async function marketSnapshot(slot, now = Date.now()) {
  const [daily, weekly, ticker] = await Promise.all([
    binance(`/klines?symbol=${SYMBOL}&interval=1d&limit=1000`),
    binance(`/klines?symbol=${SYMBOL}&interval=1w&limit=260`),
    binance(`/ticker/24hr?symbol=${SYMBOL}`),
  ]);
  const toBar = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closed: k[6] < now });
  const all = daily.map(toBar);
  const closed = all.filter(b => b.closed);
  // de manhã o candle do dia ainda está aberto: o preço de agora entra como "hoje"
  const bars = slot === 'manha' ? all : closed;
  const x = makeCtx(bars);
  const last = bars.length - 1;
  const price = bars[last].c;
  const r = n => Math.round(n);
  const pct = (a, b) => (b ? +(((a / b) - 1) * 100).toFixed(2) : null);
  const ago = n => bars[last - n]?.c;

  const smaInfo = n => {
    const s = x.sma(n);
    const v = s[last], before = s[last - 5];
    return v === undefined ? null : { value: r(v), distancePct: pct(price, v), slope5d: before ? pct(v, before) : null };
  };
  const wCloses = weekly.map(k => +k[4]);
  const wsma = n => {
    if (wCloses.length < n) return null;
    const v = wCloses.slice(-n).reduce((a, b) => a + b, 0) / n;
    return { value: r(v), distancePct: pct(price, v) };
  };
  const range = n => {
    const slice = bars.slice(-n);
    return { high: r(Math.max(...slice.map(b => b.h))), low: r(Math.min(...slice.map(b => b.l))) };
  };
  const vol20 = closed.slice(-21, -1).reduce((a, b) => a + b.v, 0) / 20;
  const ath = Math.max(...all.map(b => b.h));

  return {
    slot,
    asOf: new Date(now).toISOString(),
    candle: { day: new Date(bars[last].t).toISOString().slice(0, 10), closed: bars[last].closed,
      open: r(bars[last].o), high: r(bars[last].h), low: r(bars[last].l), close: r(price),
      volumeVs20dPct: vol20 ? pct(bars[last].v, vol20) : null },
    price: r(price),
    change: { h24Pct: +(+ticker.priceChangePercent).toFixed(2), d7Pct: pct(price, ago(7)), d30Pct: pct(price, ago(30)), d90Pct: pct(price, ago(90)) },
    dailySma: { 20: smaInfo(20), 50: smaInfo(50), 110: smaInfo(110), 200: smaInfo(200) },
    weeklySma: { 50: wsma(50), 200: wsma(200) },
    range: { d20: range(20), d55: range(55), d365: range(365) },
    athInData: { value: r(ath), distancePct: pct(price, ath) },
    rules: rulePositions(bars, x),
  };
}

// O que cada regra diz agora, e desde quando.
function rulePositions(bars, x) {
  const out = {};
  for (const id of RULES) {
    const setup = SETUPS[id];
    const st = { pos: setup.warmup ? 0 : 1 };
    let since = null;
    for (let i = Math.max(setup.warmup - 1, 0); i < bars.length; i++) {
      if (!bars[i].closed) continue;
      const d = setup.step(x, i, st);
      if (d && d.to !== st.pos) { st.pos = d.to; since = new Date(bars[i].t).toISOString().slice(0, 10); }
    }
    out[id] = { name: RULE_NAMES[id], position: st.pos ? 'comprado' : 'fora (em dólar)', since };
  }
  return out;
}

const RULE_NAMES = {
  so50: 'Média de 50 dias (fecha acima, compra; fecha abaixo, vende)',
  m50_110: 'Médias 50 + 110 (compra acima das duas, só vende abaixo das duas)',
  so200: 'Média de 200 dias',
  golden: 'Cruz dourada (média de 50 acima da de 200)',
  w20: 'Média de 20 semanas (só no fechamento da semana)',
  don20: 'Rompimento de 20 dias',
};

// Confere o texto: { pt, en } com titulo, resumo, mercado[], grafico[], de_olho[]; e fontes[].
export function validateAnalysis(a) {
  const okLang = l => l && typeof l.titulo === 'string' && typeof l.resumo === 'string'
    && ['mercado', 'grafico', 'de_olho'].every(k => Array.isArray(l[k]) && l[k].every(s => typeof s === 'string'));
  if (!okLang(a?.pt) || !okLang(a?.en)) throw new Error('Análise em formato inesperado.');
  const fontes = (Array.isArray(a.fontes) ? a.fontes : [])
    .filter(f => typeof f?.url === 'string' && /^https?:\/\//.test(f.url))
    .slice(0, 8)
    .map(f => ({ titulo: String(f.titulo ?? '').slice(0, 160), url: f.url }));
  return { pt: a.pt, en: a.en, fontes };
}

// ---------- utilitários ----------
async function binance(path) {
  let err;
  for (const base of BINANCE) {
    try {
      const res = await fetch(base + path, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (res.ok) return await res.json();
      err = new Error(`Binance ${res.status}`);
    } catch (e) { err = e; }
  }
  throw err;
}
