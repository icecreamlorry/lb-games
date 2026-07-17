// The six Buffz game modes. Controllers drive the question stage (#q-stage) +
// the DOM panels; main.js owns rooms/timing/results. ctx:
//
//   ctx = {
//     data,               // titles.json content
//     mode, rounds,       // from engine.buildRounds (identical for all seats)
//     startedAt,          // epoch ms of the reveal
//     restore,            // saved progress { outcomes } or null
//     onProgress(state), onStatus(msg),
//     onFinish(result),   // { outcomes, score, total, ms }
//   }
//
// Pick modes outcomes: [{ pick, ok }] per round — tiny on purpose: rounds are
// deterministic, so the review regenerates them and looks the answers up.
// Order modes outcomes: [{ ids, ok: [bool per slot] }] per round.

import { gradeOrder, expectedOrder, isOrderMode } from './engine.js';

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PANELS = ['panel-options', 'panel-confirm'];
export function showPanel(id) {
  for (const p of PANELS) $(p).classList.toggle('hidden', p !== id);
}
export function hidePanels() { showPanel(null); }

function setPrompt(main, sub = '') {
  $('prompt-line').textContent = main || '';
  $('prompt-sub').textContent = sub || '';
}

function stage() { return $('q-stage'); }

export function createMode(modeId, ctx) {
  const ac = new AbortController();
  const ctl = isOrderMode(modeId) ? orderMode(ctx, ac.signal) : pickMode(ctx, ac.signal);
  return {
    start: ctl.start,
    destroy() { ac.abort(); ctl.destroy?.(); hidePanels(); setPrompt(''); stage().innerHTML = ''; },
  };
}

// ---- Pick modes (MIXED / PLOTLINES / CASTING / DETAILS) -----------------------

function pickMode(ctx, signal) {
  const { rounds } = ctx;
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
    st.outcomes.push({ pick, ok });
    ctx.onProgress({ outcomes: st.outcomes });

    const card = stage().querySelector('.q-card');
    card?.classList.add('graded', ok ? 'ok' : 'bad');
    for (const b of document.querySelectorAll('#options-list .option-btn')) {
      const i = Number(b.dataset.i);
      if (i === round.answer) b.classList.add('good');
      else if (i === pick) b.classList.add('wrong');
      else b.classList.add('dim');
    }
    // The fact line is the learning moment either way.
    ctx.onStatus(`${ok ? '✓' : '✗'} ${round.fact}`);
    await delay(ok ? 900 : 1700);
    if (signal.aborted) return;
    st.idx++;
    st.grading = false;
    ctx.onStatus('');
    next();
  }

  function ask() {
    const round = rounds[st.idx];
    const progress = `Question ${st.idx + 1} / ${rounds.length}`;
    // With a quote, the card carries the quote and the bar asks the question;
    // without one, the question itself IS the card.
    if (round.quote) {
      setPrompt(round.prompt, progress);
      stage().innerHTML = `<div class="q-card quote"><div class="q-text">${esc(round.quote)}</div></div>`;
    } else {
      setPrompt('', progress);
      stage().innerHTML = `<div class="q-card"><div class="q-text">${esc(round.prompt)}</div></div>`;
    }
    showPanel('panel-options');
    const list = $('options-list');
    list.innerHTML = '';
    round.options.forEach((text, i) => {
      const b = document.createElement('button');
      b.className = 'option-btn';
      b.dataset.i = i;
      b.textContent = text;
      b.addEventListener('click', () => { if (!st.grading) grade(i); }, { signal });
      list.appendChild(b);
    });
    list.scrollTop = 0;
  }

  function next() {
    if (signal.aborted || st.done) return;
    if (st.idx >= rounds.length) { finish(); return; }
    ask();
  }

  return { start: next, destroy() {} };
}

// ---- TIMELINE / RANKED (drag into order) ---------------------------------------
// The Flagz/Atomyx drag list, scroll rules intact: draggable rows leave a 56px
// gutter with touch-action none; graded rows go full-width, touch-action auto.

const ORDER_HINT = {
  timeline: 'Drag into release order — oldest at the top',
  ranked: 'Drag into TMDb rating order — lowest at the top',
};

function orderMode(ctx, signal) {
  const { data, mode, rounds } = ctx;
  const T = data.items;
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

  const valOf = (id) => (mode === 'timeline' ? String(T[id].year) : T[id].rating.toFixed(1));

  function ask() {
    st.revealed = false;
    const round = rounds[st.idx];
    setPrompt(ORDER_HINT[mode], `Round ${st.idx + 1} / ${rounds.length} · ${round.ids.length} titles`);
    showPanel('panel-confirm');
    btn.textContent = 'CONFIRM ORDER';
    btn.disabled = false;
    stage().innerHTML = `<div class="order-list">`
      + round.ids.map((id) => `<div class="order-row" data-id="${id}">`
        + `<span class="order-grip">⠿</span>`
        + `<span class="order-text"><span class="order-name">${esc(T[id].title)}</span><span class="order-val"></span></span></div>`).join('')
      + '</div>';
    for (const row of stage().querySelectorAll('.order-row')) {
      row.addEventListener('pointerdown', (e) => beginDrag(e, row), { signal });
    }
  }

  // Pointer-drag vertical reorder — carried over from Flagz verbatim (see the
  // comment there about re-homing from the current in-flow slot).
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

    // Auto-scroll when the finger nears an edge, so long lists (marathon)
    // that overflow the viewport can be reordered end to end.
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
    const ok = gradeOrder(mode, placed, T);
    st.outcomes.push({ ids: placed, ok });
    ctx.onProgress({ outcomes: st.outcomes });
    st.revealed = true;
    const rows = stage().querySelectorAll('.order-row');
    placed.forEach((id, i) => {
      const row = rows[i];
      row.classList.add(ok[i] ? 'good' : 'wrong');
      // The grip becomes a ✓/✗ so right/wrong reads without relying on colour.
      row.querySelector('.order-grip').textContent = ok[i] ? '✓' : '✗';
      row.querySelector('.order-val').textContent = valOf(id);
    });
    const got = ok.filter(Boolean).length;
    // Show where each title should have gone when the round went poorly.
    const expected = expectedOrder(mode, placed, T);
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

// ---- End-of-game review --------------------------------------------------------
// Rounds are deterministic, so any player's tiny { pick, ok } outcomes replay
// against the same regenerated rounds.

export function renderReview(data, mode, rounds, result) {
  hidePanels();
  setPrompt('');
  const T = data.items;
  const el = stage();
  if (!result) { el.innerHTML = ''; return; }

  if (!isOrderMode(mode)) {
    el.innerHTML = '<div class="review-list">' + (result.outcomes || []).map((o, i) => {
      const round = rounds[i];
      if (!round) return '';
      const yours = o.ok ? '' : `<span class="review-pick">you: ${esc(round.options[o.pick] ?? '—')}</span>`;
      return `<div class="review-row ${o.ok ? 'good' : 'wrong'}">`
        + `<span class="review-body"><span class="review-q">${esc(round.quote || round.prompt)}</span>`
        + `<span class="review-name">${esc(round.options[round.answer])}</span>${yours}</span>`
        + `<span class="review-mark">${o.ok ? '✓' : '✗'}</span></div>`;
    }).join('') + '</div>';
    return;
  }

  el.innerHTML = '<div class="review-list">' + (result.outcomes || []).map((o, r) => {
    const rows = (o.ids || []).map((id, i) => `<div class="review-row ${o.ok?.[i] ? 'good' : 'wrong'}">`
      + `<span class="review-body"><span class="review-name">${esc(T[id]?.title || id)}</span>`
      + `<span class="review-pick">${mode === 'timeline' ? T[id]?.year : T[id]?.rating.toFixed(1)}</span></span>`
      + `<span class="review-mark">${o.ok?.[i] ? '✓' : '✗'}</span></div>`).join('');
    return `<div class="review-round"><div class="review-round-label">Round ${r + 1}</div>${rows}</div>`;
  }).join('') + '</div>';
}
