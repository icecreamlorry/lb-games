// Splitz engine — pure, deterministic Bananagrams logic.
//
// The shared move log (start / peel / dump / bananas) plus the room seed fully
// determine the "bunch" (face-down tile pool) and every player's entitled set
// of letters. Each client replays the log to derive identical pool state; a
// player's private grid is local (never in the log) and only validated when
// they peel or call Bananas.

export const TOTAL_TILES = 144;

// Standard Bananagrams letter distribution (sums to 144).
export const LETTER_COUNTS = {
  A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2, L: 5,
  M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3, W: 3, X: 2,
  Y: 3, Z: 2,
};

// How many tiles each player starts with, by player count (Bananagrams rules).
export function handSize(players) {
  if (players <= 4) return 21;
  if (players <= 6) return 15;
  return 11; // 7-8 players
}

// Deterministic PRNG so every client shuffles the bunch identically.
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

// The shuffled 144-tile bunch as an array of letters, derived from the seed.
export function makeBunch(seed) {
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
//     poolRemaining, peels, gameOver, winner, lastPeelBy }
// `entitled[seat]` is the multiset of letters that seat is currently entitled
// to hold (placed on their grid + still in hand).
export function deriveState(seed, moves) {
  const ordered = [...(moves || [])].sort((a, b) => a.move_index - b.move_index);
  const start = ordered.find((m) => m.type === 'start');

  const state = {
    started: false, players: 0, hand: 0,
    entitled: [], poolRemaining: 0, peels: 0,
    gameOver: false, winner: null, lastPeelBy: null,
  };
  if (!start) return state;

  const players = Number(start.payload?.players) || 0;
  const hand = Number(start.payload?.hand) || handSize(players);
  if (!players) return state;

  const bunch = makeBunch(seed); // mutable; dumps append returned letters
  let next = 0;
  const entitled = Array.from({ length: players }, () => []);

  // Initial deal: block of `hand` tiles per seat, in seat order.
  for (let s = 0; s < players; s++) {
    for (let i = 0; i < hand && next < bunch.length; i++) entitled[s].push(bunch[next++]);
  }

  let gameOver = false, winner = null, peels = 0, lastPeelBy = null;

  for (const m of ordered) {
    if (gameOver) break;
    if (m.type === 'peel') {
      // Everyone draws one tile (in seat order).
      for (let s = 0; s < players; s++) {
        if (next < bunch.length) entitled[s].push(bunch[next++]);
      }
      peels += 1;
      lastPeelBy = m.player;
    } else if (m.type === 'dump') {
      const letter = String(m.payload?.letter || '').toUpperCase();
      const p = m.player;
      // Return the dumped tile to the (back of the) bunch...
      if (letter) {
        const idx = entitled[p].indexOf(letter);
        if (idx !== -1) entitled[p].splice(idx, 1);
        bunch.push(letter);
      }
      // ...and draw three.
      for (let i = 0; i < 3; i++) {
        if (next < bunch.length) entitled[p].push(bunch[next++]);
      }
    } else if (m.type === 'bananas') {
      gameOver = true;
      winner = m.player;
    }
  }

  state.started = true;
  state.players = players;
  state.hand = hand;
  state.entitled = entitled;
  state.poolRemaining = Math.max(0, bunch.length - next);
  state.peels = peels;
  state.gameOver = gameOver;
  state.winner = winner;
  state.lastPeelBy = lastPeelBy;
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

// Validate a finished grid. Returns { valid, reason, words }.
//   isWord — dictionary predicate
export function validateGrid(placed, isWord) {
  if (!placed || placed.size === 0) return { valid: false, reason: 'Place some tiles first.', words: [] };
  if (placed.size === 1) return { valid: false, reason: 'A single letter is not a word.', words: [] };
  if (!isConnected(placed)) return { valid: false, reason: 'All tiles must connect into one group.', words: [] };

  const words = gridWords(placed);
  // Every tile must belong to at least one >=2 run; a lone tile sticking out
  // would create no word for itself, but connectivity + the across/down sweep
  // guarantees each tile is covered as long as no 1-length stragglers exist.
  const bad = words.filter((w) => !isWord(w));
  if (bad.length) {
    return { valid: false, reason: `Not a word: ${bad.slice(0, 3).join(', ')}`, words };
  }
  return { valid: true, reason: '', words };
}
