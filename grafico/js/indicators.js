import { INTERVAL_MS } from './api.js';

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export const calc = { SMA: sma, EMA: ema };
export const NAMES = { SMA: 'SMA', EMA: 'EMA' };

// Início do período (ms) que contém t. Semanas da Binance começam na segunda 00:00 UTC.
export function periodStart(t, tf) {
  if (tf === '1M') {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const iv = INTERVAL_MS[tf];
  const off = tf === '1w' ? 4 * 864e5 : 0;
  return Math.floor((t - off) / iv) * iv + off;
}
