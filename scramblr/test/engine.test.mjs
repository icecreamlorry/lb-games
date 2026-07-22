// Run: node scramblr/test/engine.test.mjs
import {
  makeBoard, CELLS, adjacent, validPath, wordFromPath, wordPoints, canForm, standings, solveBoard,
} from '../js/engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

// Deterministic board from seed.
const b1 = makeBoard(12345);
const b2 = makeBoard(12345);
ok(b1.length === CELLS, 'board has 16 tiles');
ok(JSON.stringify(b1) === JSON.stringify(b2), 'same seed -> identical board');
ok(JSON.stringify(makeBoard(1)) !== JSON.stringify(makeBoard(2)), 'different seeds differ');

// Adjacency on the 4x4 grid.
ok(adjacent(0, 1) && adjacent(0, 4) && adjacent(0, 5), 'corner neighbours');
ok(!adjacent(0, 2) && !adjacent(3, 4), 'non-neighbours');
ok(!adjacent(5, 5), 'a cell is not adjacent to itself');

// Path validity.
ok(validPath([0, 1, 2, 6]), 'valid adjacent path');
ok(!validPath([0, 1, 0]), 'repeated cell is invalid');
ok(!validPath([0, 2]), 'non-adjacent step is invalid');

// Word forming + scoring on a controlled board.
const board = 'ABCDEFGHIJKLMNOP'.split(''); // row-major A..P
ok(wordFromPath(board, [0, 1, 2]) === 'ABC', 'word from path');
ok(canForm(board, 'ABC'), 'ABC is formable (0-1-2)');
ok(canForm(board, 'AFK'), 'diagonal AFK is formable (0-5-10)');
ok(!canForm(board, 'ACE'), 'ACE not formable (A-C not adjacent)');
ok(!canForm(board, 'ABA'), 'cannot reuse a cell');

// QU tile counts as two letters.
const qb = ['QU', 'I', 'T', 'S', ...Array(12).fill('X')]; // QU(0) I(1) T(2) S(3)
ok(canForm(qb, 'QUIT'), 'QU tile forms QUIT across 0-1-2');
ok(wordPoints('QUIT') === 1, 'QUIT (4 letters) scores 1');
ok(wordPoints('AB') === 0 && wordPoints('CAT') === 1 && wordPoints('BOARD') === 2, 'length scoring');
ok(wordPoints('LETTERS') === 5 && wordPoints('NOTEPADS') === 11, 'long-word scoring');

// Standings with classic dedup (any uppercase counts as a word here).
const anyWord = () => true;
const s = standings(board, anyWord, [
  ['ABC', 'ABFE'],   // seat 0: ABC (shared, cancels) + ABFE unique
  ['ABC', 'GKLP'],   // seat 1: ABC (shared) + GKLP unique
]);
ok(s[0].total === 2 && s[1].total === 2, 'each seat has 2 valid words');
ok(s[0].unique === 1 && s[1].unique === 1, 'shared word cancelled, one unique each');
ok(s[0].score === wordPoints('ABFE') && s[1].score === wordPoints('GKLP'), 'dedup scoring');

// --- solveBoard: prefix-pruned Boggle solver -------------------------------
// A tiny fake dictionary + its prefix oracle, so the solver is tested without
// the real 170k word list.
const mini = new Set(['CAT', 'CATS', 'CAB', 'ARC', 'ACT', 'TAB', 'ABC', 'DOG']);
const sortedMini = [...mini].sort();
const miniIsWord = (w) => mini.has(w);
const miniHasPrefix = (p) => {
  let lo = 0, hi = sortedMini.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (sortedMini[m] < p) lo = m + 1; else hi = m; }
  return lo < sortedMini.length && sortedMini[lo].startsWith(p);
};

// Board with C A B on a diagonal-friendly layout: C(0) A(1) T(2) S(3) / B(4)...
//   row0: C A T S   row1: B . . .
const solveB = ['C', 'A', 'T', 'S', 'B', '.', '.', '.', ...Array(8).fill('.')];
const solved = solveBoard(solveB, miniIsWord, miniHasPrefix);
ok(solved.has('CAT'), 'solveBoard finds CAT (0-1-2)');
ok(solved.has('CATS'), 'solveBoard finds CATS (0-1-2-3)');
ok(solved.has('CAB'), 'solveBoard finds CAB (0-1-4, B is diagonal to A)');
ok(solved.has('TAB'), 'solveBoard finds TAB (2-1-4)');
ok(!solved.has('DOG'), 'solveBoard omits DOG (letters absent)');
ok(!solved.has('AB'), 'solveBoard omits sub-MIN_WORD words');
ok(!solved.has('ACT'), 'solveBoard omits ACT (C-T not adjacent, unformable)');
// Every returned word really is a dictionary word and formable on the board.
for (const w of solved) ok(miniIsWord(w) && canForm(solveB, w), `solved word ${w} is valid + formable`);

// QU tile: a two-letter tile still solves correctly.
const quMini = new Set(['QUIT', 'QUITS', 'IT', 'ITS']);
const quSorted = [...quMini].sort();
const quHasPrefix = (p) => { let lo = 0, hi = quSorted.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (quSorted[m] < p) lo = m + 1; else hi = m; } return lo < quSorted.length && quSorted[lo].startsWith(p); };
const quBoard = ['QU', 'I', 'T', 'S', ...Array(12).fill('.')];
const quSolved = solveBoard(quBoard, (w) => quMini.has(w), quHasPrefix);
ok(quSolved.has('QUIT') && quSolved.has('QUITS'), 'solveBoard handles the QU tile');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
