// Leitura em voz alta das análises. Por enquanto usa a voz do próprio navegador
// (speechSynthesis), escolhendo a mais natural disponível; quando a análise tiver um áudio
// gerado no servidor (voz de IA), a home toca o arquivo no lugar desta.

const synth = window.speechSynthesis;
export const canSpeak = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

// vozes que soam melhor primeiro: as "naturais" do Edge, as aprimoradas do Mac, as do Google
const RANK = [/natural|neural|online/i, /premium|enhanced|aprimorad/i, /google/i, /luciana|francisca|thalita|samantha|ava|allison/i];

function pickVoice(locale) {
  const voices = synth.getVoices();
  const base = locale.slice(0, 2);
  const mine = voices.filter(v => v.lang?.replace('_', '-').toLowerCase().startsWith(locale.toLowerCase()));
  const pool = mine.length ? mine : voices.filter(v => v.lang?.toLowerCase().startsWith(base));
  const score = v => {
    const i = RANK.findIndex(r => r.test(v.name));
    return i < 0 ? RANK.length : i;
  };
  return pool.sort((a, b) => score(a) - score(b))[0] ?? null;
}

// O Chrome corta falas longas no meio: lemos frase a frase.
function sentences(text) {
  return text.match(/[^.!?]+[.!?]+["”]?|\S[^.!?]*$/g)?.map(s => s.trim()).filter(Boolean) ?? [text];
}

// Uma leitura controlável: play(), pause(), stop(). onState recebe 'playing' | 'paused' | 'idle'.
export function reader(text, locale, onState = () => {}) {
  const parts = sentences(text);
  let i = 0, state = 'idle', voice = null;

  const set = s => { state = s; onState(s); };
  const next = () => {
    if (state !== 'playing') return;
    if (i >= parts.length) { i = 0; set('idle'); return; }
    const u = new SpeechSynthesisUtterance(parts[i]);
    u.lang = locale;
    if (voice) u.voice = voice;
    u.rate = 1.02;
    u.onend = () => { i++; next(); };
    u.onerror = e => { if (e.error !== 'interrupted' && e.error !== 'canceled') { i = 0; set('idle'); } };
    synth.speak(u);
  };

  return {
    get state() { return state; },
    play() {
      if (state === 'playing') return;
      voice ??= pickVoice(locale);
      if (state === 'paused' && synth.paused) { synth.resume(); set('playing'); return; }
      synth.cancel();
      set('playing');
      next();
    },
    pause() {
      if (state !== 'playing') return;
      synth.pause();
      set('paused');
    },
    stop() {
      synth.cancel();
      i = 0;
      set('idle');
    },
  };
}

// as vozes chegam depois do carregamento em alguns navegadores
if (canSpeak) synth.getVoices();
