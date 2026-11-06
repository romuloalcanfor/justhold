// Publica a análise do mercado na home do JustHold.
// Quem escreve é o Claude, na conversa do Claude Code, quando o dono pede (com os detalhes da
// dúvida dele). O fluxo:
//
//   1. Números do gráfico, para escrever a análise com eles:
//        node scripts/analise.mjs dados
//      (preço, médias de 20/50/110/200 dias e 50/200 semanas, máximas e mínimas, o que cada regra
//      diz, Fed, medo e ganância, futuros e manchetes)
//
//   2. Escrever um JSON assim (português e inglês, para leigo, sem "compre/venda"):
//        { "pt": { "titulo": "...", "resumo": "...", "mercado": ["..."], "grafico": ["..."], "de_olho": ["..."] },
//          "en": { ...igual... },
//          "fontes": [{ "titulo": "...", "url": "https://..." }] }
//
//   3. Publicar:
//        node scripts/analise.mjs publicar analise.json                  (preview local)
//        node scripts/analise.mjs publicar analise.json --persist-to .wrangler/state-5175
//        node scripts/analise.mjs publicar analise.json --remote         (site no ar)
//      Opcional: --slot manha|tarde|fechamento (sem isso, sai pelo horário de Brasília).
//
// A voz não é gerada aqui: o Worker gera no primeiro clique em "Ouvir" e guarda para os próximos.
// Republicar a mesma análise (mesmo dia e horário) apaga a voz antiga, para ela ser refeita.

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { marketSnapshot, validateAnalysis, brDay } from '../src/analise.js';
import { fetchContext } from '../src/bot.js';
import { DEFAULT_VOICE } from '../src/voz.js';

const VOICE = process.env.XAI_VOICE || DEFAULT_VOICE;

const [cmd, ...rest] = process.argv.slice(2);
const flag = name => {
  const i = rest.indexOf(name);
  return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true;
};
const SLOTS = ['manha', 'tarde', 'fechamento'];

// manhã até 12h, tarde até 21h, depois fechamento (o candle diário fecha às 21h de Brasília)
function slotByClock(now = Date.now()) {
  const h = new Date(now - 3 * 3600e3).getUTCHours();
  return h < 3 ? 'fechamento' : h < 12 ? 'manha' : h < 21 ? 'tarde' : 'fechamento';
}

// Números do gráfico: preço de agora, a não ser no fechamento depois das 21h (aí, o candle que
// acabou de fechar, que é o que as regras usam).
async function snapshotFor(slot, now) {
  const closed = slot === 'fechamento' && slotByClock(now) === 'fechamento';
  const market = await marketSnapshot(closed ? 'fechamento' : 'manha', now);
  market.slot = slot;
  return market;
}

async function dados() {
  const slot = flag('--slot') ?? slotByClock();
  const now = Date.now();
  const [market, ctx] = await Promise.all([snapshotFor(slot, now), fetchContext(now)]);
  const { fedRate, kalshi, polymarket, fearGreed, futures, news } = ctx;
  console.log(JSON.stringify({ slot, market, contexto: { fedRate, kalshi, polymarket, fearGreed, futures, manchetes: news } }, null, 1));
}

async function publicar() {
  const file = rest.find(a => !a.startsWith('--') && a !== flag('--slot') && a !== flag('--persist-to'));
  if (!file) throw new Error('Diga o arquivo: node scripts/analise.mjs publicar analise.json');
  const slot = flag('--slot') ?? slotByClock();
  if (!SLOTS.includes(slot)) throw new Error(`--slot precisa ser ${SLOTS.join(', ')}`);
  const remote = flag('--remote') === true;
  const persist = flag('--persist-to');

  const text = validateAnalysis(JSON.parse(await readFile(file, 'utf8')));
  const now = Date.now();
  const market = await snapshotFor(slot, now);
  // depois da meia-noite, o fechamento ainda é o do dia anterior (21h de Brasília)
  const day = slot === 'fechamento' && new Date(now - 3 * 3600e3).getUTCHours() < 3 ? brDay(now - 864e5) : brDay(now);
  const id = `${day}-${slot}`;
  const data = { ...text, market };

  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const sql = [
    `INSERT INTO analyses (id, slot, day, created_at, data, model, usage) VALUES (${q(id)}, ${q(slot)}, ${q(day)}, ${now}, ${q(JSON.stringify(data))}, 'claude-code', NULL)
     ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, data = excluded.data, model = excluded.model;`,
    // a voz antiga (se houver) era do texto anterior
    `DELETE FROM audio_jobs WHERE key LIKE ${q(`analises/${id}-%`)};`,
  ].join('\n');
  const dir = await mkdtemp(join(tmpdir(), 'jh-analise-'));
  const sqlFile = join(dir, 'analise.sql');
  await writeFile(sqlFile, sql);

  const where = remote ? ['--remote'] : ['--local', ...(persist ? ['--persist-to', persist] : [])];
  const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args, ...where], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  wrangler('d1', 'execute', 'justhold', '--file', sqlFile);
  for (const lang of ['pt', 'en']) {
    try { wrangler('r2', 'object', 'delete', `justhold-audio/analises/${id}-${lang}-${VOICE}.mp3`); } catch { /* não havia voz */ }
  }
  console.log(`Publicada: ${id} (${remote ? 'site no ar' : 'preview local'}) · BTC ${market.price} · "${text.pt.titulo}"`);
}

const run = { dados, publicar }[cmd];
if (!run) {
  console.error('Uso: node scripts/analise.mjs dados | publicar <arquivo.json> [--slot manha|tarde|fechamento] [--remote | --persist-to DIR]');
  process.exit(1);
}
run().catch(e => { console.error(e.message ?? e); process.exit(1); });
