// Weiqi (Go) engine — deterministic board state folded from an ordered move log.
//
// Like the other LB Games engines, this is pure and deterministic: both clients
// derive the same colours from the room seed and rebuild an identical position
// by replaying the shared move log, so the database is the single source of
// truth and reconnecting is just "replay the moves".
//
// Stones are stored on the board as the SEAT that owns them (0 or 1), never as a
// colour — the fixed seat→colour mapping (blackSeat) is only used for display
// and komi. Capturing, liberties, and scoring all work in terms of the owning
// seat, which keeps the rest of the app (scores, results) seat-indexed like
// every other game.

// Board sizes offered when creating a room.
export const SIZES = { beginner: 9, intermediate: 13, full: 19 };
export const SIZE_LABELS = { beginner: 'Beginner · 9×9', intermediate: 'Intermediate · 13×13', full: 'Full · 19×19' };

// Komi: points added to White to offset Black's first-move advantage. A .5
// value means the game can never end in a tie.
export const KOMI = 6.5;

// Two consecutive passes end the game.
export const MAX_CONSECUTIVE_PASSES = 2;

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Small, fast seeded PRNG so both clients derive colours identically.
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

export function emptyBoard(size) {
  return Array.from({ length: size }, () => Array(size).fill(null));
}

function inBounds(size, r, c) {
  return r >= 0 && r < size && c >= 0 && c < size;
}

// Flood-fill the connected group of same-owner stones through (r,c). Returns
// { stones:[[r,c]...], liberties:Set('r,c'), owner } or null if (r,c) is empty.
export function groupAt(board, size, r, c) {
  const owner = board[r][c];
  if (owner === null) return null;
  const stones = [];
  const liberties = new Set();
  const seen = new Set([`${r},${c}`]);
  const stack = [[r, c]];
  while (stack.length) {
    const [cr, cc] = stack.pop();
    stones.push([cr, cc]);
    for (const [dr, dc] of DIRS) {
      const nr = cr + dr, nc = cc + dc;
      if (!inBounds(size, nr, nc)) continue;
      const v = board[nr][nc];
      if (v === null) liberties.add(`${nr},${nc}`);
      else if (v === owner && !seen.has(`${nr},${nc}`)) {
        seen.add(`${nr},${nc}`);
        stack.push([nr, nc]);
      }
    }
  }
  return { stones, liberties, owner };
}

// Liberties of the group occupying (r,c), or 0 if empty.
export function libertyCount(board, size, r, c) {
  const g = groupAt(board, size, r, c);
  return g ? g.liberties.size : 0;
}

// Attempt to play `seat`'s stone at (r,c) on a COPY of `board`. Enforces the
// three placement rules: the point must be empty, must not be the forbidden ko
// point, and the result must not be suicide (a stone with no liberties) unless
// it captures at least one enemy stone. Returns
//   { ok:true, board, captured:[[r,c]...], koPoint }  on a legal move
//   { ok:false, error }                               otherwise
// `koPoint` in the result is the point forbidden to the OPPONENT next turn (the
// single stone just captured in a ko), or null.
export function tryPlay(board, size, r, c, seat, koPoint = null) {
  if (!inBounds(size, r, c)) return { ok: false, error: 'Off the board.' };
  if (board[r][c] !== null) return { ok: false, error: 'That point is already taken.' };
  if (koPoint && koPoint[0] === r && koPoint[1] === c) {
    return { ok: false, error: 'Ko — you can\'t retake there immediately. Play elsewhere first.' };
  }

  const nb = board.map((row) => row.slice());
  nb[r][c] = seat;
  const opp = 1 - seat;

  // Remove any enemy groups this stone has just deprived of their last liberty.
  const captured = [];
  const capturedGroups = [];
  for (const [dr, dc] of DIRS) {
    const nr = r + dr, nc = c + dc;
    if (!inBounds(size, nr, nc) || nb[nr][nc] !== opp) continue;
    const g = groupAt(nb, size, nr, nc);
    if (g.liberties.size === 0) {
      capturedGroups.push(g);
      for (const [sr, sc] of g.stones) {
        if (nb[sr][sc] !== null) { nb[sr][sc] = null; captured.push([sr, sc]); }
      }
    }
  }

  // Suicide: the played stone's own group has no liberties and nothing was
  // captured to open one up.
  const self = groupAt(nb, size, r, c);
  if (self.liberties.size === 0 && captured.length === 0) {
    return { ok: false, error: 'That would be suicide — the stone would have no liberties.' };
  }

  // Ko point: set only when this move captured exactly one stone and left the
  // played stone as a lone stone with a single liberty (the captured point).
  // That's the textbook ko shape; the opponent can't immediately recapture.
  let newKo = null;
  if (captured.length === 1 && self.stones.length === 1 && self.liberties.size === 1) {
    newKo = captured[0];
  }

  return { ok: true, board: nb, captured, koPoint: newKo, capturedGroups };
}

// True if `seat` has at least one legal move on this board (used to detect a
// position where passing is the only option — not currently game-critical but
// handy for the tutorial and hints).
export function hasLegalMove(board, size, seat, koPoint = null) {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === null && tryPlay(board, size, r, c, seat, koPoint).ok) return true;
    }
  }
  return false;
}

// ---- Game state ------------------------------------------------------------

// The board size lives on the 'start' move (like Wurdz's region/mode), so a
// replay recovers it without a dedicated room column. Before 'start' the size
// is a placeholder — nothing plays on the board until the game begins.
export function newGameState(seed, size = SIZES.full, komi = KOMI) {
  return {
    seed,
    size,
    komi,
    board: emptyBoard(size),
    // Which seat plays Black (and therefore moves first). Derived from the seed
    // so both clients agree without extra state.
    blackSeat: mulberry32((seed ^ 0x5f3759df) >>> 0)() < 0.5 ? 0 : 1,
    turn: null,          // seat to move, or null before 'start'
    started: false,
    moveCount: 0,
    captures: [0, 0],    // stones captured BY each seat
    koPoint: null,       // [r,c] forbidden this turn, or null
    consecutivePasses: 0,
    lastMove: null,
    gameOver: false,
    winner: null,        // seat | 'tie'
    score: null,         // scoring breakdown once the game ends
    endDetail: null,
  };
}

export function colorOf(state, seat) {
  return seat === state.blackSeat ? 'black' : 'white';
}

export function whiteSeat(state) {
  return 1 - state.blackSeat;
}

// ---- Scoring (area / Chinese-style) ---------------------------------------
//
// Each seat's area = its stones on the board + empty points that are surrounded
// only by that seat. White also receives komi. Empty regions bordering both
// seats (or the board only) are neutral (dame). This simple count assumes dead
// stones have already been captured or fully surrounded — pass only once the
// position is settled (the same convention casual Go apps use).
export function computeScore(board, size, komi, blackSeat) {
  const stones = [0, 0];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== null) stones[board[r][c]]++;
    }
  }

  const territory = [0, 0];
  let neutral = 0;
  const seen = Array.from({ length: size }, () => Array(size).fill(false));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== null || seen[r][c]) continue;
      // Flood-fill this empty region, recording which seats border it.
      const region = [];
      const borders = new Set();
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        region.push([cr, cc]);
        for (const [dr, dc] of DIRS) {
          const nr = cr + dr, nc = cc + dc;
          if (!inBounds(size, nr, nc)) continue;
          const v = board[nr][nc];
          if (v === null) {
            if (!seen[nr][nc]) { seen[nr][nc] = true; stack.push([nr, nc]); }
          } else {
            borders.add(v);
          }
        }
      }
      if (borders.size === 1) territory[[...borders][0]] += region.length;
      else neutral += region.length;
    }
  }

  const area = [stones[0] + territory[0], stones[1] + territory[1]];
  const white = 1 - blackSeat;
  const final = area.slice();
  final[white] += komi;
  let winner;
  if (final[0] > final[1]) winner = 0;
  else if (final[1] > final[0]) winner = 1;
  else winner = 'tie';
  return { stones, territory, neutral, area, komi, blackSeat, whiteSeat: white, final, winner };
}

function finishByScore(state) {
  const score = computeScore(state.board, state.size, state.komi, state.blackSeat);
  state.gameOver = true;
  state.winner = score.winner;
  state.score = score;
  state.endDetail = { reason: 'passed', score };
}

// ---- Move application ------------------------------------------------------

export function applyMove(state, move) {
  if (move.move_index !== state.moveCount) {
    throw new Error(`Move ${move.move_index} applied out of order (expected ${state.moveCount})`);
  }
  const seat = move.player;
  const payload = move.payload || {};

  switch (move.type) {
    case 'start': {
      // The host's chosen board size (and komi) travel on the start move; size
      // the board to it now so a replay from the log is self-describing.
      if (payload.size) state.size = payload.size;
      if (payload.komi != null) state.komi = payload.komi;
      state.board = emptyBoard(state.size);
      state.turn = state.blackSeat;
      state.started = true;
      state.lastMove = { type: 'start', player: seat, first: state.blackSeat };
      break;
    }
    case 'place': {
      const { r, c } = payload;
      const res = tryPlay(state.board, state.size, r, c, seat, state.koPoint);
      if (!res.ok) throw new Error(`Invalid placement in move log: ${res.error}`);
      state.board = res.board;
      state.captures[seat] += res.captured.length;
      state.koPoint = res.koPoint;
      state.consecutivePasses = 0;
      state.lastMove = { type: 'place', player: seat, r, c, captured: res.captured };
      state.turn = 1 - seat;
      break;
    }
    case 'pass': {
      state.consecutivePasses += 1;
      state.koPoint = null;
      state.lastMove = { type: 'pass', player: seat };
      state.turn = 1 - seat;
      if (state.consecutivePasses >= MAX_CONSECUTIVE_PASSES) finishByScore(state);
      break;
    }
    case 'forfeit': {
      state.gameOver = true;
      state.winner = 1 - seat;
      state.endDetail = { reason: 'forfeit', resignedPlayer: seat };
      state.lastMove = { type: 'forfeit', player: seat };
      break;
    }
    default:
      throw new Error(`Unknown move type: ${move.type}`);
  }
  state.moveCount += 1;
  return state;
}

export function replayMoves(seed, moves) {
  const state = newGameState(seed);
  const ordered = [...moves].sort((a, b) => a.move_index - b.move_index);
  for (const m of ordered) {
    if (m.type === 'rematch') continue; // cross-cutting control move, not gameplay
    applyMove(state, m);
  }
  return state;
}
