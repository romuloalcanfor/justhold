// Cartão "análise do dia" da homepage: busca a análise mais recente (escrita pela IA às 7h e
// às 21h de Brasília), mostra o resumo, os números das médias e o texto completo, com um
// botão para ouvir.
import { t, lang, locale } from './i18n.js';
import { canSpeak, reader } from './ouvir.js';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx=".8" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx=".8" fill="currentColor"/></svg>';

// Toca um MP3 com a mesma interface do leitor do navegador: play(), pause(), stop() e state.
// Na primeira vez do dia o servidor leva uns segundos gerando a voz: o botão mostra "Preparando".
function fileReader(src, onState, onFail) {
  const audio = new Audio();
  audio.preload = 'none';
  let state = 'idle';
  const set = s => { state = s; onState(s); };
  audio.addEventListener('playing', () => set('playing'));
  audio.addEventListener('waiting', () => set('loading'));
  audio.addEventListener('pause', () => { if (!audio.ended) set('paused'); });
  audio.addEventListener('ended', () => set('idle'));
  audio.addEventListener('error', () => { set('idle'); onFail?.(); });
  return {
    get state() { return state; },
      play() {
      if (!audio.src) { audio.src = src; set('loading'); }
      audio.play().catch(e => { if (e.name !== 'AbortError') console.error(e); });
    },
    pause() { audio.pause(); },
    stop() { audio.pause(); audio.currentTime = 0; set('idle'); },
  };
}

// abre o vídeo numa janela por cima da página; fechar para tudo
async function openVideo(a, video) {
  const box = h('div', { class: 'vbox' });
  const close = h('button', { type: 'button', class: 'vclose', 'aria-label': t('daily.close') }, '×');
  const dlg = h('dialog', { class: 'vmodal', 'aria-label': video.titulo ?? t('daily.video') }, close, box);
  document.body.append(dlg);
  let player = null;
  const done = () => { player?.destroy(); dlg.remove(); };
  close.onclick = () => dlg.close();
  dlg.addEventListener('close', done);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
  try {
    const { mountVideo } = await import('./video.js');
    player = await mountVideo(box, video, { src: `/api/analise/video/${a.id}-${lang}.mp3?v=${video.v}` });
    if (dlg.open) player.play(); else player.destroy();
  } catch (e) {
    console.error(e);
    box.textContent = t('demo.error');
  }
}

export async function mountDaily(section) {
  let a, grok = false;
  try {
    const res = await fetch('/api/analise');
    ({ analysis: a, voice: grok } = await res.json());
  } catch (e) {
    console.error(e);
    return;
  }
  if (!a) return; // sem análise ainda: a seção fica escondida

  const text = a.data[lang] ?? a.data.pt;
  const m = a.data.market;
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const pct = x => `${x >= 0 ? '+' : '−'}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.abs(x))}%`;
  const when = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: lang === 'pt' ? 'America/Sao_Paulo' : undefined })
    .format(new Date(a.created_at));

  // texto que vai para o áudio: título, resumo e as três partes, como numa leitura de rádio
  const spoken = [
    text.titulo + '.', text.resumo,
    t('daily.market') + '.', ...text.mercado,
    t('daily.chart') + '.', ...text.grafico,
    t('daily.watch') + '.', ...text.de_olho,
  ].join(' ');
  const minutes = Math.max(1, Math.round(spoken.split(/\s+/).length / 155));

  // números do gráfico: preço e distância para cada média
  const tile = (label, value, dist, note) => h('div', { class: 'tile' },
    h('span', { class: 'tl' }, label),
    h('span', { class: 'tv' }, value),
    dist == null ? null : h('span', { class: `td ${dist >= 0 ? 'up' : 'down'}` }, note ? note(dist) : pct(dist)));
  // nas médias, o número colorido é onde o preço está em relação a ela
  const vsPrice = d => t(d >= 0 ? 'daily.above' : 'daily.below', { p: pct(Math.abs(d)).slice(1) });
  const tiles = m ? h('div', { class: 'tiles' },
    tile(t('daily.price'), num.format(m.price), m.change?.h24Pct),
    ...[50, 110, 200].filter(n => m.dailySma?.[n]).map(n => tile(t('daily.sma', { n }), num.format(m.dailySma[n].value), m.dailySma[n].distancePct, vsPrice)),
  ) : null;

  const play = h('button', { type: 'button', class: 'play', 'aria-label': t('daily.listen') });
  const playLabel = h('span', {}, t('daily.listen'));
  const playTime = h('small', {}, t('daily.minutes', { n: minutes }));
  const setPlay = state => {
    play.innerHTML = state === 'playing' ? PAUSE : PLAY;
    playLabel.textContent = { playing: t('daily.pause'), paused: t('daily.resume'), loading: t('daily.loading') }[state] ?? t('daily.listen');
    play.append(playLabel, playTime);
    play.classList.toggle('on', state === 'playing');
    play.classList.toggle('loading', state === 'loading');
    play.setAttribute('aria-label', playLabel.textContent);
  };
  // voz natural do Grok, gerada no servidor no primeiro clique de alguém (e guardada para os
  // próximos); se não houver ou falhar, a voz do navegador
  const browserVoice = () => (canSpeak ? reader(spoken, locale, setPlay) : null);
  let voice = grok ? fileReader(`/api/analise/audio/${a.id}-${lang}.mp3?v=${a.created_at}-${grok}`, setPlay, () => {
    voice = browserVoice();
    voice?.play();
  }) : browserVoice();
  setPlay('idle');
  play.onclick = () => (voice.state === 'playing' || voice.state === 'loading' ? voice.pause() : voice.play());
  addEventListener('pagehide', () => voice?.stop());

  // vídeo da análise (gráfico animado com a narração), quando houver para esta língua
  const video = a.data.video?.[lang];
  let watch = null;
  if (video) {
    const mins = Math.max(1, Math.round(video.dur / 60));
    watch = h('button', { type: 'button', class: 'play watch' });
    watch.innerHTML = PLAY;
    watch.append(h('span', {}, t('daily.video')), h('small', {}, t('daily.minutes', { n: mins })));
    watch.onclick = () => openVideo(a, video);
  }

  const body = h('div', { class: 'daily-body', id: 'daily-body', hidden: true },
    h('h3', {}, t('daily.market')), ...text.mercado.map(p => h('p', {}, p)),
    h('h3', {}, t('daily.chart')), ...text.grafico.map(p => h('p', {}, p)),
    h('h3', {}, t('daily.watch')), h('ul', {}, ...text.de_olho.map(p => h('li', {}, p))),
    a.data.fontes?.length ? h('p', { class: 'sources' }, `${t('daily.sources')}: `,
      ...a.data.fontes.flatMap((f, i) => [i ? ' · ' : '', h('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.titulo || new URL(f.url).host)])) : null,
  );
  const more = h('button', { type: 'button', class: 'btn uline sm more', 'aria-expanded': 'false', 'aria-controls': 'daily-body' }, t('daily.more'));
  more.onclick = () => {
    body.hidden = !body.hidden;
    more.setAttribute('aria-expanded', String(!body.hidden));
    more.textContent = body.hidden ? t('daily.more') : t('daily.less');
  };

  section.replaceChildren(h('div', { class: 'daily' },
    h('div', { class: 'daily-head' },
      h('span', { class: 'kicker' }, h('span', { class: 'dot' }), `${t(`daily.slot.${a.slot}`)} · ${when}`,
        a.data.exemplo ? h('span', { class: 'tag' }, t('daily.sample')) : null),
      h('div', { class: 'daily-actions' }, watch, grok || canSpeak ? play : null)),
    h('h2', {}, text.titulo),
    h('p', { class: 'lead' }, text.resumo),
    tiles,
    body,
    more,
    h('p', { class: 'fine' }, t('daily.fine')),
  ));
  section.hidden = false;
}
