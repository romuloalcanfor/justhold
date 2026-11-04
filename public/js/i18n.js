// Idiomas do site (português e inglês). A escolha fica neste navegador; sem escolha, segue o
// idioma do navegador. ?lang=en / ?lang=pt no endereço também escolhe (bom para links).

const KEY = 'justhold.lang';
const LANGS = ['pt', 'en'];

function detect() {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) {
    try { localStorage.setItem(KEY, q); } catch {}
    return q;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {}
  return (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export const lang = detect();
export const locale = lang === 'pt' ? 'pt-BR' : 'en-US';
document.documentElement.lang = locale;

const DICT = {
  pt: {
    'meta.homeTitle': 'JustHold · Gráfico de cripto ao vivo',
    'meta.homeDesc': 'Gráfico de cripto ao vivo, com médias, régua e watchlist. Suas configurações salvas na sua conta.',
    'meta.loginTitle': 'Entrar · JustHold',
    'meta.chartTitle': 'Gráfico · JustHold',
    'nav.login': 'Entrar',
    'nav.logout': 'Sair',
    'nav.openChart': 'Abrir o gráfico',
    'nav.signupFree': 'Criar conta grátis',
    'home.title': 'Paciência<br>é estratégia.',
    'lang.label': 'Idioma',

    'auth.loginTitle': 'Bem-vindo de volta',
    'auth.loginSub': 'Entre para usar suas configurações salvas.',
    'auth.signupTitle': 'Crie sua conta',
    'auth.signupSub': 'Grátis. Só e-mail e senha.',
    'auth.tabLogin': 'Entrar',
    'auth.tabSignup': 'Criar conta',
    'auth.email': 'E-mail',
    'auth.password': 'Senha',
    'auth.passwordHint': 'Pelo menos 8 caracteres',
    'auth.note': 'Suas médias, watchlist e linhas vão junto com você para qualquer computador.',
    'auth.fill': 'Preencha e-mail e senha.',

    'err.server': 'Erro no servidor. Tente de novo.',
    'err.notLogged': 'Não logado.',
    'err.badEmail': 'E-mail inválido.',
    'err.shortPassword': 'A senha precisa ter pelo menos 8 caracteres.',
    'err.longPassword': 'Senha longa demais.',
    'err.exists': 'Já existe uma conta com esse e-mail. Entre com ela.',
    'err.tooMany': 'Muitas tentativas. Espere 15 minutos e tente de novo.',
    'err.wrong': 'E-mail ou senha incorretos.',
    'err.generic': 'Erro {status}',

    'chart.searchSymbol': 'Buscar símbolo',
    'chart.searchPlaceholder': 'Buscar símbolo (ex.: BTCBRL)',
    'chart.addToWatchlist': 'Adicionar à watchlist',
    'chart.addSymbol': 'Adicionar símbolo',
    'chart.indicators': 'Indicadores',
    'chart.live': 'Conexão ao vivo',
    'chart.cursor': 'Cruz (Esc)',
    'chart.ruler': 'Régua (Shift + clique)',
    'chart.hline': 'Linha horizontal (Alt + H)',
    'chart.clear': 'Remover desenhos',
    'chart.log': 'Escala logarítmica',
    'chart.auto': 'Autoescala',
    'chart.dragWidth': 'Arraste para mudar a largura',
    'chart.dragHeight': 'Arraste para mudar a altura',
    'chart.colSymbol': 'Símbolo',
    'chart.colLast': 'Último',
    'chart.colChg': 'Var',
    'chart.colChgPct': 'Var%',
    'chart.open': 'Abr',
    'chart.high': 'Máx.',
    'chart.low': 'Mín.',
    'chart.close': 'Fch',
    'chart.hide': 'Ocultar',
    'chart.show': 'Mostrar',
    'chart.settings': 'Configurações',
    'chart.remove': 'Remover',
    'chart.loading': 'Carregando…',
    'chart.loadFail': 'Não consegui carregar {symbol}: {msg}',
    'chart.symbolsFail': 'Não consegui carregar a lista de símbolos: {msg}',
    'chart.indChart': 'Gráfico',
    'chart.indType': 'Tipo',
    'chart.indPeriod': 'Período',
    'chart.indTf': 'Tempo',
    'chart.indColor': 'Cor',
    'chart.indSlope': 'Verde quando sobe, vermelha quando desce',
    'chart.addMa': '+ Média móvel',
    'chart.performance': 'Desempenho',
    'chart.volume': 'Volume',
    'chart.loginHint': 'Entrar para salvar suas configurações na conta',
    'chart.savedInAccount': 'Suas configurações são salvas nesta conta.',
    'chart.bars': 'barras',
    'chart.realtime': 'Voltar para o candle atual',
    'range.1Y': '1A',
    'range.5Y': '5A',
    'range.all': 'Todos',
  },
  en: {
    'meta.homeTitle': 'JustHold · Live crypto chart',
    'meta.homeDesc': 'Live crypto chart with moving averages, a measuring ruler and a watchlist. Your settings saved to your account.',
    'meta.loginTitle': 'Log in · JustHold',
    'meta.chartTitle': 'Chart · JustHold',
    'nav.login': 'Log in',
    'nav.logout': 'Log out',
    'nav.openChart': 'Open the chart',
    'nav.signupFree': 'Create a free account',
    'home.title': 'Patience<br>is strategy.',
    'lang.label': 'Language',

    'auth.loginTitle': 'Welcome back',
    'auth.loginSub': 'Log in to use your saved settings.',
    'auth.signupTitle': 'Create your account',
    'auth.signupSub': 'Free. Just e-mail and password.',
    'auth.tabLogin': 'Log in',
    'auth.tabSignup': 'Sign up',
    'auth.email': 'E-mail',
    'auth.password': 'Password',
    'auth.passwordHint': 'At least 8 characters',
    'auth.note': 'Your moving averages, watchlist and lines follow you to any computer.',
    'auth.fill': 'Enter your e-mail and password.',

    'err.server': 'Server error. Please try again.',
    'err.notLogged': 'Not logged in.',
    'err.badEmail': 'Invalid e-mail.',
    'err.shortPassword': 'The password must be at least 8 characters.',
    'err.longPassword': 'Password too long.',
    'err.exists': 'An account with this e-mail already exists. Log in instead.',
    'err.tooMany': 'Too many attempts. Wait 15 minutes and try again.',
    'err.wrong': 'Wrong e-mail or password.',
    'err.generic': 'Error {status}',

    'chart.searchSymbol': 'Symbol search',
    'chart.searchPlaceholder': 'Search symbol (e.g. BTCUSDT)',
    'chart.addToWatchlist': 'Add to watchlist',
    'chart.addSymbol': 'Add symbol',
    'chart.indicators': 'Indicators',
    'chart.live': 'Live connection',
    'chart.cursor': 'Cross (Esc)',
    'chart.ruler': 'Measure (Shift + click)',
    'chart.hline': 'Horizontal line (Alt + H)',
    'chart.clear': 'Remove drawings',
    'chart.log': 'Log scale',
    'chart.auto': 'Auto scale',
    'chart.dragWidth': 'Drag to change the width',
    'chart.dragHeight': 'Drag to change the height',
    'chart.colSymbol': 'Symbol',
    'chart.colLast': 'Last',
    'chart.colChg': 'Chg',
    'chart.colChgPct': 'Chg%',
    'chart.open': 'O',
    'chart.high': 'H',
    'chart.low': 'L',
    'chart.close': 'C',
    'chart.hide': 'Hide',
    'chart.show': 'Show',
    'chart.settings': 'Settings',
    'chart.remove': 'Remove',
    'chart.loading': 'Loading…',
    'chart.loadFail': "Couldn't load {symbol}: {msg}",
    'chart.symbolsFail': "Couldn't load the symbol list: {msg}",
    'chart.indChart': 'Chart',
    'chart.indType': 'Type',
    'chart.indPeriod': 'Length',
    'chart.indTf': 'Timeframe',
    'chart.indColor': 'Color',
    'chart.indSlope': 'Green when rising, red when falling',
    'chart.addMa': '+ Moving average',
    'chart.performance': 'Performance',
    'chart.volume': 'Volume',
    'chart.loginHint': 'Log in to save your settings to your account',
    'chart.savedInAccount': 'Your settings are saved to this account.',
    'chart.bars': 'bars',
    'chart.realtime': 'Scroll to the latest candle',
    'range.1Y': '1Y',
    'range.5Y': '5Y',
    'range.all': 'All',
  },
};

// t('chart.loadFail', { symbol, msg }) -> texto no idioma atual
export function t(key, vars) {
  let s = DICT[lang][key] ?? DICT.pt[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

// Mensagem de erro da API de contas (o servidor manda um código; sem código, a mensagem dele).
export const apiError = (code, fallback) => (code && DICT[lang][`err.${code}`]) || fallback;

// Preenche os elementos marcados no HTML: data-i18n (texto), data-i18n-html, data-i18n-title,
// data-i18n-placeholder, data-i18n-aria.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

export function setLang(l) {
  try { localStorage.setItem(KEY, l); } catch {}
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  location.href = url;
}

// Botão "PT · EN": o idioma atual fica aceso; clicar no outro troca e recarrega a página.
export function langSwitch(className = '') {
  const box = document.createElement('div');
  box.className = `lang-switch ${className}`.trim();
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', t('lang.label'));
  for (const l of LANGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = l.toUpperCase();
    b.setAttribute('aria-pressed', l === lang);
    if (l === lang) b.className = 'on';
    else b.onclick = () => setLang(l);
    box.append(b);
  }
  return box;
}
