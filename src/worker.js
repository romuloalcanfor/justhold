// API de contas do JustHold: cadastro e login com e-mail e senha, sessão por cookie
// e preferências de cada usuário. O resto do site é servido como arquivos estáticos.
// Também roda o bot simulado (src/bot.js) uma vez por dia, pelo agendamento do wrangler.jsonc,
// e entrega a análise do mercado da home (src/analise.js), publicada por scripts/analise.mjs.
import { runBot, botSummary } from './bot.js';
import { latestAnalysis } from './analise.js';
import { audioResponse, videoAudioResponse, voiceEnabled, voiceName } from './voz.js';

const SESSION_COOKIE = 'jh_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // máximo aceito pelo Workers
const MAX_PREFS_BYTES = 64 * 1024;
const MAX_FAILURES = 8; // por e-mail, a cada 15 minutos
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_DEMO_BYTES = 32 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/dolar' && request.method === 'GET') return await dollarHistory(url, ctx);
      const audio = url.pathname.match(/^\/api\/analise\/audio\/([\w-]+)-(pt|en)\.mp3$/);
      if (audio && request.method === 'GET') return await audioResponse(env, request, audio[1], audio[2]);
      const video = url.pathname.match(/^\/api\/analise\/video\/([\w-]+)-(pt|en)\.mp3$/);
      if (video && request.method === 'GET') return await videoAudioResponse(env, request, video[1], video[2]);
      if (url.pathname === '/api/analise' && request.method === 'GET') {
        // pública: a mesma para todo mundo, fica 2 minutos no cache. `voice`: nome da voz do Grok
        // (o áudio é gerado no primeiro clique em "Ouvir"), ou null se ela não estiver ligada
        return json({ analysis: await latestAnalysis(env), voice: voiceEnabled(env) ? voiceName(env) : null }, 200, { 'cache-control': 'public, max-age=120' });
      }
      return await route(request, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'Erro no servidor. Tente de novo.', code: 'server' }, 500);
    }
  },

  // Logo depois do fechamento do candle diário (00h05 UTC, 21h05 de Brasília).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBot(env).catch(e => console.error('bot', e)));
  },
};

async function route(request, env, url) {
  const { method } = request;
  const path = url.pathname;
  // Só aceitamos JSON nas escritas: junto com o cookie SameSite=Lax, isso bloqueia
  // formulários de outros sites tentando agir em nome do usuário.
  if (method !== 'GET' && !request.headers.get('content-type')?.includes('application/json')) {
    return json({ error: 'Envie JSON.' }, 415);
  }
  if (path === '/api/signup' && method === 'POST') return signup(request, env, url);
  if (path === '/api/login' && method === 'POST') return login(request, env, url);
  if (path === '/api/logout' && method === 'POST') return logout(request, env, url);
  if (path === '/api/me' && method === 'GET') {
    const user = await currentUser(request, env);
    return json({ user: user ? { email: user.email } : null });
  }
  if (path === '/api/prefs') {
    const user = await currentUser(request, env);
    if (!user) return json({ error: 'Não logado.', code: 'notLogged' }, 401);
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT data, updated_at FROM prefs WHERE user_id = ?').bind(user.id).first();
      return json({ prefs: row ? JSON.parse(row.data) : null, updatedAt: row?.updated_at ?? null });
    }
    if (method === 'PUT') return savePrefs(request, env, user);
  }
  if (path === '/api/demo') {
    const user = await currentUser(request, env);
    if (!user) return json({ error: 'Não logado.', code: 'notLogged' }, 401);
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT data, updated_at FROM demo_wallets WHERE user_id = ?').bind(user.id).first();
      return json({ wallets: row ? JSON.parse(row.data) : [], updatedAt: row?.updated_at ?? null });
    }
    if (method === 'PUT') return saveDemo(request, env, user);
  }
  if (path === '/api/bot' || path === '/api/bot/run') {
    const user = await currentUser(request, env);
    if (!user) return json({ error: 'Não logado.', code: 'notLogged' }, 401);
    if (!isBotOwner(env, user)) return json({ error: 'Esta página é só do dono do bot.', code: 'notOwner' }, 403);
    if (path === '/api/bot' && method === 'GET') return json(await botSummary(env));
    if (path === '/api/bot/run' && method === 'POST') {
      await runBot(env);
      return json(await botSummary(env));
    }
  }
  return json({ error: 'Não encontrado.' }, 404);
}

// Donos do bot: e-mails no segredo BOT_OWNERS (separados por vírgula), fora do código público.
function isBotOwner(env, user) {
  const owners = String(env.BOT_OWNERS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return owners.includes(user.email);
}

// ---------- cadastro e login ----------
async function readCredentials(request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  return { email, password };
}

const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function signup(request, env, url) {
  const { email, password } = await readCredentials(request);
  if (!validEmail(email)) return json({ error: 'E-mail inválido.', code: 'badEmail' }, 400);
  if (password.length < 8) return json({ error: 'A senha precisa ter pelo menos 8 caracteres.', code: 'shortPassword' }, 400);
  if (password.length > 200) return json({ error: 'Senha longa demais.', code: 'longPassword' }, 400);
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first();
  if (exists) return json({ error: 'Já existe uma conta com esse e-mail. Entre com ela.', code: 'exists' }, 409);
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const user = await env.DB.prepare('INSERT INTO users (email, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(email, hash, salt, Date.now()).first();
  return startSession(env, url, user.id, { email }, 201);
}

async function login(request, env, url) {
  const { email, password } = await readCredentials(request);
  const since = Date.now() - FAILURE_WINDOW_MS;
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(email, since).first();
  if (fails.n >= MAX_FAILURES) return json({ error: 'Muitas tentativas. Espere 15 minutos e tente de novo.', code: 'tooMany' }, 429);

  const user = await env.DB.prepare('SELECT id, pass_hash, pass_salt FROM users WHERE email = ?').bind(email).first();
  // Mesmo sem usuário calculamos um hash, para a resposta não revelar quais e-mails têm conta.
  const hash = await hashPassword(password, user?.pass_salt ?? '00'.repeat(16));
  if (!user || !timingSafeEqual(hash, user.pass_hash)) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, Date.now()),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(since),
    ]);
    return json({ error: 'E-mail ou senha incorretos.', code: 'wrong' }, 401);
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(email).run();
  return startSession(env, url, user.id, { email });
}

async function logout(request, env, url) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(url, '', 0) });
}

async function startSession(env, url, userId, body, status = 200) {
  const token = randomHex(32);
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, Date.now() + maxAge * 1000),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
  ]);
  return json(body, status, { 'set-cookie': sessionCookie(url, token, maxAge) });
}

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
  ).bind(await sha256(token), Date.now()).first();
}

// ---------- preferências ----------
async function savePrefs(request, env, user) {
  const text = await request.text();
  if (text.length > MAX_PREFS_BYTES) return json({ error: 'Preferências grandes demais.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'JSON inválido.' }, 400); }
  if (!body || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) return json({ error: 'Formato inválido.' }, 400);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO prefs (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  ).bind(user.id, JSON.stringify(body.prefs), now).run();
  return json({ ok: true, updatedAt: now });
}

// ---------- carteiras demo ----------
// A página /demo/ manda a lista inteira; aqui só conferimos tamanho e formato básico.
async function saveDemo(request, env, user) {
  const text = await request.text();
  if (text.length > MAX_DEMO_BYTES) return json({ error: 'Carteiras demais.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const wallets = body?.wallets;
  if (!Array.isArray(wallets) || wallets.length > 30 || !wallets.every(w => w && typeof w === 'object' && typeof w.id === 'string')) {
    return json({ error: 'Formato inválido.' }, 400);
  }
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO demo_wallets (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  ).bind(user.id, JSON.stringify(wallets), now).run();
  return json({ ok: true, updatedAt: now });
}

// ---------- cotação do dólar (simulador em reais) ----------
// PTAX de venda do Banco Central desde 2017, como [["AAAA-MM-DD", 5.12], ...]. Fica 6 horas no
// cache da Cloudflare, para não bater no BCB a cada visita. O BCB aceita no máximo 10 anos por
// consulta, então busca em blocos de 5.
async function dollarHistory(url, ctx) {
  const cache = caches.default;
  const key = new Request(`${url.origin}/api/dolar`);
  const hit = await cache.match(key);
  if (hit) return hit;
  const br = d => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const now = new Date();
  const out = [];
  for (let y = 2017; y <= now.getUTCFullYear(); y += 5) {
    const from = new Date(Date.UTC(y, 0, 1));
    const to = new Date(Math.min(Date.UTC(y + 4, 11, 31), now.getTime()));
    const res = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json&dataInicial=${br(from)}&dataFinal=${br(to)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return json({ error: `BCB ${res.status}` }, 502);
    for (const r of await res.json()) {
      const [d, m, yy] = r.data.split('/');
      out.push([`${yy}-${m}-${d}`, +r.valor]);
    }
  }
  const response = new Response(JSON.stringify(out), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=21600' },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

// ---------- utilitários ----------
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function sessionCookie(url, value, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256);
  return toHex(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
