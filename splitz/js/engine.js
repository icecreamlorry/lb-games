// Splitz engine — pure, deterministic logic for the tile race.
//
// The shared move log (start / draw / swap / win) plus the room seed fully
// determine the "pool" (face-down tile supply) and every player's entitled set
// of letters. Each client replays the log to derive identical pool state; a
// player's private grid is local (never in the log) and only validated when
// they call DRAW (used all their tiles) or SPLITZ (win).

export const TOTAL_TILES = 144;

// Standard letter distribution (sums to 144).
export const LETTER_COUNTS = {
  A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2, L: 5,
  M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3, W: 3, X: 2,
  Y: 3, Z: 2,
};

// How many tiles each player starts with, by player count.
export function handSize(players) {
  if (players <= 4) return 21;
  if (players <= 6) return 15;
  return 11; // 7-8 players
}

// Deterministic PRNG so every client shuffles the pool identically.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
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

// The shuffled 144-tile pool as an array of letters, derived from the seed.
export function makePool(seed) {
  const tiles = [];
  for (const [letter, n] of Object.entries(LETTER_COUNTS)) {
    for (let i = 0; i < n; i++) tiles.push(letter);
  }
  return shuffle(tiles, mulberry32(seed >>> 0));
}

// Replay the move log into pool state.
//   seed   — room seed
//   moves  — array of { move_index, player, type, payload }
// Returns:
//   { started, players, hand, entitled (array by seat of letters),
//     poolRemaining, draws, gameOver, winner, lastDrawBy }
// `entitled[seat]` is the multiset of letters that seat is currently entitled
// to hold (placed on their grid + still in hand).
export function deriveState(seed, moves) {
  const ordered = [...(moves || [])].sort((a, b) => a.move_index - b.move_index);
  const start = ordered.find((m) => m.type === 'start');

  const state = {
    started: false, players: 0, hand: 0,
    entitled: [], poolRemaining: 0, draws: 0,
    gameOver: false, winner: null, lastDrawBy: null,
  };
  if (!start) return state;

  const players = Number(start.payload?.players) || 0;
  const hand = Number(start.payload?.hand) || handSize(players);
  if (!players) return state;

  const pool = makePool(seed); // mutable; swaps append returned letters
  let next = 0;
  const entitled = Array.from({ length: players }, () => []);

  // Initial deal: block of `hand` tiles per seat, in seat order.
  for (let s = 0; s < players; s++) {
    for (let i = 0; i < hand && next < pool.length; i++) entitled[s].push(pool[next++]);
  }

  let gameOver = false, winner = null, draws = 0, lastDrawBy = null;

  for (const m of ordered) {
    if (gameOver) break;
    if (m.type === 'draw') {
      // Everyone draws one tile (in seat order).
      for (let s = 0; s < players; s++) {
        if (next < pool.length) entitled[s].push(pool[next++]);
      }
      draws += 1;
      lastDrawBy = m.player;
    } else if (m.type === 'swap') {
      const letter = String(m.payload?.letter || '').toUpperCase();
      const p = m.player;
      // Return the swapped tile to the (back of the) pool...
      if (letter) {
        const idx = entitled[p].indexOf(letter);
        if (idx !== -1) entitled[p].splice(idx, 1);
        pool.push(letter);
      }
      // ...and draw three.
      for (let i = 0; i < 3; i++) {
        if (next < pool.length) entitled[p].push(pool[next++]);
      }
    } else if (m.type === 'win') {
      gameOver = true;
      winner = m.player;
    }
  }

  state.started = true;
  state.players = players;
  state.hand = hand;
  state.entitled = entitled;
  state.poolRemaining = Math.max(0, pool.length - next);
  state.draws = draws;
  state.gameOver = gameOver;
  state.winner = winner;
  state.lastDrawBy = lastDrawBy;
  return state;
}

// Multiset difference: letters in `entitled` minus letters already `placed`,
// returned as a sorted array (the player's current hand).
export function handLetters(entitled, placedLetters) {
  const counts = new Map();
  for (const l of entitled) counts.set(l, (counts.get(l) || 0) + 1);
  for (const l of placedLetters) counts.set(l, (counts.get(l) || 0) - 1);
  const out = [];
  for (const [l, n] of counts) for (let i = 0; i < n; i++) out.push(l);
  out.sort();
  return out;
}

// ---- Grid validation ------------------------------------------------------
//
// `placed` is a Map of "r,c" -> letter. A grid is valid when every tile is in
// one connected group and every across/down run of length >= 2 is a real word.

function key(r, c) { return r + ',' + c; }

// All maximal horizontal & vertical runs of length >= 2, as letter strings.
export function gridWords(placed) {
  const cells = [...placed.keys()].map((k) => k.split(',').map(Number));
  const has = (r, c) => placed.has(key(r, c));
  const words = [];

  for (const [r, c] of cells) {
    // Horizontal run start?
    if (!has(r, c - 1) && has(r, c + 1)) {
      let w = '', cc = c;
      while (has(r, cc)) { w += placed.get(key(r, cc)); cc++; }
      words.push(w);
    }
    // Vertical run start?
    if (!has(r - 1, c) && has(r + 1, c)) {
      let w = '', rr = r;
      while (has(rr, c)) { w += placed.get(key(rr, c)); rr++; }
      words.push(w);
    }
  }
  return words;
}

// Are all placed tiles in a single 4-connected group?
export function isConnected(placed) {
  if (placed.size <= 1) return true;
  const keys = [...placed.keys()];
  const seen = new Set();
  const stack = [keys[0]];
  seen.add(keys[0]);
  while (stack.length) {
    const [r, c] = stack.pop().split(',').map(Number);
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(r + dr, c + dc);
      if (placed.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  return seen.size === placed.size;
}

// Keys of all tiles NOT in the largest 4-connected group — the disconnected
// islands and stray letters that keep a grid from being one crossword. Empty
// when every tile is already in one group (or there's a single tile).
export function disconnectedKeys(placed) {
  const out = new Set();
  if (!placed || placed.size <= 1) return out;
  const seen = new Set();
  let best = null;
  for (const start of placed.keys()) {
    if (seen.has(start)) continue;
    const comp = [start]; seen.add(start);
    for (let i = 0; i < comp.length; i++) {
      const [r, c] = comp[i].split(',').map(Number);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = key(r + dr, c + dc);
        if (placed.has(k) && !seen.has(k)) { seen.add(k); comp.push(k); }
      }
    }
    if (!best || comp.length > best.length) best = comp;
  }
  const keep = new Set(best);
  for (const k of placed.keys()) if (!keep.has(k)) out.add(k);
  return out;
}

// Validate a finished grid. Returns { valid, reason, words }.
//   isWord — dictionary predicate
export function validateGrid(placed, isWord) {
  if (!placed || placed.size === 0) return { valid: false, reason: 'Place some tiles first.', words: [] };
  if (placed.size === 1) return { valid: false, reason: 'A single letter is not a word.', words: [] };
  if (!isConnected(placed)) return { valid: false, reason: 'All tiles must connect into one group.', words: [] };

  const words = gridWords(placed);
  const bad = words.filter((w) => !isWord(w));
  if (bad.length) {
    return { valid: false, reason: `Not a word: ${bad.slice(0, 3).join(', ')}`, words };
  }
  return { valid: true, reason: '', words };
}
