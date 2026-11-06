// Vídeo da análise do mercado: o nosso gráfico animado, narrado pelo Rex (voz do Grok), com
// legenda. Quem escreve o roteiro é o Claude, na conversa do Claude Code, junto com a análise.
//
//   node scripts/video.mjs publicar roteiro.json --id 2026-11-06-manha [--remote | --persist-to DIR]
//
// O roteiro é uma lista de falas. Cada fala é uma frase ou duas da narração e, quando a imagem
// muda, o que mostrar (`v`). Uma fala sem `v` continua com a imagem da anterior; uma `v` do mesmo
// tipo da anterior só muda o que ela diz (o resto continua):
//
//   { "titulo": "...", "rotulo": "Análise da manhã · 6 de novembro",
//     "falas": [ { "texto": "Bom dia! ...", "v": { "tipo": "capa", "titulo": "...", "sub": "..." } },
//                { "texto": "...", "v": { "tipo": "grafico", "dias": 60, "medias": [50, 110] } } ] }
//
// Os tipos de imagem e o que cada um aceita estão em public/js/video.js.
//
// O script gera a voz de cada fala (guardada em .wrangler/video-tts, para não pagar duas vezes o
// mesmo texto), junta tudo num MP3 com o ffmpeg, mede onde cada fala começa e termina (é isso que
// sincroniza o gráfico e a legenda com a voz), envia o MP3 para o R2 e grava o roteiro, os tempos
// e os candles do gráfico dentro da análise (data.video.<língua>).

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { synthesize, DEFAULT_VOICE } from '../src/voz.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = name => {
  const i = rest.indexOf(name);
  return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true;
};

const VOICE = process.env.XAI_VOICE || DEFAULT_VOICE;
const CACHE = '.wrangler/video-tts';
const OUT = '.wrangler/video-out';
// pausas, em segundos
const LEAD = 0.5, GAP = 0.25, SCENE_GAP = 0.6, TAIL = 1.6;
const RATE = 24000;

const sh = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const exists = p => access(p).then(() => true, () => false);

async function apiKey() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  const vars = await readFile('.dev.vars', 'utf8').catch(() => '');
  const m = vars.match(/^XAI_API_KEY=(.+)$/m);
  if (!m) throw new Error('Falta XAI_API_KEY no .dev.vars');
  return m[1].trim();
}

const duration = file => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));

// candles diários do BTC (os últimos 420 dias), no formato compacto [t, o, h, l, c, fechado]
async function bars() {
  for (const base of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const res = await fetch(`${base}/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=420`);
      if (!res.ok) continue;
      const now = Date.now();
      return (await res.json()).map(k => [k[0], Math.round(+k[1]), Math.round(+k[2]), Math.round(+k[3]), Math.round(+k[4]), k[6] < now ? 1 : 0]);
    } catch { /* tenta o próximo */ }
  }
  throw new Error('Binance fora do ar');
}

async function publicar() {
  const file = rest.find(a => !a.startsWith('--') && ![flag('--id'), flag('--persist-to'), flag('--lang')].includes(a));
  const id = flag('--id');
  const lang = flag('--lang') ?? 'pt';
  if (!file || typeof id !== 'string') throw new Error('Uso: node scripts/video.mjs publicar roteiro.json --id AAAA-MM-DD-slot');
  if (!/^\d{4}-\d{2}-\d{2}-(manha|tarde|fechamento)$/.test(id)) throw new Error('id inválido');
  const remote = flag('--remote') === true;
  const persist = flag('--persist-to');
  const where = remote ? ['--remote'] : ['--local', ...(persist ? ['--persist-to', persist] : [])];
  const wrangler = (...args) => sh('npx', ['wrangler', ...args, ...where]);

  // a análise precisa existir antes (o vídeo fica dentro dela)
  const found = wrangler('d1', 'execute', 'justhold', '--json', '--command', `SELECT id FROM analyses WHERE id = '${id}'`);
  if (!found.includes(`"${id}"`)) throw new Error(`Análise ${id} não encontrada ${remote ? 'no site' : 'no preview'}. Publique a análise primeiro.`);

  const roteiro = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(roteiro.falas) || !roteiro.falas.length || roteiro.falas.some(f => typeof f.texto !== 'string' || !f.texto.trim())) {
    throw new Error('Roteiro sem falas');
  }
  if (!roteiro.falas[0].v) throw new Error('A primeira fala precisa dizer o que mostrar (v)');

  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  const key = await apiKey();

  // 1. voz de cada fala (só gera o que ainda não está no cache), sem o silêncio das pontas
  const clips = [];
  let paid = 0;
  for (const [i, f] of roteiro.falas.entries()) {
    const hash = createHash('sha1').update(`${VOICE}|${lang}|${f.texto.trim()}`).digest('hex').slice(0, 16);
    const mp3 = join(CACHE, `${hash}.mp3`), wav = join(CACHE, `${hash}.wav`);
    if (!(await exists(mp3))) {
      process.stdout.write(`voz ${i + 1}/${roteiro.falas.length}… `);
      await writeFile(mp3, await synthesize(key, f.texto.trim(), lang, VOICE));
      paid += f.texto.trim().length;
    }
    if (!(await exists(wav))) {
      const trim = 'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse';
      sh('ffmpeg', ['-y', '-v', 'error', '-i', mp3, '-af', trim, '-ar', String(RATE), '-ac', '1', wav]);
    }
    clips.push(wav);
  }
  if (paid) console.log(`\n${paid} caracteres de voz gerados (≈ US$ ${(paid * 15 / 1e6).toFixed(3)})`);

  // 2. junta com as pausas e mede onde cada fala começa e termina
  const silence = async s => {
    const f = join(CACHE, `silencio-${Math.round(s * 1000)}.wav`);
    if (!(await exists(f))) sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${RATE}:cl=mono`, '-t', String(s), f]);
    return f;
  };
  const list = [];
  const falas = [];
  let t = 0, tipo = null;
  const pause = async s => { list.push(await silence(s)); t += s; };
  await pause(LEAD);
  for (const [i, f] of roteiro.falas.entries()) {
    const next = f.v?.tipo ?? tipo;
    if (i) await pause(next !== tipo ? SCENE_GAP : GAP);
    tipo = next;
    const d = duration(clips[i]);
    falas.push({ t0: +t.toFixed(3), t1: +(t + d).toFixed(3), texto: f.texto.trim(), ...(f.v ? { v: f.v } : {}) });
    list.push(clips[i]);
    t += d;
  }
  await pause(TAIL);

  const listFile = join(OUT, `${id}-${lang}.txt`);
  await writeFile(listFile, list.map(f => `file '${join(process.cwd(), f)}'`).join('\n'));
  const out = join(OUT, `${id}-${lang}.mp3`);
  sh('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '96k', '-ac', '1', out]);
  const dur = duration(out);

  // 3. envia a voz e grava o roteiro dentro da análise
  wrangler('r2', 'object', 'put', `justhold-audio/videos/${id}-${lang}.mp3`, '--file', out, '--content-type', 'audio/mpeg');
  const video = { v: Date.now(), voz: VOICE, dur: +dur.toFixed(2), titulo: roteiro.titulo, rotulo: roteiro.rotulo, bars: await bars(), falas };
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const sql = `UPDATE analyses SET data = json_set(data, '$.video', json_set(COALESCE(json_extract(data, '$.video'), '{}'), '$.${lang}', json(${q(JSON.stringify(video))}))) WHERE id = ${q(id)};`;
  const sqlFile = join(OUT, `${id}-${lang}.sql`);
  await writeFile(sqlFile, sql);
  wrangler('d1', 'execute', 'justhold', '--file', sqlFile);

  const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  console.log(`Vídeo publicado: ${id} (${lang}, ${remote ? 'site no ar' : 'preview local'}) · ${falas.length} falas · ${mmss(dur)} · áudio em ${out}`);
}

const run = { publicar }[cmd];
if (!run) {
  console.error('Uso: node scripts/video.mjs publicar roteiro.json --id AAAA-MM-DD-slot [--lang pt|en] [--remote | --persist-to DIR]');
  process.exit(1);
}
run().catch(e => { console.error(e.message ?? e); process.exit(1); });
