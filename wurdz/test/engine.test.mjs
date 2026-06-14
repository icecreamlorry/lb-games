// Quick sanity tests for the deterministic word game engine.
// Run with: node test/engine.test.mjs

import {
  newGameState, applyMove, validatePlacement, replayMoves, makeBag,
  TILE_DISTRIBUTION, BLANK,
} from '../js/engine.js';

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

// Bag composition and determinism
const bag1 = makeBag(42);
const bag2 = makeBag(42);
check('bag has 100 tiles', bag1.length === 100);
check('same seed gives same bag', JSON.stringify(bag1) === JSON.stringify(bag2));
check('different seed gives different bag', JSON.stringify(makeBag(43)) !== JSON.stringify(bag1));
const counts = {};
for (const t of bag1) counts[t] = (counts[t] || 0) + 1;
check('bag matches official distribution', JSON.stringify(counts) === JSON.stringify(
  Object.fromEntries(Object.entries(TILE_DISTRIBUTION).map(([k, v]) => [k, counts[k]]).map(([k]) => [k, TILE_DISTRIBUTION[k]]))
) || Object.entries(TILE_DISTRIBUTION).every(([k, v]) => counts[k] === v));

// Start move deals racks
const seed = 42;
let state = newGameState(seed);
applyMove(state, { move_index: 0, player: 0, type: 'start', payload: {} });
check('both racks have 7 tiles', state.racks[0].length === 7 && state.racks[1].length === 7);
check('bag has 86 tiles after deal', state.bag.length === 86);
check('a first player was chosen', state.turn === 0 || state.turn === 1);
const first = state.turn;

// First placement must cover center
const rack = state.racks[first];
const bad = validatePlacement(state, [
  { r: 0, c: 0, letter: rack[0], blank: false },
  { r: 0, c: 1, letter: rack[1], blank: false },
]);
check('first word off-center rejected', !bad.ok);

const good = validatePlacement(state, [
  { r: 7, c: 7, letter: rack[0], blank: false },
  { r: 7, c: 8, letter: rack[1], blank: false },
]);
check('first word on center accepted', good.ok);
check('center DW doubles first word', good.ok && good.total === good.words[0].tiles.reduce((s, t) => s + t.points, 0) * 2);

// Apply the placement
applyMove(state, {
  move_index: 1, player: first, type: 'place',
  payload: { cells: [
    { r: 7, c: 7, letter: rack[0], blank: false },
    { r: 7, c: 8, letter: rack[1], blank: false },
  ] },
});
check('score recorded', state.scores[first] > 0);
check('rack refilled to 7', state.racks[first].length === 7);
check('turn passed to opponent', state.turn === 1 - first);

// Disconnected placement rejected
const r2 = state.racks[1 - first];
const disc = validatePlacement(state, [
  { r: 0, c: 0, letter: r2[0], blank: false },
  { r: 0, c: 1, letter: r2[1], blank: false },
]);
check('disconnected word rejected', !disc.ok);

// Connected placement accepted (perpendicular through an existing tile)
const conn = validatePlacement(state, [
  { r: 6, c: 7, letter: r2[0], blank: false },
  { r: 8, c: 7, letter: r2[1], blank: false },
]);
check('connected word accepted', conn.ok);

// Exchange keeps tile economy intact
const before = state.bag.length;
const tiles = state.racks[1 - first].slice(0, 2);
applyMove(state, { move_index: 2, player: 1 - first, type: 'exchange', payload: { tiles } });
check('exchange keeps bag size constant', state.bag.length === before);
check('exchange keeps rack at 7', state.racks[1 - first].length === 7);

// Pass-out ending: four consecutive passes (the exchange above reset the
// pass streak, so this counts four fresh passes in a row).
let p = state.turn;
applyMove(state, { move_index: 3, player: p, type: 'pass', payload: {} }); p = 1 - p;
applyMove(state, { move_index: 4, player: p, type: 'pass', payload: {} }); p = 1 - p;
applyMove(state, { move_index: 5, player: p, type: 'pass', payload: {} }); p = 1 - p;
check('game not over at 3 consecutive passes', !state.gameOver);
applyMove(state, { move_index: 6, player: p, type: 'pass', payload: {} });
check('game ends after four consecutive passes', state.gameOver);
check('four-pass ending is flagged byPasses', state.endDetail.byPasses === true);
check('winner decided', state.winner === 0 || state.winner === 1 || state.winner === 'tie');

// Six-scoreless ending: passes interleaved with exchanges never reach four
// consecutive passes, so the game ends on the sixth scoreless turn instead.
let s7 = newGameState(99);
applyMove(s7, { move_index: 0, player: 0, type: 'start', payload: {} });
let q = s7.turn;
for (let i = 1; i <= 6; i++) {
  if (i % 2 === 1) {
    applyMove(s7, { move_index: i, player: q, type: 'pass', payload: {} });
  } else {
    const t = s7.racks[q].slice(0, 1);
    applyMove(s7, { move_index: i, player: q, type: 'exchange', payload: { tiles: t } });
  }
  if (i < 6) check(`mixed game not over at scoreless turn ${i}`, !s7.gameOver);
  q = 1 - q;
}
check('game ends after six scoreless turns', s7.gameOver);
check('six-scoreless ending is not flagged byPasses', s7.endDetail.byPasses === false);

// Replay determinism: same moves => same state
const log = [
  { move_index: 0, player: 0, type: 'start', payload: {} },
];
const sA = replayMoves(seed, log);
const sB = replayMoves(seed, log);
check('replay is deterministic', JSON.stringify(sA) === JSON.stringify(sB));

// Blank tiles score zero
let s3 = newGameState(7);
// Force a known rack for testing blanks
applyMove(s3, { move_index: 0, player: 0, type: 'start', payload: {} });
s3.racks[s3.turn] = ['C', 'A', 'T', BLANK, 'E', 'R', 'S'];
const blankPlay = validatePlacement(s3, [
  { r: 7, c: 7, letter: 'C', blank: false },
  { r: 7, c: 8, letter: 'A', blank: true },  // blank standing in for A
  { r: 7, c: 9, letter: 'T', blank: false },
]);
check('blank placement valid', blankPlay.ok);
check('blank scores zero (CAT with blank A = (3+0+1)*2 = 8)', blankPlay.ok && blankPlay.total === 8);

// Bingo bonus
let s4 = newGameState(9);
applyMove(s4, { move_index: 0, player: 0, type: 'start', payload: {} });
s4.racks[s4.turn] = ['A', 'E', 'I', 'O', 'U', 'L', 'N'];
const bingo = validatePlacement(s4, [
  { r: 7, c: 4, letter: 'A', blank: false },
  { r: 7, c: 5, letter: 'E', blank: false },
  { r: 7, c: 6, letter: 'I', blank: false },
  { r: 7, c: 7, letter: 'O', blank: false },
  { r: 7, c: 8, letter: 'U', blank: false },
  { r: 7, c: 9, letter: 'L', blank: false },
  { r: 7, c: 10, letter: 'N', blank: false },
]);
check('seven-tile play flagged as bingo', bingo.ok && bingo.bingo);
check('bingo adds 50', bingo.ok && bingo.total >= 50);

// Challenge: upheld (word invalid) retracts the play
let s5 = newGameState(11);
applyMove(s5, { move_index: 0, player: 0, type: 'start', payload: {} });
const placer = s5.turn;
const challenger5 = 1 - placer;
s5.racks[placer] = ['Z', 'X', 'Q', 'J', 'K', 'V', 'W'];
const beforeScore = s5.scores[placer];
const beforeBag = s5.bag.length;
applyMove(s5, { move_index: 1, player: placer, type: 'place', payload: { cells: [
  { r: 7, c: 7, letter: 'Z', blank: false },
  { r: 7, c: 8, letter: 'X', blank: false },
] } });
check('place applied (score went up)', s5.scores[placer] > beforeScore);
applyMove(s5, { move_index: 2, player: challenger5, type: 'challenge', payload: { upheld: true, words: ['ZX'], invalid: ['ZX'] } });
check('upheld challenge clears the board', s5.board[7][7] === null && s5.board[7][8] === null);
check('upheld challenge reverts the score', s5.scores[placer] === beforeScore);
check('upheld challenge restores rack to 7', s5.racks[placer].length === 7);
check('upheld challenge restores bag size', s5.bag.length === beforeBag);
check('upheld challenge returns the placed tiles', s5.racks[placer].includes('Z') && s5.racks[placer].includes('X'));
check('upheld challenge gives the turn to the challenger', s5.turn === challenger5);

// Challenge: failed (word valid) costs the challenger their turn
let s6 = newGameState(13);
applyMove(s6, { move_index: 0, player: 0, type: 'start', payload: {} });
const pl6 = s6.turn, ch6 = 1 - pl6;
s6.racks[pl6] = ['C', 'A', 'T', 'S', 'E', 'R', 'N'];
applyMove(s6, { move_index: 1, player: pl6, type: 'place', payload: { cells: [
  { r: 7, c: 7, letter: 'C', blank: false },
  { r: 7, c: 8, letter: 'A', blank: false },
  { r: 7, c: 9, letter: 'T', blank: false },
] } });
const scoreAfterPlace = s6.scores[pl6];
applyMove(s6, { move_index: 2, player: ch6, type: 'challenge', payload: { upheld: false, words: ['CAT'] } });
check('failed challenge keeps the board', s6.board[7][7] && s6.board[7][7].letter === 'C');
check('failed challenge keeps the score', s6.scores[pl6] === scoreAfterPlace);
check('failed challenge returns the turn to the placer', s6.turn === pl6);

console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
