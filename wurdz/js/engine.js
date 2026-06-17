// Deterministic word game engine.
//
// Both clients construct an identical tile bag from the room seed and fold
// the ordered move log into a game state, so the database move log is the
// single source of truth and reconnecting is just "replay the moves".

export const BOARD_SIZE = 15;
export const RACK_SIZE = 7;
export const CENTER = 7;
export const BLANK = '_';

// The game ends on whichever comes first: six consecutive scoreless turns
// (passes, exchanges, or upheld challenges), or four consecutive passes
// (both players passing twice in a row).
export const MAX_SCORELESS_TURNS = 6;
export const MAX_CONSECUTIVE_PASSES = 4;

// Standard English tile set: 100 tiles.
export const TILE_DISTRIBUTION = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1, [BLANK]: 2,
};

export const TILE_POINTS = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1,
  M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8,
  Y: 4, Z: 10, [BLANK]: 0,
};

// Premium squares for the standard board.
const TW = [[0, 0], [0, 7], [0, 14], [7, 0], [7, 14], [14, 0], [14, 7], [14, 14]];
const DW = [
  [1, 1], [2, 2], [3, 3], [4, 4], [10, 10], [11, 11], [12, 12], [13, 13],
  [1, 13], [2, 12], [3, 11], [4, 10], [10, 4], [11, 3], [12, 2], [13, 1],
  [7, 7],
];
const TL = [
  [1, 5], [1, 9], [5, 1], [5, 5], [5, 9], [5, 13],
  [9, 1], [9, 5], [9, 9], [9, 13], [13, 5], [13, 9],
];
const DL = [
  [0, 3], [0, 11], [2, 6], [2, 8], [3, 0], [3, 7], [3, 14],
  [6, 2], [6, 6], [6, 8], [6, 12], [7, 3], [7, 11],
  [8, 2], [8, 6], [8, 8], [8, 12], [11, 0], [11, 7], [11, 14],
  [12, 6], [12, 8], [14, 3], [14, 11],
];

export const PREMIUMS = (() => {
  const map = {};
  for (const [r, c] of TW) map[`${r},${c}`] = 'TW';
  for (const [r, c] of DW) map[`${r},${c}`] = 'DW';
  for (const [r, c] of TL) map[`${r},${c}`] = 'TL';
  for (const [r, c] of DL) map[`${r},${c}`] = 'DL';
  return map;
})();

export function premiumAt(r, c) {
  return PREMIUMS[`${r},${c}`] || null;
}

// Small, fast seeded PRNG so both clients shuffle identically.
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

export function makeBag(seed) {
  const bag = [];
  for (const [letter, count] of Object.entries(TILE_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) bag.push(letter);
  }
  return shuffle(bag, mulberry32(seed));
}

export function newGameState(seed) {
  return {
    seed,
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)),
    bag: makeBag(seed),
    racks: [[], []],
    scores: [0, 0],
    turn: null,            // becomes 0 or 1 on the 'start' move
    started: false,
    moveCount: 0,
    scorelessTurns: 0,
    consecutivePasses: 0,
    gameOver: false,
    winner: null,          // 0, 1, or 'tie'
    endDetail: null,
    lastMove: null,        // summary of the most recent move, for the UI
  };
}

function draw(state, playerIndex, count) {
  const taken = state.bag.splice(0, count);
  state.racks[playerIndex].push(...taken);
}

function removeFromRack(rack, letter) {
  const i = rack.indexOf(letter);
  if (i === -1) throw new Error(`Tile ${letter} not in rack`);
  rack.splice(i, 1);
}

function rackValue(rack) {
  return rack.reduce((sum, t) => sum + TILE_POINTS[t], 0);
}

// True once a scoreless run should end the game: six scoreless turns or four
// consecutive passes, whichever is reached first.
function scorelessEndReached(state) {
  return state.scorelessTurns >= MAX_SCORELESS_TURNS
    || state.consecutivePasses >= MAX_CONSECUTIVE_PASSES;
}

function finishGame(state, outPlayer) {
  state.gameOver = true;
  const deductions = state.racks.map(rackValue);
  if (outPlayer !== null) {
    // The player who went out gains the opponent's unplayed letters.
    const other = 1 - outPlayer;
    state.scores[outPlayer] += deductions[other];
    state.scores[other] -= deductions[other];
    state.endDetail = { reason: 'out', outPlayer, deductions };
  } else {
    // Game ended on consecutive scoreless turns: everyone loses their rack.
    state.scores[0] -= deductions[0];
    state.scores[1] -= deductions[1];
    const byPasses = state.consecutivePasses >= MAX_CONSECUTIVE_PASSES;
    state.endDetail = { reason: 'passes', byPasses, outPlayer: null, deductions };
  }
  if (state.scores[0] > state.scores[1]) state.winner = 0;
  else if (state.scores[1] > state.scores[0]) state.winner = 1;
  else state.winner = 'tie';
}

// Words formed by placing `cells` ([{r,c,letter,blank}]) on `board`.
// Returns { words: [{word, score, cells}], total, bingo } — placement is
// assumed to already be validated.
export function scorePlacement(board, cells) {
  const placed = new Map(cells.map((p) => [`${p.r},${p.c}`, p]));
  const letterAt = (r, c) => {
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return null;
    const p = placed.get(`${r},${c}`);
    if (p) return { letter: p.letter, points: p.blank ? 0 : TILE_POINTS[p.letter], isNew: true, r, c };
    const t = board[r][c];
    if (t) return { letter: t.letter, points: t.blank ? 0 : TILE_POINTS[t.letter], isNew: false, r, c };
    return null;
  };

  const collectWord = (r, c, dr, dc) => {
    while (letterAt(r - dr, c - dc)) { r -= dr; c -= dc; }
    const tiles = [];
    let cur;
    while ((cur = letterAt(r, c))) {
      tiles.push(cur);
      r += dr; c += dc;
    }
    return tiles;
  };

  const scoreWord = (tiles) => {
    let score = 0;
    let multiplier = 1;
    for (const t of tiles) {
      let pts = t.points;
      if (t.isNew) {
        const prem = premiumAt(t.r, t.c);
        if (prem === 'DL') pts *= 2;
        else if (prem === 'TL') pts *= 3;
        else if (prem === 'DW') multiplier *= 2;
        else if (prem === 'TW') multiplier *= 3;
      }
      score += pts;
    }
    return score * multiplier;
  };

  const sameRow = cells.every((p) => p.r === cells[0].r);
  const dr = sameRow ? 0 : 1;
  const dc = sameRow ? 1 : 0;

  const words = [];
  const main = collectWord(cells[0].r, cells[0].c, dr, dc);
  if (main.length >= 2) {
    words.push({ word: main.map((t) => t.letter).join(''), score: scoreWord(main), tiles: main });
  }
  for (const p of cells) {
    const cross = collectWord(p.r, p.c, dc, dr);
    if (cross.length >= 2) {
      words.push({ word: cross.map((t) => t.letter).join(''), score: scoreWord(cross), tiles: cross });
    }
  }

  const bingo = cells.length === RACK_SIZE;
  const total = words.reduce((s, w) => s + w.score, 0) + (bingo ? 50 : 0);
  return { words, total, bingo };
}

// Structural validation of a placement. Returns {ok:true, ...scoring} or
// {ok:false, error}.
export function validatePlacement(state, cells) {
  if (!cells.length) return { ok: false, error: 'Place at least one tile.' };

  const seen = new Set();
  for (const p of cells) {
    const key = `${p.r},${p.c}`;
    if (seen.has(key)) return { ok: false, error: 'Duplicate square.' };
    seen.add(key);
    if (state.board[p.r][p.c]) return { ok: false, error: 'Square already occupied.' };
  }

  const sameRow = cells.every((p) => p.r === cells[0].r);
  const sameCol = cells.every((p) => p.c === cells[0].c);
  if (!sameRow && !sameCol) {
    return { ok: false, error: 'Tiles must be in a single row or column.' };
  }

  // The span from first to last placed tile must be fully occupied
  // (by new tiles or tiles already on the board).
  const occupied = (r, c) => seen.has(`${r},${c}`) || !!state.board[r][c];
  if (sameRow && cells.length > 1) {
    const r = cells[0].r;
    const csorted = cells.map((p) => p.c).sort((a, b) => a - b);
    for (let c = csorted[0]; c <= csorted[csorted.length - 1]; c++) {
      if (!occupied(r, c)) return { ok: false, error: 'Word has a gap in it.' };
    }
  } else if (cells.length > 1) {
    const c = cells[0].c;
    const rsorted = cells.map((p) => p.r).sort((a, b) => a - b);
    for (let r = rsorted[0]; r <= rsorted[rsorted.length - 1]; r++) {
      if (!occupied(r, c)) return { ok: false, error: 'Word has a gap in it.' };
    }
  }

  const boardEmpty = state.board.every((row) => row.every((t) => !t));
  if (boardEmpty) {
    if (!cells.some((p) => p.r === CENTER && p.c === CENTER)) {
      return { ok: false, error: 'The first word must cover the center star.' };
    }
    if (cells.length < 2) {
      return { ok: false, error: 'The first word needs at least two letters.' };
    }
  } else {
    const touchesExisting = cells.some((p) =>
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => {
        const r = p.r + dr, c = p.c + dc;
        return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && state.board[r][c];
      })
    );
    if (!touchesExisting) {
      return { ok: false, error: 'New words must connect to tiles on the board.' };
    }
  }

  const scoring = scorePlacement(state.board, cells);
  if (!scoring.words.length) {
    return { ok: false, error: 'A word needs at least two letters.' };
  }
  return { ok: true, ...scoring };
}

// Applies one move from the log. Throws on structurally invalid moves —
// the sending client validates before submitting.
export function applyMove(state, move) {
  if (move.move_index !== state.moveCount) {
    throw new Error(`Move ${move.move_index} applied out of order (expected ${state.moveCount})`);
  }
  const player = move.player;
  const payload = move.payload || {};

  switch (move.type) {
    case 'start': {
      draw(state, 0, RACK_SIZE);
      draw(state, 1, RACK_SIZE);
      state.turn = Math.floor(mulberry32(state.seed ^ 0x5f3759df)() * 2);
      state.started = true;
      state.lastMove = { type: 'start', player, firstPlayer: state.turn };
      break;
    }
    case 'place': {
      const cells = payload.cells;
      const result = validatePlacement(state, cells);
      if (!result.ok) throw new Error(`Invalid placement in move log: ${result.error}`);
      const prevScoreless = state.scorelessTurns;
      const placedRackTiles = [];
      for (const p of cells) {
        const rackTile = p.blank ? BLANK : p.letter;
        removeFromRack(state.racks[player], rackTile);
        placedRackTiles.push(rackTile);
        state.board[p.r][p.c] = { letter: p.letter, blank: !!p.blank };
      }
      state.scores[player] += result.total;
      const drawCount = Math.min(cells.length, state.bag.length);
      const taken = state.bag.slice(0, drawCount);
      draw(state, player, drawCount);
      state.scorelessTurns = 0;
      state.consecutivePasses = 0;
      state.lastMove = {
        type: 'place', player,
        words: result.words.map((w) => w.word),
        score: result.total, bingo: result.bingo,
        cells,
        // Everything needed to retract this play if it is challenged.
        undo: { cells, placedRackTiles, taken, score: result.total, prevScoreless },
      };
      if (state.racks[player].length === 0 && state.bag.length === 0) {
        finishGame(state, player);
      } else {
        state.turn = 1 - player;
      }
      break;
    }
    case 'exchange': {
      const tiles = payload.tiles; // letters being swapped out (blank = '_')
      for (const t of tiles) removeFromRack(state.racks[player], t);
      draw(state, player, tiles.length);
      // Return the exchanged tiles and reshuffle deterministically.
      state.bag.push(...tiles);
      shuffle(state.bag, mulberry32((state.seed + move.move_index * 7919) >>> 0));
      state.scorelessTurns += 1;
      state.consecutivePasses = 0; // an exchange breaks a run of passes
      state.lastMove = { type: 'exchange', player, count: tiles.length };
      state.turn = 1 - player;
      if (scorelessEndReached(state)) finishGame(state, null);
      break;
    }
    case 'pass': {
      state.scorelessTurns += 1;
      state.consecutivePasses += 1;
      state.lastMove = { type: 'pass', player };
      state.turn = 1 - player;
      if (scorelessEndReached(state)) finishGame(state, null);
      break;
    }
    case 'forfeit': {
      // A player resigns. The game ends immediately and the opponent wins
      // outright, whatever the score — no tile deductions, the result is
      // already decided. Valid at any point once the player holds a seat.
      state.gameOver = true;
      state.winner = 1 - player;
      state.endDetail = { reason: 'forfeit', resignedPlayer: player };
      state.lastMove = { type: 'forfeit', player };
      break;
    }
    case 'challenge': {
      // `upheld` is decided by the challenging client's dictionary lookup and
      // recorded in the log so every client replays the same outcome. A
      // challenge always immediately follows the play it disputes, so
      // state.lastMove is that 'place'.
      const challenger = player;
      const prev = state.lastMove;
      const upheld = !!payload.upheld;
      if (upheld && prev && prev.type === 'place' && prev.undo) {
        const placer = prev.player;
        const u = prev.undo;
        for (const p of u.cells) state.board[p.r][p.c] = null;
        for (const t of u.taken) removeFromRack(state.racks[placer], t);
        for (const t of u.placedRackTiles) state.racks[placer].push(t);
        state.bag.unshift(...u.taken); // restore draw order for determinism
        state.scores[placer] -= u.score;
        state.scorelessTurns = u.prevScoreless + 1; // the retracted play is now a scoreless turn
        state.turn = challenger;                     // placer forfeits the turn
        state.lastMove = {
          type: 'challenge', player: challenger, upheld: true,
          target: placer, words: payload.words || prev.words, invalid: payload.invalid || [],
        };
      } else {
        // Word(s) valid: the challenger forfeits their turn instead.
        state.scorelessTurns += 1;
        state.turn = 1 - challenger;
        state.lastMove = {
          type: 'challenge', player: challenger, upheld: false,
          words: payload.words || (prev && prev.words) || [],
        };
      }
      state.consecutivePasses = 0; // a challenge breaks a run of passes
      if (scorelessEndReached(state)) finishGame(state, null);
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
