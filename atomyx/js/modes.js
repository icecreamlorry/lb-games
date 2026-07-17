// The six Atomyx game modes. Controllers drive the table stage (#table-stage) +
// the DOM panels; main.js owns rooms/timing/results. ctx:
//
//   ctx = {
//     data,               // elements.json content
//     mode, rounds,       // from engine.buildRounds (identical for all seats)
//     setIds,             // the playable set (lowercase symbols)
//     startedAt,          // epoch ms of the reveal
//     restore,            // saved progress { outcomes } / { found } or null
//     onProgress(state), onStatus(msg),
//     onFinish(result),   // { outcomes, score, total, ms }
//   }
//
// Pick/table modes outcomes: [{ id, pick, ok }] per round.
// Mass outcomes: [{ ids, ok: [bool per slot] }] per round.
// Sweep outcomes: { found: [ids in typed order], gaveUp }.

import { gradeOrder, expectedOrder, buildAnswerIndex, matchAnswer, matchSymbol, isOrderMode, isTableMode } from './engine.js';
import { renderTable } from './table.js';
import { fmtMass } from './data.js';

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PANELS = ['panel-options', 'panel-typing', 'panel-confirm'];
export function showPanel(id) {
  for (const p of PANELS) $(p).classList.toggle('hidden', p !== id);
}
export function hidePanels() { showPanel(null); }

function setPrompt(main, sub = '') {
  $('prompt-line').textContent = main || '';
  $('prompt-sub').textContent = sub || '';
}

function stage() { return $('table-stage'); }

// Small square element tile (order rows / review rows).
function elTile(el, cls = '') {
  return `<span class="${cls}"><span class="tile-num">${el.num}</span><span class="tile-sym">${esc(el.sym)}</span></span>`;
}

export function createMode(modeId, ctx) {
  const ac = new AbortController();
  const ctl = isOrderMode(modeId) ? orderMode(ctx, ac.signal)
    : modeId === 'sweep' ? sweepMode(ctx, ac.signal)
    : isTableMode(modeId) ? tableMode(ctx, ac.signal)
    : tileMode(ctx, ac.signal);
  return {
    start: ctl.start,
    destroy() { ac.abort(); ctl.destroy?.(); hidePanels(); setPrompt(''); stage().innerHTML = ''; },
  };
}

// ---- PINPOINT / BUILD (tap the table) -----------------------------------------
// Tap selects (cells are ~20px on phones — a mis-tap must never grade), CONFIRM
// grades. Graded cells persist and go inactive, so the table fills up over the
// run. BUILD is the same game with the set's symbols hidden until placed.

function tableMode(ctx, signal) {
  const { data, mode, rounds, setIds } = ctx;
  const E = data.elements;
  const st = { idx: 0, outcomes: [], grading: false, done: false, sel: null };
  if (Array.isArray(ctx.restore?.outcomes)) {
    st.outcomes = ctx.restore.outcomes;
    st.idx = st.outcomes.length;
  }
  const btn = $('btn-confirm');
  const placed = new Set();

  const table = renderTable(stage(), E, setIds, {
    blankActive: mode === 'build',
    onTap(id) {
      if (st.grading || st.done || placed.has(id)) return;
      table.clearSel();
      table.mark(id, 'sel');
      st.sel = id;
      btn.disabled = false;
    },
  });

  // Replay restored outcomes so the table shows the same fills as before the
  // reload, and graded cells stay off-limits.
  function paint(o) {
    placed.add(o.id);
    table.reveal(o.id);
    table.mark(o.id, o.ok ? 'ok' : 'bad');
  }
  st.outcomes.forEach(paint);

  function finish() {
    st.done = true;
    ctx.onFinish({
      outcomes: st.outcomes,
      score: st.outcomes.filter((o) => o.ok).length,
      total: rounds.length,
      ms: Date.now() - ctx.startedAt,
    });
  }

  async function confirm() {
    if (st.grading || st.done || st.sel == null) return;
    st.grading = true;
    btn.disabled = true;
    const round = rounds[st.idx];
    const pick = st.sel;
    const ok = pick === round.answer;
    st.outcomes.push({ id: round.answer, pick, ok });
    ctx.onProgress({ outcomes: st.outcomes });

    table.clearSel();
    paint(st.outcomes[st.outcomes.length - 1]);
    if (!ok) {
      table.mark(pick, 'miss');
      setTimeout(() => table.unmark(pick, 'miss'), 1300);
    }
    ctx.onStatus(ok ? `✓ ${E[round.answer].name} (${E[round.answer].sym})` : `✗ ${E[round.answer].name} is ${E[round.answer].sym} — the red cell`);
    await delay(ok ? 700 : 1500);
    if (signal.aborted) return;
    st.idx++;
    st.grading = false;
    st.sel = null;
    ctx.onStatus('');
    next();
  }

  function ask() {
    const round = rounds[st.idx];
    const el = E[round.answer];
    const progress = `${st.idx + 1} / ${rounds.length}`;
    showPanel('panel-confirm');
    btn.textContent = 'CONFIRM';
    btn.disabled = true;
    if (mode === 'build') setPrompt(`${el.name} · ${el.sym}`, `Tap where it lives · ${progress}`);
    else setPrompt(el.name, `Tap its cell · ${progress}`);
  }

  function next() {
    if (signal.aborted || st.done) return;
    if (st.idx >= rounds.length) { finish(); return; }
    ask();
  }

  btn.addEventListener('click', confirm, { signal });
  return { start: next, destroy() {} };
}

// ---- LINE-UP / NAMEDROP (one big element tile) ---------------------------------

function tileMode(ctx, signal) {
  const { data, mode, rounds } = ctx;
  const E = data.elements;
  const index = buildAnswerIndex(Object.entries(E).map(([id, e]) => ({ id, name: e.name, alt: e.alt })));
  const st = { idx: 0, outcomes: [], grading: false, done: false };
  if (Array.isArray(ctx.restore?.outcomes)) {
    st.outcomes = ctx.restore.outcomes;
    st.idx = st.outcomes.length;
  }

  function finish() {
    st.done = true;
    ctx.onFinish({
      outcomes: st.outcomes,
      score: st.outcomes.filter((o) => o.ok).length,
      total: rounds.length,
      ms: Date.now() - ctx.startedAt,
    });
  }

  async function grade(pick) {
    if (st.grading || st.done || signal.aborted) return;
    st.grading = true;
    const round = rounds[st.idx];
    const ok = pick === round.answer;
    st.outcomes.push({ id: round.answer, pick, ok });
    ctx.onProgress({ outcomes: st.outcomes });

    // The big tile frames green/red (the only feedback in namedrop) and its
    // hidden name line fills in — seeing the answer IS the learning.
    const wrap = stage().querySelector('.big-el-wrap');
    wrap?.classList.add('graded', ok ? 'ok' : 'bad');
    const nameEl = stage().querySelector('.big-el-name');
    if (nameEl) nameEl.textContent = E[round.answer].name;
    for (const b of document.querySelectorAll('#options-list .option-btn')) {
      if (b.dataset.id === round.answer) b.classList.add('good');
      else if (b.dataset.id === pick) b.classList.add('wrong');
      else b.classList.add('dim');
    }
    ctx.onStatus(ok ? `✓ ${E[round.answer].name}` : `✗ It was ${E[round.answer].name}`);
    await delay(ok ? 700 : 1400);
    if (signal.aborted) return;
    st.idx++;
    st.grading = false;
    ctx.onStatus('');
    next();
  }

  function ask() {
    const round = rounds[st.idx];
    const el = E[round.answer];
    const progress = `${st.idx + 1} / ${rounds.length}`;
    stage().innerHTML = `<div class="big-el-wrap"><div class="big-el">`
      + `<span class="big-el-num">${el.num}</span>`
      + `<span class="big-el-sym">${esc(el.sym)}</span>`
      + `<span class="big-el-mass">${fmtMass(el.mass)}</span>`
      + `</div><div class="big-el-name"></div></div>`;
    if (mode === 'lineup') {
      showPanel('panel-options');
      setPrompt('Which element is this?', progress);
      const list = $('options-list');
      list.innerHTML = '';
      // Alphabetical so the choices are easy to scan (the seeded order only
      // needs to decide WHICH names appear, not their order).
      const names = round.options.slice().sort((a, b) => E[a].name.localeCompare(E[b].name));
      for (const id of names) {
        const b = document.createElement('button');
        b.className = 'option-btn';
        b.dataset.id = id;
        b.textContent = E[id].name;
        b.addEventListener('click', () => { if (!st.grading) grade(id); }, { signal });
        list.appendChild(b);
      }
      list.scrollTop = 0;
    } else {
      showPanel('panel-typing');
      $('btn-giveup').classList.add('hidden');
      setPrompt('Which element is this?', `Type its name · ${progress}`);
      const input = $('answer-input');
      input.placeholder = 'Type the element…';
      input.value = '';
      input.focus({ preventScroll: true });
    }
  }

  function next() {
    if (signal.aborted || st.done) return;
    if (st.idx >= rounds.length) { finish(); return; }
    ask();
  }

  if (mode === 'namedrop') {
    const submit = () => {
      if (st.grading || st.done) return;
      const raw = $('answer-input').value.trim();
      if (!raw) return;
      grade(matchAnswer(index, raw) ?? '?');
    };
    $('btn-answer').addEventListener('click', submit, { signal });
    $('answer-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }, { signal });
  }

  return { start: next, destroy() {} };
}

// ---- MASS (drag into atomic-mass order) ------------------------------------------
// Names + symbols stay visible while dragging — the quiz is knowing masses,
// not identifying blind tiles. Masses appear on reveal.

function orderMode(ctx, signal) {
  const { data, mode, rounds } = ctx;
  const E = data.elements;
  const st = { idx: 0, outcomes: [], revealed: false, done: false };
  if (Array.isArray(ctx.restore?.outcomes)) {
    st.outcomes = ctx.restore.outcomes;
    st.idx = st.outcomes.length;
  }
  const btn = $('btn-confirm');
  let drag = null;

  function currentIds() {
    return [...stage().querySelectorAll('.order-row')].map((r) => r.dataset.id);
  }

  // Per-round display map. Use the fewest decimals that still tell every
  // DISTINCT mass apart (Co 58.93 vs Ni 58.69 need 1dp; nothing needs more
  // than a few); equal values keep the same string and stay interchangeable.
  function roundDisplay(ids) {
    for (const dp of [0, 1, 2, 3]) {
      const m = {};
      for (const id of ids) m[id] = `${E[id].mass.toFixed(dp)} u`;
      let clash = false;
      for (let i = 0; i < ids.length && !clash; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (E[ids[i]].mass !== E[ids[j]].mass && m[ids[i]] === m[ids[j]]) { clash = true; break; }
        }
      }
      if (!clash) return m;
    }
    const m = {};
    for (const id of ids) m[id] = `${E[id].mass} u`;
    return m;
  }

  function ask() {
    st.revealed = false;
    const round = rounds[st.idx];
    setPrompt('Drag into atomic-mass order — lightest at the top', `Round ${st.idx + 1} / ${rounds.length} · ${round.ids.length} elements`);
    showPanel('panel-confirm');
    btn.textContent = 'CONFIRM ORDER';
    btn.disabled = false;
    stage().innerHTML = `<div class="order-list">`
      + round.ids.map((id) => `<div class="order-row" data-id="${id}">`
        + `<span class="order-grip">⠿</span>${elTile(E[id], 'order-tile')}`
        + `<span class="order-text"><span class="order-name">${esc(E[id].name)}</span><span class="order-val"></span></span></div>`).join('')
      + '</div>';
    for (const row of stage().querySelectorAll('.order-row')) {
      row.addEventListener('pointerdown', (e) => beginDrag(e, row), { signal });
    }
  }

  // Pointer-drag vertical reorder — carried over from Flagz verbatim. The
  // dragged row follows the finger and re-homes into the slot whose
  // neighbours' midpoints bracket the pointer; the visual offset is recomputed
  // from the row's CURRENT in-flow slot every move so a DOM reorder never
  // makes the row jump or fight itself.
  function beginDrag(e, row) {
    if (st.revealed || st.done || drag) return;
    e.preventDefault();
    row.setPointerCapture?.(e.pointerId);
    const rect0 = row.getBoundingClientRect();
    drag = { row, grabOffset: e.clientY - rect0.top, lastY: e.clientY, raf: 0 };
    row.classList.add('dragging');
    const list = stage().querySelector('.order-list');
    const scroller = stage();

    const place = (y) => {
      if (!drag) return;
      const others = [...list.querySelectorAll('.order-row')].filter((r) => r !== row);
      let before = null;
      for (const other of others) {
        const r = other.getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = other; break; }
      }
      if (before) {
        if (row.nextElementSibling !== before) list.insertBefore(row, before);
      } else if (list.lastElementChild !== row) {
        list.appendChild(row);
      }
      row.style.transform = 'none';
      const slotTop = row.getBoundingClientRect().top;
      row.style.transform = `translateY(${y - drag.grabOffset - slotTop}px)`;
    };

    // Auto-scroll when the finger nears an edge, so long lists (hard/all) that
    // overflow the viewport can be reordered end to end.
    const EDGE = 56, SPEED = 12;
    const tick = () => {
      if (!drag) return;
      const rect = scroller.getBoundingClientRect();
      let dv = 0;
      if (drag.lastY < rect.top + EDGE) dv = -SPEED;
      else if (drag.lastY > rect.bottom - EDGE) dv = SPEED;
      if (dv) {
        const before = scroller.scrollTop;
        scroller.scrollTop += dv;
        if (scroller.scrollTop !== before) place(drag.lastY);
      }
      drag.raf = requestAnimationFrame(tick);
    };

    const move = (ev) => { if (drag) { drag.lastY = ev.clientY; place(ev.clientY); } };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (drag) { cancelAnimationFrame(drag.raf); drag.row.style.transform = ''; drag.row.classList.remove('dragging'); drag = null; }
    };
    drag.raf = requestAnimationFrame(tick);
    window.addEventListener('pointermove', move, { signal });
    window.addEventListener('pointerup', up, { signal });
    window.addEventListener('pointercancel', up, { signal });
  }

  function reveal() {
    const placed = currentIds();
    const ok = gradeOrder(mode, placed, E);
    st.outcomes.push({ ids: placed, ok });
    ctx.onProgress({ outcomes: st.outcomes });
    st.revealed = true;
    const rows = stage().querySelectorAll('.order-row');
    const disp = roundDisplay(placed);
    placed.forEach((id, i) => {
      const row = rows[i];
      row.classList.add(ok[i] ? 'good' : 'wrong');
      // The grip becomes a ✓/✗ so right/wrong reads without relying on colour.
      row.querySelector('.order-grip').textContent = ok[i] ? '✓' : '✗';
      row.querySelector('.order-val').textContent = disp[id];
    });
    const got = ok.filter(Boolean).length;
    // Show where each element should have gone when the round went poorly.
    const expected = expectedOrder(mode, placed, E);
    ctx.onStatus(got === ok.length ? `Perfect round! ${got}/${ok.length}` : `${got}/${ok.length} in the right spot`);
    if (got !== ok.length) {
      placed.forEach((id, i) => {
        const want = expected.indexOf(id);
        const tag = document.createElement('span');
        tag.className = 'order-want';
        tag.textContent = `#${want + 1}`;
        rows[i].appendChild(tag);
      });
    }
    btn.textContent = st.idx + 1 >= rounds.length ? 'FINISH' : 'NEXT';
  }

  function advance() {
    if (st.done) return;
    if (!st.revealed) { reveal(); return; }
    st.idx++;
    ctx.onStatus('');
    if (st.idx >= rounds.length) {
      st.done = true;
      const score = st.outcomes.reduce((s, o) => s + o.ok.filter(Boolean).length, 0);
      const total = st.outcomes.reduce((s, o) => s + o.ok.length, 0);
      ctx.onFinish({ outcomes: st.outcomes, score, total, ms: Date.now() - ctx.startedAt });
      return;
    }
    ask();
  }

  btn.addEventListener('click', advance, { signal });

  return {
    start() {
      if (st.idx >= rounds.length) { st.idx = rounds.length; advance(); return; }
      ask();
    },
    destroy() { if (drag) cancelAnimationFrame(drag.raf); drag = null; },
  };
}

// ---- SWEEP (type every element in the set) ----------------------------------------
// Names OR symbols count — symbol recall is legitimate element knowledge, and
// rapid-firing "h he li be b…" is the fun of the mode. Each hit fills its cell.

function sweepMode(ctx, signal) {
  const { data, rounds, setIds } = ctx;
  const E = data.elements;
  const index = buildAnswerIndex(setIds.map((id) => ({ id, name: E[id].name, alt: E[id].alt })));
  const st = { found: [], done: false };
  if (Array.isArray(ctx.restore?.found)) st.found = ctx.restore.found.filter((id) => setIds.includes(id));
  const total = rounds[0].ids.length;

  const table = renderTable(stage(), E, setIds, { blankActive: true });
  for (const id of st.found) { table.reveal(id); table.mark(id, 'found'); }

  function progressLine() {
    setPrompt('Name every element on the table', `${st.found.length} / ${total} found`);
  }

  function finish(gaveUp) {
    if (st.done) return;
    st.done = true;
    ctx.onFinish({
      outcomes: { found: st.found, gaveUp },
      score: st.found.length,
      total,
      ms: Date.now() - ctx.startedAt,
    });
  }

  function submit() {
    if (st.done) return;
    const input = $('answer-input');
    const raw = input.value.trim();
    if (!raw) return;
    input.value = '';
    const id = matchAnswer(index, raw) ?? matchSymbol(setIds, raw);
    if (!id) { ctx.onStatus(`"${raw}" — no element in this set`); return; }
    if (st.found.includes(id)) { ctx.onStatus(`Already got ${E[id].name}`); return; }
    st.found.push(id);
    ctx.onProgress({ found: st.found });
    table.reveal(id);
    table.mark(id, 'found');
    ctx.onStatus(`✓ ${E[id].name} (${E[id].sym})`);
    progressLine();
    if (st.found.length >= total) finish(false);
  }

  return {
    start() {
      showPanel('panel-typing');
      $('btn-giveup').classList.remove('hidden');
      const input = $('answer-input');
      input.placeholder = 'Name or symbol…';
      input.value = '';
      progressLine();
      $('btn-answer').addEventListener('click', submit, { signal });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }, { signal });
      $('btn-giveup').addEventListener('click', () => finish(true), { signal });
      input.focus({ preventScroll: true });
      if (st.found.length >= total) finish(false);
    },
    destroy() { $('btn-giveup').classList.add('hidden'); },
  };
}

// ---- End-of-game review --------------------------------------------------------
// Renders any player's submitted attempt into the stage (used for your own
// final view and other players' via their result moves).

export function renderReview(data, mode, result, setIds = []) {
  hidePanels();
  setPrompt('');
  const E = data.elements;
  const el = stage();
  if (!result) { el.innerHTML = ''; return; }

  const row = (id, good, extra = '') => `<div class="review-row ${good ? 'good' : 'wrong'}">`
    + `${elTile(E[id], 'review-tile')}<span class="review-name">${esc(E[id]?.name || id)}</span>${extra}`
    + `<span class="review-mark">${good ? '✓' : '✗'}</span></div>`;

  if (mode === 'sweep') {
    // The whole set in table order — missed elements show their names, which
    // is the learning moment of the mode.
    const found = new Set(result.outcomes?.found || []);
    const ids = setIds.slice().sort((a, b) => E[a].num - E[b].num);
    el.innerHTML = '<div class="review-list">' + ids.map((id) => row(id, found.has(id))).join('') + '</div>';
    return;
  }

  if (!isOrderMode(mode)) {
    el.innerHTML = '<div class="review-list">' + (result.outcomes || []).map((o) => {
      const pickName = o.ok ? '' : `<span class="review-pick">you: ${esc(o.pick && E[o.pick] ? E[o.pick].name : '—')}</span>`;
      return row(o.id, o.ok, pickName);
    }).join('') + '</div>';
    return;
  }

  el.innerHTML = '<div class="review-list">' + (result.outcomes || []).map((o, r) => {
    const rows = (o.ids || []).map((id, i) => row(id, !!o.ok?.[i])).join('');
    return `<div class="review-round"><div class="review-round-label">Round ${r + 1}</div>${rows}</div>`;
  }).join('') + '</div>';
}
