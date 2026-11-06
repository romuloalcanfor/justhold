// Áudio das análises com voz natural, pela API de voz da xAI (Grok), gerado SÓ QUANDO ALGUÉM PEDE:
// a primeira pessoa que aperta "Ouvir" numa análise faz o Worker gerar o MP3 (uns 10 segundos)
// e guardar no R2; todo mundo depois recebe o arquivo guardado, sem gastar de novo. Se ninguém
// ouvir, não se gasta nada. Duas pessoas ao mesmo tempo: a trava na tabela audio_jobs deixa só
// uma chamar o Grok, e a outra espera o arquivo ficar pronto.
// Custo: cerca de US$ 15 por milhão de caracteres (uma análise tem uns 3 mil por idioma).

const TTS = 'https://api.x.ai/v1/tts';
export const DEFAULT_VOICE = 'rex'; // escolhida pelo dono entre ara, eve, leo e rex (a clonagem não está liberada no Brasil)
const MAX_CHARS = 14000; // a API aceita até 15 mil por pedido
const LOCK_MS = 3 * 60 * 1000; // trava velha (geração que caiu no meio) pode ser retomada
const WAIT_MS = 90 * 1000; // quanto quem chegou junto espera pelo arquivo

// O mesmo roteiro que a home mostra: título, resumo e as três partes.
export function speechText(text, lang) {
  const h = lang === 'pt' ? ['Mercado.', 'Gráfico.', 'De olho.'] : ['Market.', 'Chart.', 'What to watch.'];
  return [
    `${text.titulo}.`, text.resumo,
    h[0], ...text.mercado,
    h[1], ...text.grafico,
    h[2], ...text.de_olho,
  ].join(' ').replace(/\s+/g, ' ').slice(0, MAX_CHARS);
}

// a voz entra no nome do arquivo: trocar de voz faz cada análise ser regerada no próximo clique
export const voiceName = env => env.XAI_VOICE || DEFAULT_VOICE;
const audioKey = (id, lang, voice) => `analises/${id}-${lang}-${voice}.mp3`;
export const voiceEnabled = env => !!(env.XAI_API_KEY && env.AUDIO);

// MP3 de um texto com a voz do Grok.
export async function synthesize(apiKey, text, lang, voice = DEFAULT_VOICE) {
  const res = await fetch(TTS, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, language: lang }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

// GET /api/analise/audio/<id>-<pt|en>.mp3
export async function audioResponse(env, request, id, lang) {
  if (!voiceEnabled(env) || !/^\d{4}-\d{2}-\d{2}-(manha|tarde|fechamento)$/.test(id) || !['pt', 'en'].includes(lang)) {
    return notFound();
  }
  const voice = voiceName(env);
  const key = audioKey(id, lang, voice);
  // já gerado por alguém: só entrega
  if (await env.AUDIO.head(key)) return serve(env, request, key);

  // ainda não: só gera para análise que existe (ninguém faz o site gastar com endereço inventado)
  const row = await env.DB.prepare('SELECT data FROM analyses WHERE id = ?').bind(id).first();
  const text = row && JSON.parse(row.data)[lang];
  if (!text) return notFound();

  const now = Date.now();
  // reserva a vez: só entra quem conseguir gravar a trava (ou retomar uma trava velha)
  const claim = await env.DB.prepare(
    `INSERT INTO audio_jobs (key, started_at) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET started_at = excluded.started_at WHERE audio_jobs.started_at < ?`,
  ).bind(key, now, now - LOCK_MS).run();

  if (claim.meta.changes > 0) {
    try {
      const mp3 = await synthesize(env.XAI_API_KEY, speechText(text, lang), lang, voice);
      await env.AUDIO.put(key, mp3, { httpMetadata: { contentType: 'audio/mpeg' } });
      console.log(`voz gerada (Grok): ${key}, ${mp3.length} bytes`);
    } catch (e) {
      // libera a vez para a próxima pessoa tentar
      await env.DB.prepare('DELETE FROM audio_jobs WHERE key = ?').bind(key).run();
      console.error('voz', e);
      return new Response('Não deu para gerar a voz agora.', { status: 503, headers: { 'retry-after': '30' } });
    }
    return serve(env, request, key);
  }

  // outra pessoa está gerando agora: espera o arquivo aparecer
  for (let waited = 0; waited < WAIT_MS; waited += 1500) {
    await new Promise(r => setTimeout(r, 1500));
    if (await env.AUDIO.head(key)) return serve(env, request, key);
  }
  return new Response('A voz ainda está sendo preparada.', { status: 503, headers: { 'retry-after': '10' } });
}

const notFound = () => new Response('Não encontrado.', { status: 404 });

// Entrega o MP3 com suporte a Range (o Safari só toca áudio assim).
async function serve(env, request, key) {
  const range = request.headers.get('range');
  const obj = await env.AUDIO.get(key, range ? { range: request.headers } : undefined);
  if (!obj) return notFound();
  const headers = new Headers({
    'content-type': 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
    etag: obj.httpEtag,
  });
  if (range && obj.range) {
    const r = obj.range;
    const offset = r.suffix != null ? obj.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix != null ? r.suffix : (r.length ?? obj.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}
