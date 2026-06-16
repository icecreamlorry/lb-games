// Splitz engine tests. Run: node test/engine.test.mjs
import {
  TOTAL_TILES, LETTER_COUNTS, handSize, makeBunch, deriveState,
  handLetters, gridWords, isConnected, validateGrid,
} from '../js/engine.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ok:', msg); } else { fail++; console.error('  FAIL:', msg); } }

// Distribution sums to 144.
ok(Object.values(LETTER_COUNTS).reduce((a, b) => a + b, 0) === TOTAL_TILES, 'distribution sums to 144');

// Bunch is deterministic and full.
const b1 = makeBunch(12345), b2 = makeBunch(12345), b3 = makeBunch(99);
ok(b1.length === TOTAL_TILES, 'bunch has 144 tiles');
ok(b1.join('') === b2.join(''), 'same seed -> same bunch');
ok(b1.join('') !== b3.join(''), 'different seed -> different bunch');

// Hand sizes by player count.
ok(handSize(2) === 21 && handSize(4) === 21 && handSize(6) === 15 && handSize(8) === 11, 'hand sizes');

// Start deal.
const seed = 777;
const start = { move_index: 0, player: 0, type: 'start', payload: { players: 2, hand: 21 } };
let st = deriveState(seed, [start]);
ok(st.started && st.players === 2, 'started with 2 players');
ok(st.entitled[0].length === 21 && st.entitled[1].length === 21, 'each seat dealt 21');
ok(st.poolRemaining === TOTAL_TILES - 42, 'pool remaining after deal = 102');

// Initial hands match the bunch order (block deal).
const bunch = makeBunch(seed);
ok(st.entitled[0].join('') === bunch.slice(0, 21).join(''), 'seat 0 hand = bunch[0..21]');
ok(st.entitled[1].join('') === bunch.slice(21, 42).join(''), 'seat 1 hand = bunch[21..42]');

// Peel gives everyone one tile and drops pool by player count.
st = deriveState(seed, [start, { move_index: 1, player: 0, type: 'peel', payload: {} }]);
ok(st.entitled[0].length === 22 && st.entitled[1].length === 22, 'peel: both seats +1');
ok(st.poolRemaining === TOTAL_TILES - 44, 'peel: pool -2 (2 players)');
ok(st.peels === 1 && st.lastPeelBy === 0, 'peel counted, lastPeelBy set');

// Dump: return 1, draw 3 -> net +2 tiles for that seat, pool -2.
const dumpLetter = st.entitled[0][0];
st = deriveState(seed, [start, { move_index: 1, player: 0, type: 'dump', payload: { letter: dumpLetter } }]);
ok(st.entitled[0].length === 23, 'dump: seat 0 net +2 tiles');
ok(st.poolRemaining === TOTAL_TILES - 44, 'dump: pool -2');

// Bananas ends the game.
st = deriveState(seed, [start, { move_index: 1, player: 1, type: 'bananas', payload: {} }]);
ok(st.gameOver && st.winner === 1, 'bananas ends game, winner set');

// handLetters = entitled - placed.
const hand = handLetters(['A', 'B', 'C', 'A'], ['A', 'C']);
ok(hand.join('') === 'AB', 'handLetters removes placed tiles');

// Grid words: a simple crossword.
//   C A T
//   . . O   -> CAT (across), TO (down from T)
const placed = new Map([
  ['0,0', 'C'], ['0,1', 'A'], ['0,2', 'T'], ['1,2', 'O'],
]);
const words = gridWords(placed).sort();
ok(words.join(',') === 'CAT,TO', `gridWords finds CAT + TO (got ${words.join(',')})`);
ok(isConnected(placed), 'connected grid detected');

const disjoint = new Map([['0,0', 'C'], ['0,1', 'A'], ['0,2', 'T'], ['5,5', 'X'], ['5,6', 'X']]);
ok(!isConnected(disjoint), 'disjoint grid rejected');

// validateGrid with a fake dictionary.
const dict = new Set(['CAT', 'TO', 'HI']);
const isWord = (w) => dict.has(String(w).toUpperCase());
ok(validateGrid(placed, isWord).valid, 'valid crossword passes');
ok(!validateGrid(new Map([['0,0', 'Z'], ['0,1', 'Z']]), isWord).valid, 'non-word ZZ fails');
ok(!validateGrid(new Map([['0,0', 'C']]), isWord).valid, 'single tile fails');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
