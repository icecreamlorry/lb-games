// Run: node weiqi/test/tutorial.test.mjs
// Walks every tutorial level with the real engine, reconstructing each step's
// board exactly as the runner does, and asserts that every authored solution is
// legal, listed in `allow`, and satisfies its success check — and that scripted
// opponent replies are legal too. Catches authoring mistakes before the UI runs.
import { emptyBoard, tryPlay } from '../js/engine.js';
import { LEVELS } from '../js/tutorial-levels.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

function fromSetup(size, setup = {}) {
  const b = emptyBoard(size);
  for (const [r, c] of setup.black || []) b[r][c] = 0;
  for (const [r, c] of setup.white || []) b[r][c] = 1;
  return b;
}
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];

for (const level of LEVELS) {
  const S = level.size;
  let board = emptyBoard(S);
  let ko = null;
  level.steps.forEach((step, i) => {
    const where = `${level.id} step ${i + 1}`;
    if (step.setup) { board = fromSetup(S, step.setup); ko = null; }

    // Sanity-check annotation coordinates fall on the board.
    for (const a of [...(step.marks || []), ...(step.ghosts || []), ...(step.labels || [])]) {
      ok(a.r >= 0 && a.r < S && a.c >= 0 && a.c < S, `${where}: annotation on board`);
    }

    const task = step.task;
    if (!task) return;
    if (task.type === 'pass') return; // nothing to place

    const seat = task.seat === 'white' ? 1 : 0;
    const sol = task.solution || task.allow[0];
    ok(task.allow.some((p) => eq(p, sol)), `${where}: solution is one of the allowed points`);
    for (const [ar, ac] of task.allow) {
      ok(board[ar]?.[ac] === null, `${where}: allowed point (${ar},${ac}) is empty on entry`);
    }

    const res = tryPlay(board, S, sol[0], sol[1], seat, ko);
    ok(res.ok, `${where}: solution ${JSON.stringify(sol)} is a legal move${res.ok ? '' : ' — ' + res.error}`);
    if (!res.ok) return;

    if (task.check) {
      const ctx = { r: sol[0], c: sol[1], before: board, after: res.board, captured: res.captured, size: S };
      ok(task.check(ctx), `${where}: solution satisfies its success check`);
    }

    board = res.board; ko = res.koPoint;
    for (const rep of task.replies || []) {
      const rr = tryPlay(board, S, rep[0], rep[1], 1 - seat, ko);
      ok(rr.ok, `${where}: reply ${JSON.stringify(rep)} is legal${rr.ok ? '' : ' — ' + rr.error}`);
      if (!rr.ok) return;
      board = rr.board; ko = rr.koPoint;
    }
  });
}

console.log(`\nweiqi tutorial: ${pass} passed, ${fail} failed across ${LEVELS.length} levels`);
process.exit(fail ? 1 : 0);
