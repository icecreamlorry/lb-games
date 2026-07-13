// The six Flagz game modes. Controllers drive the flag stage (#flag-stage) +
// the DOM panels; main.js owns rooms/timing/results. ctx:
//
//   ctx = {
//     data,               // countries.json content
//     mode, rounds,       // from engine.buildRounds (identical for all seats)
//     startedAt,          // epoch ms of the reveal
//     restore,            // saved progress { outcomes } or null
//     onProgress(state), onStatus(msg),
//     onFinish(result),   // { outcomes, score, total, ms }
//   }
//
// Pick modes outcomes: [{ id, pick, ok }] per round.
// Order modes outcomes: [{ ids, ok: [bool per slot] }] per round.

import { gradeOrder, expectedOrder, buildAnswerIndex, matchAnswer, isOrderMode } from './engine.js';
import { flagUrl, fmtBig } from './data.js';

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

function stage() { return $('flag-stage'); }

function flagImg(iso, cls = '') {
  return `<img class="${cls}" src="${flagUrl(iso)}" alt="" draggable="false">`;
}

export function createMode(modeId, ctx) {
  const ac = new AbortController();
  const ctl = isOrderMode(modeId) ? orderMode(ctx, ac.signal) : pickMode(ctx, ac.signal);
  return {
    start: ctl.start,
    destroy() { ac.abort(); ctl.destroy?.(); hidePanels(); setPrompt(''); stage().innerHTML = ''; },
  };
}

// ---- SPOTTER / LINE-UP / NAMEDROP -------------------------------------------

function pickMode(ctx, signal) {
  const { data, mode, rounds } = ctx;
  const C = data.countries;
  const index = buildAnswerIndex(Object.entries(C).map(([id, c]) => ({ id, name: c.name, alt: c.alt })));
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

    // Reveal: green on the answer, red on a wrong pick. Everything not
    // involved dims so the highlight really pops.
    if (mode === 'spotter') {
      const grid = stage().querySelector('.flag-grid');
      grid?.classList.add('graded');
      for (const el of stage().querySelectorAll('.flag-tile')) {
        if (el.dataset.id === round.answer) el.classList.add('ok');
        else if (el.dataset.id === pick) el.classList.add('bad');
        else el.classList.add('dim');
      }
    } else {
      // The big flag frames green/red too (and is the only feedback in namedrop).
      const wrap = stage().querySelector('.big-flag-wrap');
      wrap?.classList.add('graded', ok ? 'ok' : 'bad');
      for (const b of document.querySelectorAll('#options-list .option-btn')) {
        if (b.dataset.id === round.answer) b.classList.add('good');
        else if (b.dataset.id === pick) b.classList.add('wrong');
        else b.classList.add('dim');
      }
    }
    ctx.onStatus(ok ? `✓ ${C[round.answer].name}` : `✗ It was ${C[round.answer].name}`);
    await delay(ok ? 700 : 1400);
    if (signal.aborted) return;
    st.idx++;
    st.grading = false;
    ctx.onStatus('');
    next();
  }

  function ask() {
    const round = rounds[st.idx];
    const progress = `${st.idx + 1} / ${rounds.length}`;
    if (mode === 'spotter') {
      hidePanels();
      setPrompt(C[round.answer].name, `Tap its flag · ${progress}`);
      stage().innerHTML = `<div class="flag-grid n${Math.min(round.options.length, 12)}">`
        + round.options.map((iso) => `<button class="flag-tile" data-id="${iso}">${flagImg(iso)}</button>`).join('')
        + '</div>';
      for (const b of stage().querySelectorAll('.flag-tile')) {
        b.addEventListener('click', () => { if (!st.grading) grade(b.dataset.id); }, { signal });
      }
    } else {
      stage().innerHTML = `<div class="big-flag-wrap">${flagImg(round.answer, 'big-flag')}</div>`;
      if (mode === 'lineup') {
        showPanel('panel-options');
        setPrompt('Whose flag is this?', progress);
        const list = $('options-list');
        list.innerHTML = '';
        for (const iso of round.options) {
          const b = document.createElement('button');
          b.className = 'option-btn';
          b.dataset.id = iso;
          b.textContent = C[iso].name;
          b.addEventListener('click', () => { if (!st.grading) grade(iso); }, { signal });
          list.appendChild(b);
        }
        list.scrollTop = 0;
      } else {
        showPanel('panel-typing');
        setPrompt('Whose flag is this?', `Type the country · ${progress}`);
        const input = $('answer-input');
        input.value = '';
        input.focus({ preventScroll: true });
      }
    }
  }

  function next() {
    if (signal.aborted || st.done) return;
    if (st.idx >= rounds.length) { finish(); return; }
    ask();
  }

  if (ctx.mode === 'namedrop') {
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

// ---- A TO Z / HEADCOUNT / LANDMASS -------------------------------------------

const ORDER_HINT = {
  atoz: 'Drag into alphabetical order — A at the top',
  headcount: 'Drag into population order — smallest at the top',
  landmass: 'Drag into area order — smallest at the top',
};

function orderMode(ctx, signal) {
  const { data, mode, rounds } = ctx;
  const C = data.countries;
  const st = { idx: 0, outcomes: [], revealed: false, done: false };
  if (Array.isArray(ctx.restore?.outcomes)) {
    st.outcomes = ctx.restore.outcomes;
    st.idx = st.outcomes.length;
  }
  const btn = $('btn-confirm-order');
  let drag = null;

  function currentIds() {
    return [...stage().querySelectorAll('.order-row')].map((r) => r.dataset.id);
  }

  function valueLine(iso) {
    if (mode === 'headcount') return `${fmtBig(C[iso].pop)} people`;
    if (mode === 'landmass') return `${fmtBig(C[iso].area)} km²`;
    return '';
  }

  function ask() {
    st.revealed = false;
    const round = rounds[st.idx];
    setPrompt(ORDER_HINT[mode], `Round ${st.idx + 1} / ${rounds.length} · ${round.ids.length} flags`);
    showPanel('panel-confirm');
    btn.textContent = 'CONFIRM ORDER';
    btn.disabled = false;
    stage().innerHTML = `<div class="order-list">`
      + round.ids.map((iso) => `<div class="order-row" data-id="${iso}">`
        + `<span class="order-grip">⠿</span>${flagImg(iso, 'order-flag')}<span class="order-name"></span><span class="order-val"></span></div>`).join('')
      + '</div>';
    for (const row of stage().querySelectorAll('.order-row')) {
      row.addEventListener('pointerdown', (e) => beginDrag(e, row), { signal });
    }
  }

  // Pointer-drag vertical reorder. The dragged row follows the finger, and we
  // re-home it into the slot whose neighbours' midpoints bracket the pointer.
  // The visual offset is recomputed from the row's CURRENT in-flow slot every
  // move, so a DOM reorder never makes the row jump or fight itself (the old
  // reset-transform-on-swap approach stalled on the 2nd→1st move).
  function beginDrag(e, row) {
    if (st.revealed || st.done || drag) return;
    e.preventDefault();
    row.setPointerCapture?.(e.pointerId);
    const rect0 = row.getBoundingClientRect();
    drag = { row, grabOffset: e.clientY - rect0.top, lastY: e.clientY, raf: 0 };
    row.classList.add('dragging');
    const list = stage().querySelector('.order-list');
    const scroller = stage();

    // Re-home the row into the slot bracketed by neighbour midpoints, and track
    // the finger from that (possibly new) in-flow slot. Others are measured
    // in-flow (transform doesn't affect layout), so their positions already
    // account for the dragged row's own slot.
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
    const ok = gradeOrder(mode, placed, C);
    st.outcomes.push({ ids: placed, ok });
    ctx.onProgress({ outcomes: st.outcomes });
    st.revealed = true;
    const rows = stage().querySelectorAll('.order-row');
    placed.forEach((iso, i) => {
      const row = rows[i];
      row.classList.add(ok[i] ? 'good' : 'wrong');
      row.querySelector('.order-name').textContent = C[iso].name;
      row.querySelector('.order-val').textContent = valueLine(iso);
    });
    const got = ok.filter(Boolean).length;
    // Show where each flag should have gone when the round went poorly.
    const expected = expectedOrder(mode, placed, C);
    ctx.onStatus(got === ok.length ? `Perfect round! ${got}/${ok.length}` : `${got}/${ok.length} in the right spot`);
    if (got !== ok.length) {
      placed.forEach((iso, i) => {
        const want = expected.indexOf(iso);
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

// ---- End-of-game review --------------------------------------------------------
// Renders any player's submitted attempt into the stage (used for your own
// final view and other players' via their result moves).

export function renderReview(data, mode, result) {
  hidePanels();
  setPrompt('');
  const C = data.countries;
  const el = stage();
  if (!result) { el.innerHTML = ''; return; }

  if (!isOrderMode(mode)) {
    el.innerHTML = '<div class="review-list">' + (result.outcomes || []).map((o) => {
      const pickName = o.ok ? '' : `<span class="review-pick">you: ${esc(o.pick && C[o.pick] ? C[o.pick].name : '—')}</span>`;
      return `<div class="review-row ${o.ok ? 'good' : 'wrong'}">${flagImg(o.id, 'review-flag')}`
        + `<span class="review-name">${esc(C[o.id]?.name || o.id)}</span>${pickName}`
        + `<span class="review-mark">${o.ok ? '✓' : '✗'}</span></div>`;
    }).join('') + '</div>';
    return;
  }

  el.innerHTML = '<div class="review-list">' + (result.outcomes || []).map((o, r) => {
    const rows = (o.ids || []).map((iso, i) => `<div class="review-row ${o.ok?.[i] ? 'good' : 'wrong'}">`
      + `${flagImg(iso, 'review-flag')}<span class="review-name">${esc(C[iso]?.name || iso)}</span>`
      + `<span class="review-mark">${o.ok?.[i] ? '✓' : '✗'}</span></div>`).join('');
    return `<div class="review-round"><div class="review-round-label">Round ${r + 1}</div>${rows}</div>`;
  }).join('') + '</div>';
}
