// Tests for the UpWurdz (Upwords rules) mode of the engine.
// Run with: node test/upwurdz.test.mjs

import {
  newGameState, applyMove, validatePlacement, replayMoves, makeBag,
  UP_TILE_DISTRIBUTION, UP_BOARD_SIZE,
} from '../js/engine.js';

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

const total = Object.values(UP_TILE_DISTRIBUTION).reduce((a, b) => a + b, 0);
check('Upwords set has 100 tiles', total === 100 && makeBag(1, 'upwurdz').length === 100);
check('no blanks in the Upwords set', !makeBag(1, 'upwurdz').includes('_'));

// A started game with hand-set racks, so plays are predictable.
function game(seed = 7) {
  const s = newGameState(seed);
  applyMove(s, { move_index: 0, player: 0, type: 'start', payload: { mode: 'upwurdz' } });
  return s;
}
let s = game();
check('start switches to a 10×10 board', s.mode === 'upwurdz' && s.size === UP_BOARD_SIZE
  && s.board.length === 10 && s.board[0].length === 10);
check('deals 7 each from the 100-tile set', s.racks[0].length === 7 && s.bag.length === 86);

const at = (r, c, letter) => ({ r, c, letter, blank: false });
function play(state, player, cells) {
  state.turn = player;
  state.racks[player] = [...cells.map((p) => p.letter), 'Z', 'Z'].slice(0, 7);
  applyMove(state, { move_index: state.moveCount, player, type: 'place', payload: { cells } });
  return state.lastMove;
}

check('first word must cover a centre square',
  !validatePlacement(s, [at(0, 0, 'C'), at(0, 1, 'A'), at(0, 2, 'T')]).ok);
const cat = [at(4, 3, 'C'), at(4, 4, 'A'), at(4, 5, 'T')];
const v = validatePlacement(s, cat);
check('CAT on the centre is valid', v.ok);
check('flat word scores 2 a tile', v.ok && v.total === 6);

let lm = play(s, 0, cat);
check('CAT scored 6', lm.score === 6 && s.scores[0] === 6);

// Stack O on A: CAT -> COT. Stacked word = sum of heights: 1 + 2 + 1.
const cot = validatePlacement(s, [at(4, 4, 'O')]);
check('stacking a letter is allowed', cot.ok);
check('stacked word scores the stack heights', cot.ok && cot.words[0].word === 'COT' && cot.total === 4);
check('same letter on same letter is rejected', !validatePlacement(s, [at(4, 4, 'A')]).ok);
check('covering a whole word is rejected',
  !validatePlacement(s, [at(4, 3, 'D'), at(4, 4, 'O'), at(4, 5, 'G')]).ok);
check('covering two of three letters is fine',
  validatePlacement(s, [at(4, 3, 'D'), at(4, 4, 'O')]).ok);

lm = play(s, 1, [at(4, 4, 'O')]);
check('stack height recorded', s.board[4][4].h === 2 && s.board[4][4].letter === 'O');

// Challenge (upheld) lifts the O back off and restores the A underneath.
applyMove(s, { move_index: s.moveCount, player: 0, type: 'challenge', payload: { upheld: true, invalid: ['COT'] } });
check('upheld challenge restores the covered tile', s.board[4][4].letter === 'A' && s.board[4][4].h === 1);
check('upheld challenge refunds the score', s.scores[1] === 0);

// Height cap: stack to 5 then refuse a 6th.
s = game();
play(s, 0, cat);
const letters = ['B', 'C', 'D', 'E'];
letters.forEach((l, i) => play(s, i % 2, [at(4, 4, l)]));
check('stack reaches 5', s.board[4][4].h === 5);
check('a sixth tile is refused', !validatePlacement(s, [at(4, 4, 'F')]).ok);

// Qu bonus: a flat word with the Q tile, spelled QU.
s = game();
const quit = validatePlacement(s, [at(4, 4, 'Q'), at(4, 5, 'I'), at(4, 6, 'T')]);
check('Q tile spells QU', quit.ok && quit.words[0].word === 'QUIT');
check('flat Qu word gets +2', quit.ok && quit.total === 8);

// Bingo is +20 in UpWurdz.
s = game();
const seven = 'ABCDEFG'.split('').map((l, i) => at(4, i + 1, l));
const b = validatePlacement(s, seven);
check('seven-tile play earns +20', b.ok && b.bingo && b.total === 14 + 20);

// End: leftovers cost 5 each, the player going out gains nothing.
s = game();
s.bag = [];
s.turn = 0;
s.racks[0] = ['C', 'A', 'T'];
s.racks[1] = ['X', 'Y'];
applyMove(s, { move_index: s.moveCount, player: 0, type: 'place', payload: { cells: cat } });
check('going out ends the game', s.gameOver && s.endDetail.reason === 'out');
check('leftover tiles cost 5 each, no transfer', s.scores[0] === 6 && s.scores[1] === -10);

// Replay determinism through the start payload.
const moves = [
  { move_index: 0, player: 0, type: 'start', payload: { mode: 'upwurdz' } },
  { move_index: 1, player: 0, type: 'pass', payload: {} },
];
const r1 = replayMoves(9, moves), r2 = replayMoves(9, moves);
check('replay builds the UpWurdz board', r1.mode === 'upwurdz' && r1.size === 10);
check('replay is deterministic', JSON.stringify(r1.racks) === JSON.stringify(r2.racks));
check('classic start stays classic', replayMoves(9, [moves[0]].map((m) => ({ ...m, payload: {} }))).size === 15);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll tests passed');
