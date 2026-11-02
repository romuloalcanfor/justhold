// Dados públicos da Binance (sem chave de API).
const REST = 'https://api.binance.com/api/v3';
const WS = 'wss://stream.binance.com:9443';

export const INTERVAL_MS = {
  '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5,
  '1d': 864e5, '1w': 6048e5, '1M': 2592e6,
};

async function get(path, params = {}) {
  const url = new URL(REST + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  return res.json();
}

const parseKline = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });

export async function fetchKlines(symbol, interval, { endTime, limit = 1000 } = {}) {
  const rows = await get('/klines', { symbol, interval, endTime, limit });
  return rows.map(parseKline);
}

function decimals(tickSize) {
  const s = tickSize.replace(/0+$/, '');
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function parseSymbol(s) {
  const tick = s.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize;
  return { symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset, tickSize: +tick, precision: decimals(tick) };
}

export async function fetchSymbolsInfo(symbols) {
  const d = await get('/exchangeInfo', { symbols: JSON.stringify(symbols), showPermissionSets: false });
  return new Map(d.symbols.map(s => [s.symbol, parseSymbol(s)]));
}

export async function fetchAllSymbols() {
  const d = await get('/exchangeInfo', { symbolStatus: 'TRADING', showPermissionSets: false });
  return d.symbols.map(parseSymbol);
}

// Estatísticas do dia (UTC), como o TradingView usa para Var / Var% e volume.
export function fetchTradingDay(symbols) {
  return get('/ticker/tradingDay', { symbols: JSON.stringify(symbols), type: 'MINI' });
}

// WebSocket com reconexão automática. onStatus recebe true/false.
export function openStream(names, onData, onStatus = () => {}) {
  let ws, closed = false, retry = 0, timer;
  const connect = () => {
    ws = new WebSocket(`${WS}/stream?streams=${names.join('/')}`);
    ws.onopen = () => { retry = 0; onStatus(true); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.data) onData(m.data);
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus(false);
      timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
  };
  connect();
  return {
    close() { closed = true; clearTimeout(timer); ws.close(); },
  };
}
