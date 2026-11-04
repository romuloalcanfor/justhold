// Simulador (calculadora): os três cartões de estratégia e a busca por outras.
// O cálculo é do sim.js; aqui só a parte de escolher e trocar estratégias.
import { t } from '/js/i18n.js';
import { SETUPS, GROUPS } from '/js/setups.js';

const $ = s => document.querySelector(s);
const name = id => t(`sim.name.${id}`);
const desc = id => t(`sim.desc.${id}`);
const LUPA = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // só para o ícone fixo acima
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
}

// valor e variação, do jeito dos cartões
function valueBlock(r, amount) {
  const { short, pct } = window.sim;
  const c = r.final / amount - 1;
  return h('span', { class: 'v' }, short(r.final), h('small', { class: c >= 0 ? 'up' : 'down' }, pct(c)));
}

// ---------- os três cartões ----------
let last = null;
document.addEventListener('sim:render', ({ detail }) => {
  last = detail;
  const { current, state } = detail;
  const max = Math.max(...state.slots.map(id => current.res[id].final));
  $('#cards').replaceChildren(...state.slots.map((id, k) => {
    const on = id === state.setup;
    const r = current.res[id];
    const isBest = r.final === max && state.slots.some(o => current.res[o].final !== max);
    return h('div', {
      class: `sc${on ? ' on' : ''}`, role: 'button', tabindex: 0, 'aria-pressed': String(on),
      onclick: () => window.sim.setSetup(id),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.sim.setSetup(id); } },
    },
    h('span', { class: 'n' }, name(id), isBest ? h('span', { class: 'best' }, t('sim.best')) : null),
    h('span', { class: 'd' }, desc(id)),
    valueBlock(r, current.amount),
    h('button', { type: 'button', class: 'swap', html: LUPA, onclick: e => { e.stopPropagation(); openPicker(k); } }, t('sim.swap')));
  }));

  // qual estratégia está por trás do número grande, e o "só segurar" para comparar
  const vs = $('#vs');
  vs.replaceChildren(h('b', {}, name(state.setup)));
  if (state.setup !== 'hold') vs.append(` · ${name('hold')}: ${window.sim.money(current.res.hold.final)}`);
});

// ---------- busca ----------
const picker = $('#picker'), list = $('#pick-list'), input = $('#pick-q');
let slot = 0, group = 'all', results = {}, opener = null;
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function openPicker(index) {
  if (!last) return;
  slot = index ?? last.state.slots.indexOf(last.state.setup);
  opener = document.activeElement;
  $('#pick-title').textContent = t('sim.pickTitle', { name: name(last.state.slots[slot]) });
  // resultado de todas, com as escolhas de agora
  results = Object.fromEntries(Object.keys(SETUPS).map(id => [id, window.sim.resultFor(id)]));
  input.value = '';
  group = 'all';
  renderGroups();
  renderList();
  picker.hidden = false;
  document.body.style.overflow = 'hidden';
  input.focus({ preventScroll: true });
}
function closePicker() {
  picker.hidden = true;
  document.body.style.overflow = '';
  opener?.focus?.({ preventScroll: true });
}

function renderGroups() {
  $('#pick-groups').replaceChildren(...['all', ...GROUPS].map(g => h('button', {
    type: 'button', class: g === group ? 'on' : '', 'aria-pressed': String(g === group),
    onclick: () => { group = g; renderGroups(); renderList(); },
  }, t(`sim.group.${g}`))));
}

function renderList() {
  // cada palavra digitada precisa aparecer; aceita singular/plural ("semanal" acha "semanas")
  const words = norm(input.value).split(/\s+/).filter(Boolean);
  const hit = (hay, w) => hay.includes(w) || (w.length >= 5 && hay.includes(w.slice(0, -1))) || (w.length >= 6 && hay.includes(w.slice(0, -2)));
  const ids = Object.keys(SETUPS).filter(id => {
    if (group !== 'all' && SETUPS[id].group !== group) return false;
    const hay = norm(`${name(id)} ${desc(id)} ${t(`sim.group.${SETUPS[id].group}`)}`);
    return words.every(w => hit(hay, w));
  });
  if (!ids.length) { list.replaceChildren(h('p', { class: 'empty' }, t('sim.noResults'))); return; }
  const amount = last.current.amount;
  list.replaceChildren(...ids.map(id => {
    const r = results[id];
    return h('button', { type: 'button', class: 'prow', onclick: () => { closePicker(); window.sim.setSlot(slot, id); } },
      h('span', { class: 'n' }, name(id), last.state.slots.includes(id) ? h('span', { class: 'tag' }, t('sim.inCompare')) : null),
      h('span', { class: 'd' }, desc(id), r?.late ? h('span', { class: 'late' }, t('sim.late')) : null),
      r ? valueBlock(r, amount) : null);
  }));
}

input.addEventListener('input', renderList);
$('#find').addEventListener('click', () => openPicker());
$('#pick-close').addEventListener('click', closePicker);
picker.addEventListener('click', e => { if (e.target === picker) closePicker(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !picker.hidden) closePicker(); });
