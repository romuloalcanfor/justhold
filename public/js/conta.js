// Cliente da API de contas, usado pela homepage, pela página de login e pelo gráfico.

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { status: res.status });
  return data;
}

let mePromise = null;
// Usuário logado ({ email }) ou null. Fica em memória durante a página.
export function me() {
  mePromise ??= call('GET', '/api/me').then(r => r.user).catch(() => null);
  return mePromise;
}

export async function login(email, password) {
  const r = await call('POST', '/api/login', { email, password });
  mePromise = Promise.resolve(r);
  return r;
}

export async function signup(email, password) {
  const r = await call('POST', '/api/signup', { email, password });
  mePromise = Promise.resolve(r);
  return r;
}

export async function logout() {
  await call('POST', '/api/logout', {});
  mePromise = Promise.resolve(null);
}

export const getPrefs = () => call('GET', '/api/prefs');
export const putPrefs = prefs => call('PUT', '/api/prefs', { prefs });

// Endereço da página de login que volta para a página atual depois de entrar.
export const loginUrl = (mode = 'entrar') => `/entrar/?modo=${mode}&volta=${encodeURIComponent(location.pathname + location.search)}`;
