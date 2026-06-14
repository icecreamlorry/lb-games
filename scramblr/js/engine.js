// Scramblr engine — deterministic board from the room seed, path/word checks,
// scoring, and final dedup standings. Everything is pure and deterministic so
// every client derives the same board from the shared seed and computes the
// same standings from the shared move log.

export const SIZE = 4;             // 4 x 4 grid
export const CELLS = SIZE * SIZE;  // 16
export const MIN_WORD = 3;         // shortest scoring word (letters)
export const COUNTDOWN_MS = 3000;  // 3-2-1 before the grid reveals
export const GAME_MS = 180000;     // 3-minute round

// Classic 16-die English Scramblr set. A 'Q' face is the "Qu" tile.
const DICE = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
];

// Small, fast seeded PRNG so every client shuffles identically.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 16 tiles (strings; 'QU' for the Q die face) laid out row-major, derived
// deterministically from the seed.
export function makeBoard(seed) {
  const rng = mulberry32(seed >>> 0);
  const dice = shuffle([...DICE], rng); // assign dice to board positions
  return dice.map((die) => {
    const face = die[Math.floor(rng() * die.length)];
    return face === 'Q' ? 'QU' : face;
  });
}

// 8-neighbour adjacency on the grid, by cell index 0..15.
export function adjacent(a, b) {
  if (a === b) return false;
  const ra = Math.floor(a / SIZE), ca = a % SIZE;
  const rb = Math.floor(b / SIZE), cb = b % SIZE;
  return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1;
}

// A path is valid if its cells are distinct and each step is to a neighbour.
export function validPath(path) {
  if (!Array.isArray(path) || path.length < 1) return false;
  const seen = new Set();
  for (let i = 0; i < path.length; i++) {
    if (seen.has(path[i])) return false;
    seen.add(path[i]);
    if (i > 0 && !adjacent(path[i - 1], path[i])) return false;
  }
  return true;
}

export function wordFromPath(board, path) {
  return path.map((i) => board[i]).join('').toUpperCase();
}

// Standard Scramblr scoring by letter count (QU counts as its two letters).
export function wordPoints(word) {
  const n = word.length;
  if (n < MIN_WORD) return 0;
  if (n <= 4) return 1;
  if (n === 5) return 2;
  if (n === 6) return 3;
  if (n === 7) return 5;
  return 11;
}

// Can `word` be traced on the board (adjacency, each cell once)? Tiles may be
// multi-char ('QU'), so we match tile-by-tile. Used to re-validate submitted
// words deterministically.
export function canForm(board, word) {
  const W = String(word).toUpperCase();
  const used = new Array(CELLS).fill(false);
  const dfs = (cell, pos) => {
    const tile = board[cell];
    if (W.substr(pos, tile.length) !== tile) return false;
    const next = pos + tile.length;
    if (next === W.length) return true;
    used[cell] = true;
    for (let n = 0; n < CELLS; n++) {
      if (!used[n] && adjacent(cell, n) && dfs(n, next)) { used[cell] = false; return true; }
    }
    used[cell] = false;
    return false;
  };
  for (let c = 0; c < CELLS; c++) if (dfs(c, 0)) return true;
  return false;
}

// Final standings with classic dedup: a word found by more than one player
// scores for nobody. Each word is re-validated (length, dictionary, board-
// formable) so a tampered list can't inflate a score.
//   isWord(w)     — dictionary predicate
//   wordsBySeat   — array indexed by seat -> string[] of that player's words
// Returns an array (indexed by seat) of { score, total, unique }.
export function standings(board, isWord, wordsBySeat) {
  const valid = wordsBySeat.map((words) => {
    const set = new Set();
    for (const raw of words || []) {
      const w = String(raw || '').toUpperCase();
      if (w.length >= MIN_WORD && isWord(w) && canForm(board, w)) set.add(w);
    }
    return set;
  });

  const counts = new Map();
  valid.forEach((set) => set.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1)));

  return valid.map((set) => {
    let score = 0;
    let unique = 0;
    for (const w of set) {
      if (counts.get(w) === 1) { score += wordPoints(w); unique += 1; }
    }
    return { score, total: set.size, unique };
  });
}
