// Vídeo da análise do mercado: tudo desenhado num canvas de 1920x1080, sincronizado com a
// narração (um MP3 só, com o início e o fim de cada fala medidos por scripts/video.mjs).
// O relógio é o do áudio: render(t) desenha o quadro do segundo t, sempre igual, o que também
// permite gravar o vídeo quadro a quadro para o YouTube e o Instagram.
//
// Cada fala do roteiro pode trocar a imagem (`v`). Tipos:
//   capa     { titulo, sub }
//   grafico  { dias, medias: [20, 50, 110, 200], destaque: [110], setup: 'so50' | null,
//              marcas: [{ dia: 'AAAA-MM-DD', em: 'c'|'l'|'h'|'o', texto }],
//              linhas: [{ preco, texto }], faixas: [{ de, ate, texto }] }
//   numero   { valor: '−5,5%', rotulo, cor: 'down'|'up', nota, extras: [{ valor, rotulo }] }
//   foto     { foto: 'trump'|'fed'|'capitolio', nome, legenda, credito }
//   medidor  { valor, antes, rotulo }            (medo e ganância)
//   barras   { titulo, fonte, itens: [{ rotulo, valor, cor }] }
//   regras   { ids: ['so50', ...], destaque: [...] }
//   agenda   { titulo, itens: [{ quando, texto }], ate }
//   fim      { titulo, sub, aviso }
import { simulate, makeCtx } from './setups.js';

const W = 1920, H = 1080;
const C = {
  bg: '#050506', card: 'rgba(255,255,255,.045)', cardLine: 'rgba(255,255,255,.10)', grid: 'rgba(255,255,255,.055)',
  text: '#f2f2f2', muted: '#a1a1a6', dim: '#6b6b70', up: '#089981', down: '#f23645', btc: '#f7931a',
};
const MA = { 20: '#22c3e6', 50: '#4caf50', 110: '#ff9800', 200: '#8c7bff' };
const SANS = 'Inter, -apple-system, "Segoe UI", sans-serif';
const SERIF = 'Newsreader, "Times New Roman", serif';
const PHOTOS = { trump: '/img/video/trump.jpg', fed: '/img/video/fed.jpg', capitolio: '/img/video/capitolio.jpg' };
const RULES = {
  so50: 'Média de 50 dias', m50_110: 'Médias 50 e 110', so200: 'Média de 200 dias',
  golden: 'Cruz dourada', w20: 'Média de 20 semanas', don20: 'Rompimento de 20 dias',
};
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// tempos (s): a imagem troca um pouco antes da fala, e a câmera do gráfico anda devagar
const LEAD = 0.4, FADE = 0.6, CAM = 1.4;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
const easeOut = p => 1 - (1 - clamp(p)) ** 3;
const easeInOut = p => { p = clamp(p); return p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2; };
const backOut = p => { p = clamp(p); const c = 1.6; return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2; };
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const fmtDay = t => { const d = new Date(t); return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`; };
const nf = (x, d = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(x);
const usdK = p => `US$ ${nf(p / 1000, 1)} mil`;
const font = (size, weight = 400, fam = SANS) => `${weight} ${size}px ${fam}`;

// ---------- preparação ----------
function prepare(video) {
  const bars = video.bars.map(([t, o, h, l, c, closed]) => ({ t, o, h, l, c, closed: !!closed }));
  const x = makeCtx(bars);
  const idx = new Map(bars.map((b, i) => [dayKey(b.t), i]));
  const falas = video.falas;

  // estado de cada fala: herda da anterior; um tipo novo começa do zero
  const states = [];
  let prev = null;
  for (const f of falas) {
    let s = prev;
    if (f.v) s = f.v.tipo && f.v.tipo !== prev?.tipo ? { ...f.v } : { ...prev, ...f.v };
    states.push(s);
    prev = s;
  }
  const sceneKey = s => `${s.tipo}|${s.tipo === 'foto' ? s.foto : s.tipo === 'numero' ? s.valor : ''}`;
  const sceneStart = [];
  states.forEach((s, i) => { sceneStart.push(i && sceneKey(states[i - 1]) === sceneKey(s) ? sceneStart[i - 1] : i); });

  // desde quando cada elemento está na tela (para animar só quando ele aparece)
  const keysOf = s => {
    const k = [];
    if (s.tipo === 'grafico') {
      (s.medias ?? []).forEach(n => k.push(`m${n}`));
      (s.marcas ?? []).forEach(m => k.push(`k${m.dia}${m.texto}`));
      (s.linhas ?? []).forEach(l => k.push(`l${l.preco}`));
      (s.faixas ?? []).forEach(f => k.push(`f${f.de}-${f.ate}`));
      if (s.setup) k.push(`s${s.setup}`);
    }
    if (s.tipo === 'numero') (s.extras ?? []).forEach(e => k.push(`x${e.valor}`));
    return k;
  };
  const since = [];
  states.forEach((s, i) => {
    const m = new Map();
    const start = falas[i].t0 - LEAD;
    for (const k of keysOf(s)) m.set(k, i && sceneStart[i] !== i && since[i - 1].has(k) ? since[i - 1].get(k) : start);
    since.push(m);
  });

  const sims = new Map();
  const sim = id => {
    if (!sims.has(id)) {
      const i0 = Math.min(220, bars.length - 1);
      const r = simulate(bars, id, i0, 0.001, x);
      const trades = r.trades.filter((tr, k) => !(k === 0 && tr.i === i0));
      const startIn = r.trades[0]?.i === i0; // já estava comprada antes do começo
      sims.set(id, { trades, pos: r.pos, startIn, i0 });
    }
    return sims.get(id);
  };

  const imgs = {};
  for (const s of states) if (s.tipo === 'foto' && PHOTOS[s.foto] && !imgs[s.foto]) {
    const im = new Image();
    im.src = PHOTOS[s.foto];
    imgs[s.foto] = im;
  }

  // legenda: cada fala em blocos de até ~2 linhas, com o tempo de cada palavra
  const captions = falas.map(f => {
    const chunks = splitCaption(f.texto);
    const weight = s => s.length + (/[.!?]$/.test(s) ? 8 : /[,:;]$/.test(s) ? 4 : 0);
    const total = chunks.reduce((a, c) => a + weight(c), 0);
    let acc = 0;
    return chunks.map(c => {
      const a = f.t0 + (acc / total) * (f.t1 - f.t0);
      acc += weight(c);
      const b = f.t0 + (acc / total) * (f.t1 - f.t0);
      const words = c.split(' ');
      const wl = words.reduce((s, w) => s + w.length + 1, 0);
      let wa = 0;
      return { a, b, text: c, words: words.map(w => { const s0 = a + (wa / wl) * (b - a); wa += w.length + 1; return { w, s: s0 }; }) };
    });
  });

  return { bars, x, idx, falas, states, sceneStart, since, sim, imgs, captions, video };
}

function splitCaption(text) {
  const out = [];
  for (const sentence of text.split(/(?<=[.!?:])\s+/)) {
    if (sentence.length <= 78) { out.push(sentence); continue; }
    // frase longa: quebra nas vírgulas, ou nas palavras, em pedaços de até ~78 letras
    const parts = sentence.split(/(?<=,)\s+/);
    let cur = '';
    for (const p of parts) {
      if (p.length > 78) {
        for (const w of p.split(' ')) {
          if ((cur + ' ' + w).trim().length > 70 && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
        }
      } else if ((cur + ' ' + p).trim().length > 78 && cur) { out.push(cur); cur = p; } else cur = (cur + ' ' + p).trim();
    }
    if (cur) out.push(cur);
  }
  return out;
}

function wrap(g, text, max) {
  const lines = [];
  let cur = '';
  for (const w of text.split(' ')) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function pill(g, x, y, text, { bg, fg = '#fff', size = 26, weight = 600, align = 'left', padX = 16, h = size + 20 } = {}) {
  g.font = font(size, weight);
  const w = g.measureText(text).width + padX * 2;
  const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  roundRect(g, x0, y - h / 2, w, h, h / 2);
  g.fillStyle = bg;
  g.fill();
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(text, x0 + padX, y + 1);
  return w;
}

// ---------- cenas ----------
const CH = { x0: 100, x1: 1660, y0: 190, y1: 770 }; // área do gráfico

function camera(P, s) {
  const n = P.bars.length;
  const dias = s.dias ?? 90;
  const a = n - dias, b = n - 1 + Math.max(2, dias * 0.14);
  let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(0, Math.floor(a)); i < n; i++) { lo = Math.min(lo, P.bars[i].l); hi = Math.max(hi, P.bars[i].h); }
  for (const m of s.medias ?? []) {
    const v = P.x.sma(m);
    for (let i = Math.max(0, Math.floor(a)); i < n; i++) if (v[i] !== undefined) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  }
  for (const l of s.linhas ?? []) { lo = Math.min(lo, l.preco); hi = Math.max(hi, l.preco); }
  for (const f of s.faixas ?? []) { lo = Math.min(lo, f.de); hi = Math.max(hi, f.ate); }
  const r = hi - lo;
  return { a, b, lo: lo - r * 0.16, hi: hi + r * 0.16 };
}

function drawChart(g, P, i, t) {
  const s = P.states[i];
  const prevSame = i > 0 && P.sceneStart[i] !== i ? P.states[i - 1] : null;
  const start = P.falas[i].t0 - LEAD;
  const p = prevSame ? easeInOut((t - start) / CAM) : 1;
  const c1 = camera(P, s), c0 = prevSame ? camera(P, prevSame) : c1;
  const cam = { a: lerp(c0.a, c1.a, p), b: lerp(c0.b, c1.b, p), lo: lerp(c0.lo, c1.lo, p), hi: lerp(c0.hi, c1.hi, p) };
  const { x0, x1, y0, y1 } = CH;
  const X = i2 => x0 + ((i2 - cam.a + 0.5) / (cam.b - cam.a)) * (x1 - x0);
  const Y = v => y1 - ((v - cam.lo) / (cam.hi - cam.lo)) * (y1 - y0);
  const bw = ((x1 - x0) / (cam.b - cam.a)) * 0.68;
  const n = P.bars.length;
  const age = k => t - (P.since[i].get(k) ?? start);

  // grade e eixo de preço
  const range = cam.hi - cam.lo;
  const step = [250, 500, 1000, 2000, 2500, 5000, 10000, 20000].find(st => range / st <= 7) ?? 20000;
  g.save();
  g.font = font(24, 500);
  g.textBaseline = 'middle';
  for (let v = Math.ceil(cam.lo / step) * step; v <= cam.hi; v += step) {
    const y = Y(v);
    if (y < y0 - 4 || y > y1 + 4) continue;
    g.strokeStyle = C.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.fillStyle = C.dim; g.textAlign = 'left';
    g.fillText(`${nf(v / 1000, step < 1000 ? 1 : 0)} mil`, x1 + 18, y);
  }
  // datas
  const span = cam.b - cam.a;
  const dstep = [1, 2, 5, 7, 10, 14, 21, 30, 45, 60].find(d => span / d <= 8) ?? 60;
  g.textAlign = 'center'; g.fillStyle = C.dim;
  for (let k = n - 1; k >= Math.max(0, Math.floor(cam.a)); k -= dstep) {
    const xx = X(k);
    if (xx < x0 + 20 || xx > x1 - 10) continue;
    g.fillText(fmtDay(P.bars[k].t), xx, y1 + 34);
  }
  g.restore();

  g.save();
  g.beginPath(); g.rect(x0, y0 - 40, x1 - x0, y1 - y0 + 40); g.clip();

  // regra (setup): faixas verdes quando comprada
  const sAge = s.setup ? age(`s${s.setup}`) : -1;
  const sim = s.setup ? P.sim(s.setup) : null;
  if (sim) {
    const al = easeOut(sAge / 0.8);
    let open = sim.startIn ? sim.i0 : null;
    const spans = [];
    for (const tr of sim.trades) {
      if (tr.side === 'buy') open = tr.i;
      else if (open != null) { spans.push([open, tr.i]); open = null; }
    }
    if (open != null) spans.push([open, n - 1 + 3]);
    g.fillStyle = `rgba(8,153,129,${0.13 * al})`;
    for (const [a, b] of spans) g.fillRect(X(a) + bw / 2, y0 - 40, X(b) - X(a), y1 - y0 + 40);
  }

  // faixas de preço (apoio)
  for (const f of s.faixas ?? []) {
    const r = easeOut(age(`f${f.de}-${f.ate}`) / 0.9);
    const ya = Y(f.ate), yb = Y(f.de);
    g.fillStyle = `rgba(247,147,26,${0.16 * r})`;
    g.fillRect(x0, ya, (x1 - x0) * r, yb - ya);
    g.strokeStyle = `rgba(247,147,26,${0.6 * r})`; g.lineWidth = 2; g.setLineDash([]);
    g.beginPath(); g.moveTo(x0, ya); g.lineTo(x0 + (x1 - x0) * r, ya); g.moveTo(x0, yb); g.lineTo(x0 + (x1 - x0) * r, yb); g.stroke();
  }

  // candles
  for (let k = Math.max(0, Math.floor(cam.a) - 1); k < n; k++) {
    const b = P.bars[k], xx = X(k);
    if (xx < x0 - bw || xx > x1 + bw) continue;
    const up = b.c >= b.o;
    g.globalAlpha = b.closed ? 1 : 0.85;
    g.strokeStyle = g.fillStyle = up ? C.up : C.down;
    g.lineWidth = Math.max(1.5, bw * 0.12);
    g.beginPath(); g.moveTo(xx, Y(b.h)); g.lineTo(xx, Y(b.l)); g.stroke();
    const top = Y(Math.max(b.o, b.c)), hh = Math.max(2, Math.abs(Y(b.o) - Y(b.c)));
    g.fillRect(xx - bw / 2, top, bw, hh);
  }
  g.globalAlpha = 1;

  // médias: entram desenhando da esquerda para a direita; as fora do destaque ficam apagadas
  const weightOf = (st, m) => (!st?.destaque?.length || st.destaque.includes(m) ? 1 : 0.22);
  const labels = [];
  for (const m of s.medias ?? []) {
    const v = P.x.sma(m);
    const r = easeInOut(age(`m${m}`) / 1.3);
    const wt = lerp(prevSame ? weightOf(prevSame, m) : weightOf(s, m), weightOf(s, m), easeOut((t - start) / 0.7));
    const big = s.destaque?.includes(m);
    const iA = Math.max(0, Math.floor(cam.a) - 1), iB = iA + (n - 1 - iA) * r;
    g.strokeStyle = MA[m]; g.globalAlpha = wt; g.lineWidth = big ? 6 : 3.5; g.lineJoin = 'round';
    if (big) { g.shadowColor = MA[m]; g.shadowBlur = 18; }
    g.beginPath();
    let first = true;
    for (let k = iA; k <= Math.ceil(iB) && k < n; k++) {
      if (v[k] === undefined) continue;
      const xx = k > iB ? X(iB) : X(k), yy = Y(v[k]);
      if (first) { g.moveTo(xx, yy); first = false; } else g.lineTo(xx, yy);
    }
    g.stroke();
    g.shadowBlur = 0; g.globalAlpha = 1;
    if (r > 0.95) labels.push({ m, y: Y(v[n - 1]), v: v[n - 1], wt });
  }

  // linhas de preço (tracejadas)
  for (const l of s.linhas ?? []) {
    const r = easeOut(age(`l${l.preco}`) / 0.9);
    const y = Y(l.preco);
    g.strokeStyle = `rgba(255,255,255,${0.85 * r})`; g.lineWidth = 2.5; g.setLineDash([14, 10]);
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + (x1 - x0) * r, y); g.stroke();
    g.setLineDash([]);
    if (r > 0.3) { g.globalAlpha = r; pill(g, x0 + 20, y - 30, l.texto, { bg: 'rgba(20,20,24,.92)', size: 26 }); g.globalAlpha = 1; }
  }
  for (const f of s.faixas ?? []) {
    const r = easeOut(age(`f${f.de}-${f.ate}`) / 0.9);
    if (r > 0.3) { g.globalAlpha = r; pill(g, x0 + 20, Y(f.de) + 34, f.texto, { bg: 'rgba(247,147,26,.92)', fg: '#111', size: 26 }); g.globalAlpha = 1; }
  }

  // compras e vendas da regra
  if (sim) {
    let k = 0;
    for (const tr of sim.trades) {
      if (tr.i < cam.a - 1) continue;
      const r = backOut((sAge - 0.5 - k * 0.35) / 0.6);
      k++;
      if (r <= 0) continue;
      const b = P.bars[tr.i], xx = X(tr.i), buy = tr.side === 'buy';
      const yy = buy ? Y(b.l) + 26 : Y(b.h) - 26;
      g.save(); g.translate(xx, yy); g.scale(r, r);
      g.fillStyle = buy ? C.up : C.down;
      g.beginPath();
      if (buy) { g.moveTo(0, -16); g.lineTo(16, 12); g.lineTo(-16, 12); } else { g.moveTo(0, 16); g.lineTo(16, -12); g.lineTo(-16, -12); }
      g.closePath(); g.fill();
      g.restore();
      if (r > 0.6 && sim.trades.indexOf(tr) >= sim.trades.length - 2) {
        const label = `${buy ? 'Compra' : 'Venda'} · ${usdK(tr.price)} · ${fmtDay(b.t)}`;
        g.globalAlpha = clamp((r - 0.6) / 0.4);
        g.font = font(26, 600);
        const w = g.measureText(label).width + 32;
        // ao lado da seta (embaixo dela fica a legenda): à direita, ou à esquerda se não couber
        const lx = xx + 28 + w < x1 ? xx + 28 : xx - 28 - w;
        pill(g, lx, yy, label, { bg: buy ? C.up : C.down, size: 26 });
        g.globalAlpha = 1;
      }
    }
  }

  // preço de agora
  const last = P.bars[n - 1];
  g.strokeStyle = 'rgba(247,147,26,.55)'; g.lineWidth = 1.5; g.setLineDash([4, 6]);
  g.beginPath(); g.moveTo(x0, Y(last.c)); g.lineTo(x1, Y(last.c)); g.stroke(); g.setLineDash([]);

  // marcas (círculo pulsando e um balão)
  for (const mk of s.marcas ?? []) {
    const k = P.idx.get(mk.dia);
    if (k === undefined) continue;
    const r = backOut(age(`k${mk.dia}${mk.texto}`) / 0.7);
    const b = P.bars[k], xx = X(k), yy = Y(b[mk.em ?? 'c']);
    const pulse = (t * 1.2) % 1;
    g.strokeStyle = `rgba(255,255,255,${0.7 * (1 - pulse) * clamp(r)})`; g.lineWidth = 3;
    g.beginPath(); g.arc(xx, yy, 14 + pulse * 30, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(xx, yy, 9 * clamp(r, 0, 1.3), 0, Math.PI * 2); g.fill();
    if (r > 0.4) {
      const side = mk.em === 'l';
      g.globalAlpha = clamp((r - 0.4) / 0.6);
      g.font = font(30, 600);
      const w = g.measureText(mk.texto).width + 40;
      g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 2;
      if (side) {
        // na mínima: o balão vai para o lado (embaixo fica a legenda)
        const left = xx - 70 - w > x0;
        const bx = left ? xx - 70 - w : xx + 70;
        g.beginPath(); g.moveTo(xx + (left ? -14 : 14), yy); g.lineTo(left ? bx + w : bx, yy); g.stroke();
        pill(g, bx, yy, mk.texto, { bg: '#fff', fg: '#111', size: 30, h: 52 });
      } else {
        const by = yy - 70;
        g.beginPath(); g.moveTo(xx, yy - 12); g.lineTo(xx, by + 22); g.stroke();
        pill(g, clamp(xx - w / 2, x0 + 4, x1 - w - 4), by, mk.texto, { bg: '#fff', fg: '#111', size: 30, h: 52 });
      }
      g.globalAlpha = 1;
    }
  }
  g.restore();

  // etiquetas das médias na direita (sem se encostar)
  labels.sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + 38);
  for (const l of labels) {
    g.globalAlpha = Math.max(0.35, l.wt);
    pill(g, x1 - 10, l.y, `Média ${l.m} · ${nf(l.v / 1000, 1)} mil`, { bg: MA[l.m], fg: '#0a0a0a', size: 22, align: 'right', h: 34, padX: 12 });
  }
  g.globalAlpha = 1;
  pill(g, x1 + 8, Y(last.c), nf(last.c), { bg: C.btc, fg: '#111', size: 24, h: 38, padX: 12 });

  // nome da regra e posição
  if (sim) {
    const al = easeOut(sAge / 0.6);
    g.globalAlpha = al;
    const lastTr = sim.trades.at(-1);
    const status = sim.pos ? `Comprada desde ${fmtDay(P.bars[lastTr?.i ?? sim.i0].t)}` : `Fora, em dólar, desde ${fmtDay(P.bars[lastTr.i].t)}`;
    const w = pill(g, x0, y0 - 52, `Regra: ${RULES[s.setup] ?? s.setup}`, { bg: 'rgba(255,255,255,.12)', size: 30, h: 54 });
    pill(g, x0 + w + 14, y0 - 52, status, { bg: sim.pos ? C.up : C.down, size: 28, h: 54 });
    g.globalAlpha = 1;
  }
}

function drawCapa(g, P, i, t, s) {
  const age = t - (P.falas[P.sceneStart[i]].t0 - LEAD);
  // fundo: a linha do preço dos últimos 90 dias, desenhando
  const n = P.bars.length, a = n - 90;
  let lo = Infinity, hi = -Infinity;
  for (let k = a; k < n; k++) { lo = Math.min(lo, P.bars[k].c); hi = Math.max(hi, P.bars[k].c); }
  const r = easeInOut(age / 3);
  const X = k => 60 + ((k - a) / 89) * (W - 120), Y = v => 1000 - ((v - lo) / (hi - lo)) * 300;
  const end = a + 89 * r;
  const grad = g.createLinearGradient(0, 700, 0, 1000);
  grad.addColorStop(0, 'rgba(247,147,26,.14)'); grad.addColorStop(1, 'rgba(247,147,26,0)');
  g.beginPath(); g.moveTo(X(a), 1000);
  for (let k = a; k <= end; k++) g.lineTo(X(k), Y(P.bars[k].c));
  g.lineTo(X(Math.floor(end)), 1000); g.closePath();
  g.fillStyle = grad; g.fill();
  g.beginPath();
  for (let k = a; k <= end; k++) k === a ? g.moveTo(X(k), Y(P.bars[k].c)) : g.lineTo(X(k), Y(P.bars[k].c));
  g.strokeStyle = 'rgba(247,147,26,.4)'; g.lineWidth = 4; g.stroke();

  const v = P.video;
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.globalAlpha = easeOut(age / 0.8);
  g.font = font(34, 500); g.fillStyle = C.btc;
  g.fillText(`JustHold · ${v.rotulo ?? ''}`.toUpperCase(), W / 2, 330 - 20 * (1 - easeOut(age / 0.8)));
  g.globalAlpha = easeOut((age - 0.3) / 0.9);
  g.font = font(132, 400, SERIF); g.fillStyle = C.text;
  const lines = wrap(g, s.titulo, 1600);
  lines.forEach((l, k) => g.fillText(l, W / 2, 480 + k * 140 + 30 * (1 - easeOut((age - 0.3) / 0.9))));
  g.globalAlpha = easeOut((age - 0.9) / 0.9);
  g.font = font(42, 400); g.fillStyle = C.muted;
  wrap(g, s.sub ?? '', 1400).forEach((l, k) => g.fillText(l, W / 2, 500 + lines.length * 140 + k * 56));
  g.globalAlpha = 1;
}

function drawNumero(g, P, i, t, s) {
  const age = t - (P.falas[P.sceneStart[i]].t0 - LEAD);
  const color = s.cor === 'down' ? C.down : s.cor === 'up' ? C.up : C.text;
  // fundo: setas descendo devagar
  g.save();
  g.globalAlpha = 0.07;
  g.strokeStyle = color; g.lineWidth = 10; g.lineJoin = 'round';
  for (let k = 0; k < 5; k++) {
    const off = ((t * 30 + k * 260) % 1300) - 200;
    g.beginPath();
    let x = -100 + k * 420, y = off - 300;
    g.moveTo(x, y);
    for (let j = 0; j < 8; j++) { x += 70; y += j % 2 ? -40 : 120; g.lineTo(x, y); }
    g.stroke();
  }
  g.restore();

  // número contando até o valor
  const m = s.valor.match(/\d+(?:[.,]\d+)?/);
  let text = s.valor;
  if (m) {
    const dec = (m[0].split(',')[1] ?? '').length;
    const target = Number(m[0].replace('.', '').replace(',', '.'));
    text = s.valor.replace(m[0], nf(target * easeOut(age / 1.2), dec));
  }
  const pop = backOut(age / 0.7);
  const hasExtras = s.extras?.length;
  const cy = hasExtras ? 420 : 470;
  g.save();
  g.translate(W / 2, cy); g.scale(0.85 + 0.15 * pop, 0.85 + 0.15 * pop);
  g.globalAlpha = clamp(pop);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = font(220, 600); g.fillStyle = color;
  g.fillText(text, 0, 0);
  g.restore();
  g.globalAlpha = easeOut((age - 0.4) / 0.7);
  g.textAlign = 'center';
  g.font = font(54, 500); g.fillStyle = C.text;
  g.fillText(s.rotulo ?? '', W / 2, cy + 100);
  if (s.nota) { g.font = font(30, 400); g.fillStyle = C.dim; g.fillText(s.nota, W / 2, cy + 156); }
  g.globalAlpha = 1;

  // números menores embaixo
  const ex = s.extras ?? [];
  const cw = 420, gap = 40, total = ex.length * cw + (ex.length - 1) * gap;
  ex.forEach((e, k) => {
    const r = backOut((t - (P.since[i].get(`x${e.valor}`) ?? 0) - k * 0.2) / 0.6);
    if (r <= 0) return;
    const x = W / 2 - total / 2 + k * (cw + gap), y = 650;
    g.save(); g.globalAlpha = clamp(r); g.translate(x + cw / 2, y + 80); g.scale(0.9 + 0.1 * r, 0.9 + 0.1 * r); g.translate(-(x + cw / 2), -(y + 80));
    roundRect(g, x, y, cw, 160, 22); g.fillStyle = C.card; g.fill(); g.strokeStyle = C.cardLine; g.lineWidth = 2; g.stroke();
    g.textAlign = 'center';
    g.font = font(64, 600); g.fillStyle = e.valor.startsWith('−') ? C.down : C.text;
    g.fillText(e.valor, x + cw / 2, y + 82);
    g.font = font(30, 500); g.fillStyle = C.muted;
    g.fillText(e.rotulo, x + cw / 2, y + 130);
    g.restore();
  });
}

function drawFoto(g, P, i, t, s) {
  const start = P.falas[P.sceneStart[i]].t0 - LEAD;
  const age = t - start;
  let end = start + 8;
  for (let k = i; k < P.falas.length && P.sceneStart[k] === P.sceneStart[i]; k++) end = P.falas[k].t1;
  const kb = clamp(age / Math.max(4, end - start));
  const im = P.imgs[s.foto];
  const portrait = im?.naturalHeight > im?.naturalWidth;
  if (im?.complete && im.naturalWidth) {
    g.save();
    if (portrait) {
      // retrato: na direita, sumindo para o fundo na esquerda
      const bx = 900, bw = W - bx, sc = Math.max(bw / im.naturalWidth, H / im.naturalHeight) * (1.04 + 0.08 * kb);
      const w = im.naturalWidth * sc, h = im.naturalHeight * sc;
      g.beginPath(); g.rect(bx, 0, bw, H); g.clip();
      g.drawImage(im, bx + (bw - w) / 2, (H - h) / 2 - 30 * kb, w, h);
      const gr = g.createLinearGradient(bx, 0, bx + 420, 0);
      gr.addColorStop(0, C.bg); gr.addColorStop(1, 'rgba(5,5,6,0)');
      g.fillStyle = gr; g.fillRect(bx, 0, 420, H);
    } else {
      const sc = Math.max(W / im.naturalWidth, H / im.naturalHeight) * (1.06 + 0.1 * kb);
      const w = im.naturalWidth * sc, h = im.naturalHeight * sc;
      g.drawImage(im, (W - w) / 2 - 40 * kb, (H - h) / 2, w, h);
      const gr = g.createLinearGradient(0, H * 0.2, 0, H);
      gr.addColorStop(0, 'rgba(5,5,6,.1)'); gr.addColorStop(0.55, 'rgba(5,5,6,.75)'); gr.addColorStop(1, 'rgba(5,5,6,.96)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      const gl = g.createLinearGradient(0, 0, W * 0.6, 0);
      gl.addColorStop(0, 'rgba(5,5,6,.6)'); gl.addColorStop(1, 'rgba(5,5,6,0)');
      g.fillStyle = gl; g.fillRect(0, 0, W, H);
    }
    g.restore();
  }
  const a = easeOut((age - 0.2) / 0.8);
  g.globalAlpha = a;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  const tx = 120, ty = portrait ? 470 : 760;
  g.fillStyle = C.btc; g.fillRect(tx, ty - 130 - 20 * (1 - a), 90, 6);
  g.font = font(110, 400, SERIF); g.fillStyle = C.text;
  g.fillText(s.nome ?? '', tx, ty + 20 * (1 - a));
  g.font = font(44, 400); g.fillStyle = C.muted;
  g.fillText(s.legenda ?? '', tx, ty + 76);
  g.font = font(22, 400); g.fillStyle = 'rgba(255,255,255,.45)';
  g.textAlign = 'right';
  g.fillText(s.credito ?? '', W - 40, 150);
  g.globalAlpha = 1;
}

function drawMedidor(g, P, i, t, s) {
  const age = t - (P.falas[P.sceneStart[i]].t0 - LEAD);
  const cx = W / 2, cy = 620, R = 330, th = 50;
  g.globalAlpha = easeOut(age / 0.6);
  g.textAlign = 'center';
  g.font = font(52, 500); g.fillStyle = C.text;
  g.fillText(s.rotulo ?? '', cx, 230);
  const segs = [[0, 25, '#f23645', 'Medo extremo'], [25, 45, '#ff7043', 'Medo'], [45, 55, '#fdd835', 'Neutro'], [55, 75, '#9ccc65', 'Ganância'], [75, 100, '#089981', 'Ganância extrema']];
  const ang = v => Math.PI + (v / 100) * Math.PI;
  for (const [a, b, col] of segs) {
    g.strokeStyle = col; g.lineWidth = th; g.lineCap = 'butt';
    g.beginPath(); g.arc(cx, cy, R, ang(a) + 0.012, ang(b) - 0.012); g.stroke();
  }
  g.font = font(26, 500); g.fillStyle = C.dim;
  g.fillText('0', cx - R, cy + 50); g.fillText('100', cx + R, cy + 50);
  const v = lerp(s.antes ?? 50, s.valor, easeInOut((age - 0.5) / 1.8));
  const an = ang(v);
  g.strokeStyle = '#fff'; g.lineWidth = 10; g.lineCap = 'round';
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(an) * (R - 70), cy + Math.sin(an) * (R - 70)); g.stroke();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 22, 0, Math.PI * 2); g.fill();
  const seg = segs.find(([a, b]) => v >= a && v <= b) ?? segs[0];
  g.font = font(120, 600); g.fillStyle = seg[2];
  g.textAlign = 'right';
  g.fillText(nf(Math.round(v)), cx - 20, cy + 160);
  g.textAlign = 'left';
  g.font = font(48, 600);
  g.fillText(seg[3], cx + 20, cy + 124);
  g.font = font(30, 400); g.fillStyle = C.muted;
  g.fillText(`ontem: ${s.antes ?? '–'}`, cx + 20, cy + 164);
  g.textAlign = 'center';
  g.globalAlpha = 1; g.lineCap = 'butt';
}

function drawBarras(g, P, i, t, s) {
  const age = t - (P.falas[P.sceneStart[i]].t0 - LEAD);
  g.globalAlpha = easeOut(age / 0.6);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = font(56, 400, SERIF); g.fillStyle = C.text;
  g.fillText(s.titulo ?? '', 160, 250);
  g.font = font(26, 400); g.fillStyle = C.dim;
  g.fillText(s.fonte ? `Fonte: ${s.fonte}` : '', 160, 300);
  g.globalAlpha = 1;
  const bx = 480, bwMax = 1180;
  (s.itens ?? []).forEach((it, k) => {
    const y = 380 + k * 160;
    const r = easeOut((age - 0.4 - k * 0.25) / 1.1);
    g.globalAlpha = clamp(r * 3);
    g.font = font(54, 500); g.fillStyle = C.text; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(it.rotulo, 160, y + 50);
    roundRect(g, bx, y, bwMax, 100, 18); g.fillStyle = 'rgba(255,255,255,.05)'; g.fill();
    const w = Math.max(18, bwMax * (it.valor / 100) * r);
    roundRect(g, bx, y, w, 100, 18);
    g.fillStyle = it.cor === 'down' ? C.down : it.cor === 'up' ? C.up : '#5b5b63'; g.fill();
    g.font = font(54, 600); g.fillStyle = C.text;
    g.fillText(`${nf(Math.round(it.valor * r))}%`, bx + w + 24, y + 52);
    g.globalAlpha = 1;
  });
  g.textBaseline = 'alphabetic';
}

function drawRegras(g, P, i, t, s) {
  const age = t - (P.falas[P.sceneStart[i]].t0 - LEAD);
  const sinceFala = t - (P.falas[i].t0 - LEAD);
  g.globalAlpha = easeOut(age / 0.6);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = font(64, 400, SERIF); g.fillStyle = C.text;
  g.fillText('O que dizem as regras agora', 120, 220);
  g.font = font(28, 400); g.fillStyle = C.dim;
  g.fillText('Cada regra decide no fechamento do dia (21h de Brasília). Teste todas no simulador.', 120, 270);
  g.globalAlpha = 1;
  const ids = s.ids ?? [];
  const prevS = i > 0 && P.sceneStart[i] !== i ? P.states[i - 1] : null;
  const dimOf = st => id => (!st?.destaque?.length || st.destaque.includes(id) ? 1 : 0.3);
  ids.forEach((id, k) => {
    const col = k % 2, row = Math.floor(k / 2);
    const x = 120 + col * 860, y = 320 + row * 180, w = 820, h = 150;
    const r = backOut((age - 0.3 - k * 0.15) / 0.6);
    if (r <= 0) return;
    const sim = P.sim(id);
    const lastTr = sim.trades.at(-1);
    const on = sim.pos === 1;
    const dimv = lerp(prevS ? dimOf(prevS)(id) : dimOf(s)(id), dimOf(s)(id), easeOut(sinceFala / 0.6));
    g.save();
    g.globalAlpha = clamp(r) * dimv;
    g.translate(x + w / 2, y + h / 2); g.scale(0.92 + 0.08 * r, 0.92 + 0.08 * r); g.translate(-(x + w / 2), -(y + h / 2));
    roundRect(g, x, y, w, h, 24); g.fillStyle = C.card; g.fill();
    g.strokeStyle = dimv > 0.9 && s.destaque?.includes(id) ? (on ? C.up : C.down) : C.cardLine; g.lineWidth = 3; g.stroke();
    g.font = font(44, 500); g.fillStyle = C.text; g.textBaseline = 'alphabetic';
    g.fillText(RULES[id] ?? id, x + 36, y + 66);
    const when = lastTr ? fmtDay(P.bars[lastTr.i].t) : '';
    const desc = on ? `Comprada desde ${when}` : `Fora, em dólar, desde ${when}`;
    pill(g, x + 36, y + 110, desc, { bg: on ? C.up : C.down, size: 26, h: 44 });
    if (lastTr) {
      g.font = font(28, 400); g.fillStyle = C.muted; g.textAlign = 'right';
      g.fillText(`${on ? 'comprou' : 'vendeu'} a ${usdK(lastTr.price)}`, x + w - 36, y + 112);
      g.textAlign = 'left';
    }
    g.restore();
  });
}

function drawAgenda(g, P, i, t, s) {
  const age = t - (P.falas[P.sceneStart[i]].t0 - LEAD);
  g.globalAlpha = easeOut(age / 0.6);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = font(96, 400, SERIF); g.fillStyle = C.text;
  g.fillText(s.titulo ?? 'De olho', 160, 250);
  g.globalAlpha = 1;
  // quando cada item apareceu: a primeira fala em que `ate` passou dele
  (s.itens ?? []).forEach((it, k) => {
    let from = null;
    for (let j = P.sceneStart[i]; j <= i; j++) if ((P.states[j].ate ?? 0) > k) { from = P.falas[j].t0 - LEAD; break; }
    const r = from == null ? 0 : easeOut((t - from) / 0.7);
    const active = (s.ate ?? 0) - 1 === k;
    const y = 330 + k * 175;
    g.globalAlpha = 0.16 + 0.84 * r * (active ? 1 : 0.6);
    const dx = 60 * (1 - r);
    roundRect(g, 160 + dx, y, 1600, 140, 26);
    g.fillStyle = active ? 'rgba(247,147,26,.10)' : C.card; g.fill();
    g.strokeStyle = active ? C.btc : C.cardLine; g.lineWidth = active ? 3 : 2; g.stroke();
    g.font = font(40, 600); g.fillStyle = C.btc;
    g.fillText(`${k + 1}`, 210 + dx, y + 86);
    g.font = font(30, 600); g.fillStyle = C.muted;
    g.fillText(it.quando.toUpperCase(), 290 + dx, y + 56);
    g.font = font(44, 500); g.fillStyle = C.text;
    g.fillText(it.texto, 290 + dx, y + 106);
    g.globalAlpha = 1;
  });
}

function drawFim(g, P, i, t, s) {
  const age = t - (P.falas[P.sceneStart[i]].t0 - LEAD);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.globalAlpha = easeOut(age / 0.9);
  g.fillStyle = C.btc; g.beginPath(); g.arc(W / 2, 300, 16, 0, Math.PI * 2); g.fill();
  g.font = font(150, 400, SERIF); g.fillStyle = C.text;
  g.fillText(s.titulo ?? 'justhold.ai', W / 2, 480);
  g.globalAlpha = easeOut((age - 0.5) / 0.9);
  g.font = font(46, 400); g.fillStyle = C.muted;
  wrap(g, s.sub ?? '', 1500).forEach((l, k) => g.fillText(l, W / 2, 570 + k * 60));
  g.globalAlpha = easeOut((age - 1) / 0.9);
  g.font = font(30, 400); g.fillStyle = C.dim;
  g.fillText(s.aviso ?? '', W / 2, 760);
  g.globalAlpha = 1;
}

const SCENES = { grafico: drawChart, capa: drawCapa, numero: drawNumero, foto: drawFoto, medidor: drawMedidor, barras: drawBarras, regras: drawRegras, agenda: drawAgenda, fim: drawFim };

function drawHeader(g, P, s) {
  if (s.tipo === 'capa' || s.tipo === 'fim') return;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.fillStyle = C.btc; g.beginPath(); g.arc(70, 72, 9, 0, Math.PI * 2); g.fill();
  g.font = font(38, 400, SERIF); g.fillStyle = C.text;
  g.fillText('JustHold', 92, 84);
  const w = g.measureText('JustHold').width;
  g.font = font(26, 400); g.fillStyle = C.muted;
  g.fillText(`·  ${P.video.rotulo ?? ''}`, 92 + w + 16, 82);
  if (s.tipo === 'foto') return;
  const n = P.bars.length, last = P.bars[n - 1], prev = P.bars[n - 2];
  const ch = (last.c / prev.c - 1) * 100;
  g.textAlign = 'right';
  g.font = font(34, 600); g.fillStyle = C.text;
  g.fillText(`BTC  US$ ${nf(last.c)}`, W - 300, 84);
  pill(g, W - 60, 72, `hoje ${ch >= 0 ? '+' : '−'}${nf(Math.abs(ch), 1)}%`, { bg: ch >= 0 ? C.up : C.down, size: 26, align: 'right', h: 42 });
}

function drawCaption(g, P, t) {
  let cur = null;
  for (const caps of P.captions) for (const c of caps) if (t >= c.a - 0.05 && t < c.b + 0.25) cur = c;
  if (!cur) return;
  g.font = font(46, 600);
  g.textBaseline = 'middle'; g.textAlign = 'left';
  // quebra em até 2 linhas, mantendo as palavras com o tempo de cada uma
  const lines = [[]];
  let lw = 0;
  const space = g.measureText(' ').width;
  for (const wd of cur.words) {
    const ww = g.measureText(wd.w).width;
    if (lw + ww > 1500 && lines.at(-1).length) { lines.push([]); lw = 0; }
    lines.at(-1).push({ ...wd, ww });
    lw += ww + space;
  }
  const lh = 64, boxH = lines.length * lh + 30, by = 1044 - boxH / 2;
  const widths = lines.map(l => l.reduce((s, w) => s + w.ww + space, -space));
  const boxW = Math.max(...widths) + 60;
  roundRect(g, W / 2 - boxW / 2, by - boxH / 2, boxW, boxH, 18);
  g.fillStyle = 'rgba(0,0,0,.72)'; g.fill();
  lines.forEach((l, k) => {
    let x = W / 2 - widths[k] / 2;
    const y = by - ((lines.length - 1) * lh) / 2 + k * lh;
    for (const wd of l) {
      g.fillStyle = t >= wd.s ? '#fff' : 'rgba(255,255,255,.55)';
      g.fillText(wd.w, x, y);
      x += wd.ww + space;
    }
  });
}

function makeRenderer(canvas, P) {
  const g = canvas.getContext('2d');
  const dur = P.video.dur;
  const visualAt = t => {
    let i = 0;
    for (let k = 0; k < P.falas.length; k++) if (t >= P.falas[k].t0 - LEAD) i = k;
    return i;
  };
  // na troca de cena, cada uma é desenhada numa camada à parte e as duas se misturam
  const layers = [0, 1].map(() => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; });
  const drawScene = (ctx, k, t) => {
    ctx.save();
    SCENES[P.states[k].tipo]?.(ctx, P, k, t, P.states[k]);
    ctx.restore();
    ctx.globalAlpha = 1;
  };
  const drawLayer = (cv, k, t) => {
    const lg = cv.getContext('2d');
    lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalAlpha = 1; lg.clearRect(0, 0, W, H);
    drawScene(lg, k, t);
    return cv;
  };
  return t => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    const i = visualAt(t);
    const s = P.states[i];
    const change = i > 0 && P.sceneStart[i] === i;
    const p = change ? easeInOut((t - (P.falas[i].t0 - LEAD)) / FADE) : 1;
    if (p < 1) {
      g.globalAlpha = 1 - p;
      g.drawImage(drawLayer(layers[0], i - 1, t), 0, 0);
      // a cena nova entra com um leve zoom
      const z = 1.03 - 0.03 * p;
      g.save();
      g.globalAlpha = p;
      g.translate(W / 2, H / 2); g.scale(z, z); g.translate(-W / 2, -H / 2);
      g.drawImage(drawLayer(layers[1], i, t), 0, 0);
      g.restore();
    } else drawScene(g, i, t);
    g.globalAlpha = 1;
    drawHeader(g, P, s);
    drawCaption(g, P, t);
    // barra de progresso
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, H - 6, W, 6);
    g.fillStyle = C.btc; g.fillRect(0, H - 6, W * clamp(t / dur), 6);
  };
}

// ---------- player ----------
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a.8.8 0 0 0 1.2.7l10.4-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>',
  full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

export async function mountVideo(el, video, { src }) {
  await Promise.all(['400 40px Newsreader', '400 40px Inter', '500 40px Inter', '600 40px Inter'].map(f => document.fonts.load(f).catch(() => {})));
  const P = prepare(video);
  await Promise.all(Object.values(P.imgs).map(im => (im.decode ? im.decode().catch(() => {}) : null)));

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const render = makeRenderer(canvas, P);
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = src;

  const big = document.createElement('button');
  big.type = 'button'; big.className = 'vp-big'; big.innerHTML = ICON.play; big.setAttribute('aria-label', 'Assistir');
  const bar = document.createElement('div'); bar.className = 'vp-bar';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'vp-btn'; btn.innerHTML = ICON.play; btn.setAttribute('aria-label', 'Tocar');
  const time = document.createElement('span'); time.className = 'vp-time';
  const seek = document.createElement('input'); seek.type = 'range'; seek.min = 0; seek.max = video.dur; seek.step = 0.1; seek.value = 0; seek.className = 'vp-seek'; seek.setAttribute('aria-label', 'Posição do vídeo');
  const full = document.createElement('button'); full.type = 'button'; full.className = 'vp-btn'; full.innerHTML = ICON.full; full.setAttribute('aria-label', 'Tela cheia');
  bar.append(btn, time, seek, full);
  el.classList.add('vplayer');
  el.replaceChildren(canvas, big, bar);

  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // o currentTime do áudio anda aos saltos em alguns navegadores: entre um salto e outro, o
  // relógio do quadro avança sozinho
  let baseA = 0, baseP = 0, raf = 0, lastT = -1;
  const now = () => {
    if (audio.paused) return audio.currentTime;
    const p = performance.now();
    if (audio.currentTime !== baseA) { baseA = audio.currentTime; baseP = p; }
    return Math.min(baseA + (p - baseP) / 1000, baseA + 0.35);
  };
  const frame = () => {
    const t = now();
    if (Math.abs(t - lastT) > 1e-4) { render(t); lastT = t; }
    time.textContent = `${mmss(t)} / ${mmss(video.dur)}`;
    if (document.activeElement !== seek) seek.value = t;
    if (!audio.paused) raf = requestAnimationFrame(frame);
  };
  const sync = () => {
    const playing = !audio.paused;
    btn.innerHTML = playing ? ICON.pause : ICON.play;
    btn.setAttribute('aria-label', playing ? 'Pausar' : 'Tocar');
    el.classList.toggle('playing', playing);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  };
  const toggle = () => (audio.paused ? audio.play().catch(e => console.error(e)) : audio.pause());
  audio.addEventListener('play', sync);
  audio.addEventListener('pause', sync);
  audio.addEventListener('seeked', () => { baseA = -1; sync(); });
  audio.addEventListener('waiting', () => el.classList.add('loading'));
  audio.addEventListener('playing', () => el.classList.remove('loading'));
  audio.addEventListener('ended', () => { el.classList.add('ended'); });
  big.onclick = btn.onclick = toggle;
  canvas.onclick = toggle;
  seek.oninput = () => { audio.currentTime = Number(seek.value); render(Number(seek.value)); };
  full.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.());
  const onKey = e => {
    if (e.target.closest?.('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    if (e.code === 'ArrowRight') audio.currentTime = Math.min(video.dur, audio.currentTime + 5);
    if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  };
  addEventListener('keydown', onKey);

  render(0.01);
  time.textContent = `0:00 / ${mmss(video.dur)}`;
  return {
    render, dur: video.dur,
    play: () => audio.play().catch(e => console.error(e)),
    pause: () => audio.pause(),
    destroy() { audio.pause(); audio.src = ''; cancelAnimationFrame(raf); removeEventListener('keydown', onKey); },
  };
}
