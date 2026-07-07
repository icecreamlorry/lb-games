// The five Atlaz game modes. Each controller drives the shared map + the DOM
// panels in index.html; main.js owns rooms/timing/results. Controllers get a
// ctx and report back through ctx.onFinish(result):
//
//   ctx = {
//     map,                 // AtlazMap
//     region,              // region JSON (items with id/name/alt/d/cx/cy/bbox)
//     order,               // seeded question order (item ids) — same all seats
//     startedAt,           // epoch ms of the reveal; ms elapsed derives from it
//     restore,             // saved progress {idx, outcomes|found} or null
//     onProgress(state),   // persist progress (resume after refresh)
//     onStatus(msg),       // transient status line
//     onFinish(result),    // { outcomes, foundCount, total, ms, gaveUp }
//   }
//
// A result's `outcomes` is [{ id, ok }] in question order (sweep: found ids),
// which is exactly what renderReview() needs to redraw any player's attempt.

import { buildAnswerIndex, matchAnswer, jigsawHit, bboxCenter } from './engine.js';

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PANELS = ['panel-confirm', 'panel-options', 'panel-typing', 'panel-sweep', 'panel-tray'];

export function showPanel(id) {
  for (const p of PANELS) $(p).classList.toggle('hidden', p !== id);
}

export function hidePanels() { showPanel(null); }

function setPrompt(main, sub = '') {
  $('prompt-line').textContent = main || '';
  $('prompt-sub').textContent = sub || '';
}

// Zoom in on small targets so "which one is highlighted?" is answerable;
// leave big ones in the full-region view.
function frameTarget(map, region, item) {
  map.resetView();
  const diag = Math.hypot(item.bbox[2] - item.bbox[0], item.bbox[3] - item.bbox[1]);
  if (diag < 0.14 * Math.hypot(region.w, region.h)) map.zoomToItem(item.id, 0.28);
}

export function createMode(modeId, ctx) {
  const make = { pinpoint, lineup, namedrop, jigsaw, sweep }[modeId];
  if (!make) throw new Error(`Unknown mode ${modeId}`);
  const ac = new AbortController();
  const ctl = make(ctx, ac.signal);
  return {
    start: ctl.start,
    destroy() { ac.abort(); ctl.destroy?.(); hidePanels(); setPrompt(''); },
  };
}

// ---- Shared question-runner for the four ask-one-at-a-time modes ------------

function runner(ctx, hooks, signal) {
  const { map, region, order } = ctx;
  const items = new Map(region.items.map((it) => [it.id, it]));
  const st = {
    idx: 0,
    outcomes: [],
    grading: false,
    done: false,
  };
  if (ctx.restore && Array.isArray(ctx.restore.outcomes)) {
    st.outcomes = ctx.restore.outcomes.filter((o) => o && items.has(o.id));
    st.idx = st.outcomes.length;
  }

  function target() { return items.get(order[st.idx]); }
  function paintOutcome(o) {
    map.setState(o.id, o.ok ? 'ok' : 'bad');
    if (hooks.placed) map.setState(o.id, 'placed');
    map.label(o.id, o.ok ? 'ok' : 'bad');
  }

  async function grade(ok, pick = null) {
    if (st.grading || st.done || signal.aborted) return;
    st.grading = true;
    const t = target();
    const o = { id: t.id, ok };
    if (pick && pick !== t.id) o.pick = pick;
    st.outcomes.push(o);
    paintOutcome(o);
    if (!ok && pick && pick !== t.id) map.flash(pick);
    ctx.onStatus(ok ? `✓ ${t.name}` : `✗ It was ${t.name}`);
    ctx.onProgress({ idx: st.outcomes.length, outcomes: st.outcomes });
    await delay(ok ? 650 : 1250);
    if (signal.aborted) return;
    st.idx = st.outcomes.length;
    st.grading = false;
    next();
  }

  function next() {
    if (signal.aborted || st.done) return;
    ctx.onStatus('');
    if (st.idx >= order.length) {
      st.done = true;
      hooks.end?.();
      const correct = st.outcomes.filter((o) => o.ok).length;
      ctx.onFinish({
        outcomes: st.outcomes, foundCount: correct, total: order.length,
        ms: Date.now() - ctx.startedAt, gaveUp: false,
      });
      return;
    }
    hooks.ask(target());
  }

  function start() {
    // Repaint any restored progress before continuing.
    for (const o of st.outcomes) paintOutcome(o);
    hooks.begin?.();
    next();
  }

  return { st, grade, start, target };
}

// ---- Mode 1: PINPOINT — name shown, tap the territory ------------------------

function pinpoint(ctx, signal) {
  const { map, region } = ctx;
  let selected = null;
  const btn = $('btn-confirm');

  const run = runner(ctx, {
    begin() { showPanel('panel-confirm'); },
    ask(t) {
      selected = null;
      map.clearState('sel');
      btn.disabled = true;
      setPrompt(t.name, `Tap it on the map · ${run.st.idx + 1} / ${ctx.order.length}`);
    },
  }, signal);

  map.onTap = (id) => {
    if (run.st.grading || run.st.done || !id) return;
    selected = id;
    map.clearState('sel');
    map.setState(id, 'sel');
    btn.disabled = false;
  };

  btn.addEventListener('click', () => {
    if (!selected || run.st.grading) return;
    const pick = selected;
    map.clearState('sel');
    btn.disabled = true;
    run.grade(pick === run.target().id, pick);
  }, { signal });

  return { start: run.start, destroy() { map.onTap = null; map.clearState('sel'); } };
}

// ---- Mode 2: LINE-UP — territory highlighted, pick from remaining names ------

function lineup(ctx, signal) {
  const { map, region, order } = ctx;
  const list = $('options-list');
  const items = new Map(region.items.map((it) => [it.id, it]));

  const run = runner(ctx, {
    begin() { showPanel('panel-options'); },
    ask(t) {
      map.clearState('sel');
      map.setState(t.id, 'sel');
      frameTarget(map, region, t);
      setPrompt('Which one is highlighted?', `${run.st.idx + 1} / ${order.length}`);
      // Remaining names = every question not yet asked (this one included).
      const remaining = order.slice(run.st.idx).map((id) => items.get(id))
        .sort((a, b) => a.name.localeCompare(b.name));
      list.innerHTML = '';
      for (const it of remaining) {
        const b = document.createElement('button');
        b.className = 'option-btn';
        b.textContent = it.name;
        b.addEventListener('click', () => {
          if (run.st.grading) return;
          map.clearState('sel');
          run.grade(it.id === run.target().id, it.id);
        }, { signal });
        list.appendChild(b);
      }
      list.scrollTop = 0;
    },
    end() { map.resetView(); },
  }, signal);

  return { start: run.start, destroy() { map.clearState('sel'); } };
}

// ---- Mode 3: NAMEDROP — territory highlighted, type its name -----------------

function namedrop(ctx, signal) {
  const { map, region, order } = ctx;
  const input = $('answer-input');
  const index = buildAnswerIndex(region.items);

  const run = runner(ctx, {
    begin() { showPanel('panel-typing'); input.value = ''; },
    ask(t) {
      map.clearState('sel');
      map.setState(t.id, 'sel');
      frameTarget(map, region, t);
      setPrompt('Name the highlighted one', `${run.st.idx + 1} / ${order.length}`);
      input.value = '';
      input.focus({ preventScroll: true });
    },
    end() { map.resetView(); },
  }, signal);

  function submit() {
    if (run.st.grading || run.st.done) return;
    const raw = input.value.trim();
    if (!raw) return;
    map.clearState('sel');
    const picked = matchAnswer(index, raw);
    run.grade(picked === run.target().id, picked ?? undefined);
  }
  $('btn-answer').addEventListener('click', submit, { signal });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }, { signal });

  return { start: run.start, destroy() { map.clearState('sel'); } };
}

// ---- Mode 4: JIGSAW — drag the shown piece onto the borderless region --------

function jigsaw(ctx, signal) {
  const { map, region, order } = ctx;
  const tray = $('tray-piece');
  const nameEl = $('tray-name');
  let ghost = null;

  const run = runner(ctx, {
    placed: true,
    begin() {
      showPanel('panel-tray');
      map.silhouette(true);
    },
    ask(t) {
      setPrompt('Drag the piece into place', `${run.st.idx + 1} / ${order.length}`);
      nameEl.textContent = t.name;
      // Mini preview: the piece path in its own bbox-fitted viewBox.
      const [x0, y0, x1, y1] = t.bbox;
      const pad = Math.max((x1 - x0), (y1 - y0)) * 0.06 + 1;
      tray.innerHTML = `<svg viewBox="${x0 - pad} ${y0 - pad} ${(x1 - x0) + 2 * pad} ${(y1 - y0) + 2 * pad}" class="tray-svg"><path d="${t.d}"/></svg>`;
    },
    end() { map.silhouette(false); map.resetView(); },
  }, signal);

  function dragStart(e) {
    if (run.st.grading || run.st.done || ghost) return;
    const t = run.target();
    if (!t) return;
    e.preventDefault();
    const ppu = map.pxPerUnit();
    const [x0, y0, x1, y1] = t.bbox;
    const w = Math.max((x1 - x0) * ppu, 14), h = Math.max((y1 - y0) * ppu, 14);
    ghost = document.createElement('div');
    ghost.className = 'jigsaw-ghost';
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h}px`;
    ghost.innerHTML = `<svg viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" width="${w}" height="${h}"><path d="${t.d}"/></svg>`;
    document.body.appendChild(ghost);
    moveGhost(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  function moveGhost(x, y) {
    if (!ghost) return;
    ghost.style.left = `${x - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${y - ghost.offsetHeight / 2}px`;
  }
  const onMove = (e) => moveGhost(e.clientX, e.clientY);
  function onUp(e) {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (ghost) { ghost.remove(); ghost = null; }
    if (run.st.grading || run.st.done) return;
    const rect = map.svg.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) { ctx.onStatus('Dropped outside the map — try again.'); return; }
    const [mx, my] = map.clientToMap(e.clientX, e.clientY);
    const t = run.target();
    run.grade(jigsawHit(t, mx, my, region.w, region.h));
  }
  tray.addEventListener('pointerdown', dragStart, { signal });

  return {
    start: run.start,
    destroy() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      ghost?.remove(); ghost = null;
      map.silhouette(false);
    },
  };
}

// ---- Mode 5: SWEEP — type every name, give up allowed ------------------------

function sweep(ctx, signal) {
  const { map, region, order } = ctx;
  const input = $('sweep-input');
  const giveupBtn = $('btn-giveup');
  const countEl = $('sweep-count');
  const index = buildAnswerIndex(region.items);
  const names = new Map(region.items.map((it) => [it.id, it.name]));
  const found = new Set(ctx.restore?.found?.filter((id) => names.has(id)) || []);
  let done = false;
  let armTimer = null;

  function updateCount() {
    countEl.textContent = `${found.size} / ${order.length}`;
  }

  function finish(gaveUp) {
    if (done) return;
    done = true;
    clearTimeout(armTimer);
    // Reveal what was missed (red-dim + label) so giving up teaches you.
    for (const it of region.items) {
      if (!found.has(it.id)) { map.setState(it.id, 'bad'); map.label(it.id, 'bad'); }
    }
    ctx.onFinish({
      outcomes: [...found].map((id) => ({ id, ok: true })),
      foundCount: found.size, total: order.length,
      ms: Date.now() - ctx.startedAt, gaveUp,
    });
  }

  function tryMatch() {
    if (done) return;
    const id = matchAnswer(index, input.value);
    if (!id) return;
    if (found.has(id)) {
      // Don't clear the box: the text may be the start of another answer
      // ("UK" already found while typing "Ukraine").
      ctx.onStatus(`Already got ${names.get(id)}.`);
      return;
    }
    found.add(id);
    map.setState(id, 'ok');
    map.label(id, 'ok');
    input.value = '';
    ctx.onStatus(`✓ ${names.get(id)}`);
    updateCount();
    ctx.onProgress({ found: [...found] });
    if (found.size >= order.length) finish(false);
  }

  function start() {
    showPanel('panel-sweep');
    const kind = region.kind === 'countries' ? 'country' : 'state or county';
    setPrompt(`Name every ${kind}!`, 'They light up as you type them');
    for (const id of found) { map.setState(id, 'ok'); map.label(id, 'ok'); }
    updateCount();
    giveupBtn.textContent = 'GIVE UP';
    giveupBtn.classList.remove('armed');
    input.value = '';
    input.focus({ preventScroll: true });
  }

  input.addEventListener('input', tryMatch, { signal });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryMatch(); }, { signal });
  giveupBtn.addEventListener('click', () => {
    if (done) return;
    if (!giveupBtn.classList.contains('armed')) {
      giveupBtn.classList.add('armed');
      giveupBtn.textContent = 'SURE?';
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        giveupBtn.classList.remove('armed');
        giveupBtn.textContent = 'GIVE UP';
      }, 2600);
      return;
    }
    finish(true);
  }, { signal });

  return { start, destroy() { clearTimeout(armTimer); } };
}

// ---- End-of-game review -------------------------------------------------------
// Redraws any player's submitted attempt onto the map (used for your own final
// map and for other players' via their result moves). For sweep, everything
// not in `outcomes` is shown as missed.

export function renderReview(map, region, mode, result) {
  map.clearAll();
  map.silhouette(false);
  map.resetView();
  hidePanels();
  if (!result) return;
  const seen = new Set();
  for (const o of result.outcomes || []) {
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    map.setState(o.id, o.ok ? 'ok' : 'bad');
    map.label(o.id, o.ok ? 'ok' : 'bad');
  }
  if (mode === 'sweep') {
    for (const it of region.items) {
      if (!seen.has(it.id)) { map.setState(it.id, 'bad'); map.label(it.id, 'bad'); }
    }
  }
}
