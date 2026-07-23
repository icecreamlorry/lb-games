// Weiqi tutorial runner. Drives the #screen-tutorial DOM: a shared board, a
// teaching panel, and ← / → navigation. Each step's board is rebuilt
// deterministically from the level data (see tutorial-levels.js), so the arrows
// can move back and forth freely and the player can re-read anything.
//
// Locking: on a task step the board only accepts the authored `allow` points,
// and the → arrow stays disabled until the step is solved — so it's always
// clear what to do, and the player can only do what the lesson asks.

import { createBoard } from './board.js';
import { emptyBoard, tryPlay, computeScore, KOMI } from './engine.js';
import { LEVELS } from './tutorial-levels.js';

const $ = (id) => document.getElementById(id);
const DONE_KEY = 'weiqi_tutorial_done';

let board = null;         // the shared board renderer
let onExit = null;        // callback to leave the tutorial screen
let levelIdx = 0;
let stepIdx = 0;
let cleared = new Set();  // step indices solved/seen in the CURRENT level
let workBoard = null;     // live board for the step being solved
let workKo = null;
let solvedNow = false;    // the current task step has just been satisfied

function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); }
  catch { return new Set(); }
}
function markDone(id) {
  const d = loadDone(); d.add(id);
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...d])); } catch { /* ignore */ }
}

const level = () => LEVELS[levelIdx];
const step = () => level().steps[stepIdx];
const seatOf = (task) => (task?.seat === 'white' ? 1 : 0);
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];

function fromSetup(size, setup = {}) {
  const b = emptyBoard(size);
  for (const [r, c] of setup.black || []) b[r][c] = 0;
  for (const [r, c] of setup.white || []) b[r][c] = 1;
  return b;
}

// Rebuild the board as it should look ENTERING step `target` of the level:
// fold every earlier step's setup + solution + replies, then apply the target
// step's own setup. Returns { board, ko }.
function boardEnteringStep(lvl, target) {
  let b = emptyBoard(lvl.size);
  let ko = null;
  for (let i = 0; i <= target; i++) {
    const s = lvl.steps[i];
    if (s.setup) { b = fromSetup(lvl.size, s.setup); ko = null; }
    if (i === target) break;
    const task = s.task;
    if (task && task.type !== 'pass') {
      const seat = seatOf(task);
      const sol = task.solution || task.allow[0];
      const res = tryPlay(b, lvl.size, sol[0], sol[1], seat, ko);
      if (res.ok) {
        b = res.board; ko = res.koPoint;
        for (const rep of task.replies || []) {
          const rr = tryPlay(b, lvl.size, rep[0], rep[1], 1 - seat, ko);
          if (rr.ok) { b = rr.board; ko = rr.koPoint; }
        }
      }
    }
  }
  return { board: b, ko };
}

// Annotations authored on a step, plus a ghost of the solution once solved.
function annotationsFor(s, showSolvedGhost) {
  const ann = {
    marks: s.marks || [], regions: s.regions || [],
    arrows: s.arrows || [], labels: s.labels || [],
    ghosts: [...(s.ghosts || [])],
  };
  return ann;
}

function isTask(s) { return !!s.task; }
function stepCleared(i) { return cleared.has(i); }

export function initTutorial(exitCallback) {
  onExit = exitCallback;
  board = createBoard($('tut-board'), { onPoint: onBoardPoint });

  $('tut-prev').addEventListener('click', () => go(-1));
  $('tut-next').addEventListener('click', () => go(1));
  $('tut-exit').addEventListener('click', () => onExit?.());
  $('tut-menu-btn').addEventListener('click', openLevelMenu);
  $('tut-pass').addEventListener('click', onPass);
  $('tut-levels-close').addEventListener('click', () => $('tut-levels').classList.add('hidden'));
  $('tut-complete-next').addEventListener('click', () => {
    $('tut-complete').classList.add('hidden');
    if (levelIdx + 1 < LEVELS.length) openLevel(levelIdx + 1);
    else openLevelMenu();
  });
  $('tut-complete-menu').addEventListener('click', () => {
    $('tut-complete').classList.add('hidden');
    openLevelMenu();
  });
}

// Entry point from main.js when Training is chosen.
export function openTutorial() {
  buildLevelMenu();
  // Resume at the first not-yet-completed level, else the last one.
  const done = loadDone();
  let start = LEVELS.findIndex((l) => !done.has(l.id));
  if (start < 0) start = 0;
  openLevel(start);
}

function openLevel(i) {
  levelIdx = i;
  stepIdx = 0;
  cleared = new Set();
  $('tut-levels').classList.add('hidden');
  $('tut-complete').classList.add('hidden');
  board.setSize(level().size);
  renderStep();
}

function go(dir) {
  const next = stepIdx + dir;
  if (next < 0) return;
  if (next >= level().steps.length) { finishLevel(); return; }
  // Forward is only allowed once the current step is cleared.
  if (dir > 0 && !stepCleared(stepIdx)) return;
  stepIdx = next;
  renderStep();
}

function finishLevel() {
  markDone(level().id);
  buildLevelMenu();
  $('tut-complete-title').textContent = `${level().title} — complete`;
  const last = levelIdx + 1 >= LEVELS.length;
  $('tut-complete-msg').textContent = last
    ? 'That\'s the whole tutorial! You know enough to play a real game now.'
    : 'Nicely done. Ready for the next lesson?';
  $('tut-complete-next').textContent = last ? 'Back to lessons' : 'Next lesson →';
  $('tut-complete').classList.remove('hidden');
}

function renderStep() {
  const s = step();
  const info = !isTask(s);

  // Info steps count as cleared just by being seen.
  if (info) cleared.add(stepIdx);
  solvedNow = false;

  // Build this step's starting board and (re)show it.
  const entry = boardEnteringStep(level(), stepIdx);
  workBoard = entry.board.map((row) => row.slice());
  workKo = entry.ko;

  const alreadyCleared = stepCleared(stepIdx);
  const ann = annotationsFor(s, alreadyCleared);
  // On a solved/revisited task step, show the solution board so the lesson reads
  // as "done" and the player can study the result.
  if (isTask(s) && alreadyCleared && s.task.type !== 'pass') {
    applySolution(s.task, /* mutateWork */ true);
  }
  board.setInteractive(isTask(s) && !alreadyCleared);
  board.setHover(null, null);
  paint(ann);

  // Panel text + badge.
  $('tut-title').textContent = level().title;
  $('tut-badge').textContent = `Lesson ${levelIdx + 1} of ${LEVELS.length}`;
  $('tut-text').innerHTML = s.text;
  renderStepDots();

  // Feedback line + hint.
  const fb = $('tut-feedback');
  fb.className = 'tut-feedback';
  if (isTask(s) && alreadyCleared) {
    fb.classList.add('good');
    fb.innerHTML = s.task.success ? `✓ ${s.task.success}` : '✓ Done.';
  } else if (isTask(s)) {
    fb.classList.add('hint');
    fb.innerHTML = s.task.hint ? `→ ${s.task.hint}` : '→ Make your move on the board.';
  } else {
    fb.textContent = '';
  }

  // Pass button only on a pass task that isn't solved yet.
  const passStep = isTask(s) && s.task.type === 'pass' && !alreadyCleared;
  $('tut-pass').classList.toggle('hidden', !passStep);

  // Nav arrows.
  $('tut-prev').disabled = stepIdx === 0;
  const canForward = stepCleared(stepIdx);
  $('tut-next').disabled = !canForward;
  $('tut-next').textContent = (stepIdx + 1 >= level().steps.length) ? 'Finish ✓' : '→';
}

function renderStepDots() {
  const wrap = $('tut-steps');
  wrap.innerHTML = '';
  level().steps.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = 'step-dot';
    if (i === stepIdx) dot.classList.add('current');
    else if (stepCleared(i)) dot.classList.add('done');
    wrap.appendChild(dot);
  });
}

function paint(ann) {
  board.render({ board: workBoard, size: level().size, blackSeat: 0, lastMove: null }, ann);
}

// Apply the authored solution (+ replies) to workBoard. Used to show a solved
// step's result and to render revisited steps.
function applySolution(task, mutateWork) {
  const seat = seatOf(task);
  const sol = task.solution || task.allow[0];
  const res = tryPlay(workBoard, level().size, sol[0], sol[1], seat, workKo);
  if (!res.ok) return;
  let b = res.board, ko = res.koPoint;
  for (const rep of task.replies || []) {
    const rr = tryPlay(b, level().size, rep[0], rep[1], 1 - seat, ko);
    if (rr.ok) { b = rr.board; ko = rr.koPoint; }
  }
  if (mutateWork) { workBoard = b; workKo = ko; }
  return { board: b, ko };
}

function onBoardPoint(r, c) {
  const s = step();
  if (!isTask(s) || stepCleared(stepIdx) || s.task.type === 'pass') return;
  const task = s.task;
  const allowed = task.allow.some((p) => eq(p, [r, c]));
  if (!allowed) {
    flash('Not there — play the highlighted point.', 'warn');
    return;
  }
  const seat = seatOf(task);
  const res = tryPlay(workBoard, level().size, r, c, seat, workKo);
  if (!res.ok) { flash(res.error, 'warn'); return; }

  // Optional success predicate.
  if (task.check) {
    const ctx = { r, c, before: workBoard, after: res.board, captured: res.captured, size: level().size };
    if (!task.check(ctx)) {
      flash(task.onWrong || 'Close — but not quite what we\'re after. Try the marked point.', 'warn');
      return; // leave the board as-is; player retries
    }
  }

  // Success: apply the player's move + any scripted replies.
  workBoard = res.board; workKo = res.koPoint;
  const seatReplies = task.replies || [];
  for (const rep of seatReplies) {
    const rr = tryPlay(workBoard, level().size, rep[0], rep[1], 1 - seat, workKo);
    if (rr.ok) { workBoard = rr.board; workKo = rr.koPoint; }
  }
  cleared.add(stepIdx);
  solvedNow = true;
  board.setInteractive(false);
  paint(annotationsFor(s, true));

  const fb = $('tut-feedback');
  fb.className = 'tut-feedback good';
  fb.innerHTML = task.success ? `✓ ${task.success}` : '✓ Correct!';
  $('tut-next').disabled = false;
  $('tut-next').textContent = (stepIdx + 1 >= level().steps.length) ? 'Finish ✓' : 'Next →';
  renderStepDots();
}

function onPass() {
  const s = step();
  if (!isTask(s) || s.task.type !== 'pass') return;
  // Score the shown position and celebrate.
  const sc = computeScore(workBoard, level().size, KOMI, 0);
  cleared.add(stepIdx);
  board.setInteractive(false);
  $('tut-pass').classList.add('hidden');
  const fb = $('tut-feedback');
  fb.className = 'tut-feedback good';
  fb.innerHTML = s.task.success
    ? `✓ ${s.task.success}`
    : `✓ Black ${sc.final[0]} — White ${sc.final[1]}.`;
  $('tut-next').disabled = false;
  $('tut-next').textContent = 'Finish ✓';
  renderStepDots();
}

// Transient feedback that doesn't overwrite a step's standing hint.
let flashTimer = null;
function flash(msg, kind) {
  const fb = $('tut-feedback');
  fb.className = `tut-feedback ${kind || ''}`;
  fb.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (!stepCleared(stepIdx)) renderHintLine(); }, 2600);
}
function renderHintLine() {
  const s = step();
  const fb = $('tut-feedback');
  if (isTask(s) && !stepCleared(stepIdx)) {
    fb.className = 'tut-feedback hint';
    fb.innerHTML = s.task.hint ? `→ ${s.task.hint}` : '→ Make your move on the board.';
  }
}

// ---- Level menu ------------------------------------------------------------

function buildLevelMenu() {
  const list = $('tut-levels-list');
  if (!list) return;
  const done = loadDone();
  list.innerHTML = '';
  LEVELS.forEach((lvl, i) => {
    const btn = document.createElement('button');
    btn.className = 'tut-level-item';
    if (done.has(lvl.id)) btn.classList.add('done');
    btn.innerHTML = `<span class="tl-num">${i + 1}</span>`
      + `<span class="tl-name">${lvl.title}</span>`
      + `<span class="tl-tick">${done.has(lvl.id) ? '✓' : ''}</span>`;
    btn.addEventListener('click', () => openLevel(i));
    list.appendChild(btn);
  });
}

function openLevelMenu() {
  buildLevelMenu();
  $('tut-levels').classList.remove('hidden');
}
