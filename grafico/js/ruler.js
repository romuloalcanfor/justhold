// Régua de medição (preço, %, barras, tempo, volume), no estilo do TradingView.
const NS = 'http://www.w3.org/2000/svg';
const COLORS = { up: '#2962ff', down: '#f23645' };

function svg(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function arrow(x1, y1, x2, y2) {
  const ang = Math.atan2(y2 - y1, x2 - x1), s = 6;
  const a1 = ang + Math.PI * 0.8, a2 = ang - Math.PI * 0.8;
  return `M${x1} ${y1}L${x2} ${y2}M${x2 + s * Math.cos(a1)} ${y2 + s * Math.sin(a1)}L${x2} ${y2}L${x2 + s * Math.cos(a2)} ${y2 + s * Math.sin(a2)}`;
}

function fmtDuration(ms) {
  const sign = ms < 0 ? '−' : '';
  let m = Math.round(Math.abs(ms) / 6e4);
  const d = Math.floor(m / 1440); m -= d * 1440;
  const h = Math.floor(m / 60); m -= h * 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  return sign + (parts.join(' ') || '0m');
}

export class Ruler {
  constructor({ chart, series, svgEl, labelEl, getBars, getIntervalMs, fmt }) {
    Object.assign(this, { chart, series, svgEl, labelEl, getBars, getIntervalMs, fmt });
    this.a = this.b = null;
    this.active = false;
    this.raf = 0;
  }

  get done() { return !!this.a && !this.active; }

  start(pt) {
    this.a = this.toPoint(pt);
    this.b = { ...this.a };
    this.active = true;
    this.loop();
  }

  move(pt) { if (this.active) this.b = this.toPoint(pt); }

  finish(pt) {
    this.b = this.toPoint(pt);
    this.active = false;
  }

  clear() {
    this.a = this.b = null;
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.svgEl.replaceChildren();
    this.labelEl.hidden = true;
  }

  // Redesenha a cada frame enquanto existir, para acompanhar zoom, scroll e autoescala.
  loop() {
    if (this.raf) return;
    const tick = () => {
      this.render();
      this.raf = this.a ? requestAnimationFrame(tick) : 0;
    };
    this.raf = requestAnimationFrame(tick);
  }

  toPoint({ x, y }) {
    const logical = Math.round(this.chart.timeScale().coordinateToLogical(x));
    return { t: this.logicalToTime(logical), p: this.series.coordinateToPrice(y) };
  }

  // Pontos guardam o tempo (não o índice), assim sobrevivem ao carregamento de histórico antigo.
  logicalToTime(i) {
    const bars = this.getBars(), n = bars.length, iv = this.getIntervalMs();
    if (i < 0) return bars[0].t + i * iv;
    if (i >= n) return bars[n - 1].t + (i - n + 1) * iv;
    return bars[i].t;
  }

  timeToLogical(t) {
    const bars = this.getBars(), n = bars.length, iv = this.getIntervalMs();
    if (t < bars[0].t) return Math.round((t - bars[0].t) / iv);
    if (t > bars[n - 1].t) return n - 1 + Math.round((t - bars[n - 1].t) / iv);
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  render() {
    if (!this.a) return;
    const ts = this.chart.timeScale();
    const ia = this.timeToLogical(this.a.t), ib = this.timeToLogical(this.b.t);
    const xa = ts.logicalToCoordinate(ia), xb = ts.logicalToCoordinate(ib);
    const ya = this.series.priceToCoordinate(this.a.p), yb = this.series.priceToCoordinate(this.b.p);
    if ([xa, xb, ya, yb].some(v => v == null)) {
      this.svgEl.replaceChildren();
      this.labelEl.hidden = true;
      return;
    }

    const up = this.b.p >= this.a.p;
    const color = up ? COLORS.up : COLORS.down;
    const left = Math.min(xa, xb), top = Math.min(ya, yb);
    const w = Math.abs(xb - xa), h = Math.abs(yb - ya);
    const xm = (xa + xb) / 2, ym = (ya + yb) / 2;

    this.svgEl.replaceChildren(
      svg('rect', { x: left, y: top, width: w, height: h, fill: color, 'fill-opacity': 0.18 }),
      svg('path', { d: arrow(xm, ya, xm, yb), stroke: color, 'stroke-width': 1, fill: 'none' }),
      svg('path', { d: arrow(xa, ym, xb, ym), stroke: color, 'stroke-width': 1, fill: 'none' }),
    );

    const bars = this.getBars();
    const dp = this.b.p - this.a.p;
    const pct = (dp / this.a.p) * 100;
    let vol = 0;
    for (let i = Math.max(0, Math.min(ia, ib)); i <= Math.min(bars.length - 1, Math.max(ia, ib)); i++) vol += bars[i].v;

    const { delta, pct: fmtPct, vol: fmtVol, ticks } = this.fmt;
    this.labelEl.innerHTML =
      `<div>${delta(dp)} (${fmtPct(pct)}) ${ticks(dp)}</div>` +
      `<div>${ib - ia} barras, ${fmtDuration(this.b.t - this.a.t)}</div>` +
      `<div>Vol ${fmtVol(vol)}</div>`;
    this.labelEl.style.background = color;
    this.labelEl.hidden = false;
    const lw = this.labelEl.offsetWidth, lh = this.labelEl.offsetHeight;
    const ly = up ? top - lh - 8 : top + h + 8;
    this.labelEl.style.transform = `translate(${Math.round(xm - lw / 2)}px, ${Math.round(ly)}px)`;
  }
}
