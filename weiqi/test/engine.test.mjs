// Run: node weiqi/test/engine.test.mjs
import {
  SIZES, KOMI, emptyBoard, groupAt, libertyCount, tryPlay, hasLegalMove,
  newGameState, applyMove, replayMoves, computeScore, colorOf, whiteSeat,
} from '../js/engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

// --- helpers to build a board from ASCII: '.'=empty '0'=seat0 '1'=seat1 ---
function boardFrom(rows) {
  return rows.map((row) => row.split('').map((ch) => (ch === '.' ? null : Number(ch))));
}

// --- liberties ---
{
  const b = boardFrom([
    '.....',
    '..0..',
    '.....',
    '.....',
    '.....',
  ]);
  ok(libertyCount(b, 5, 1, 2) === 4, 'a stone in open space has 4 liberties');
  const corner = boardFrom(['0....', '.....', '.....', '.....', '.....']);
  ok(libertyCount(corner, 5, 0, 0) === 2, 'a corner stone has 2 liberties');
  const edge = boardFrom(['..0..', '.....', '.....', '.....', '.....']);
  ok(libertyCount(edge, 5, 0, 2) === 3, 'an edge stone has 3 liberties');
}

// --- groups share liberties ---
{
  const b = boardFrom([
    '.....',
    '.00..',
    '.....',
    '.....',
    '.....',
  ]);
  const g = groupAt(b, 5, 1, 1);
  ok(g.stones.length === 2, 'connected stones form one group');
  ok(g.liberties.size === 6, 'a 2-stone group in open space has 6 liberties');
}

// --- capturing a single stone ---
{
  // White (1) stone at (1,1) surrounded on three sides by black (0); black
  // fills the last liberty to capture.
  const b = boardFrom([
    '.0...',
    '01...', // (1,1)=white, in atari; (1,2) is the capturing point
    '.0...',
    '.....',
    '.....',
  ]);
  b[1][1] = 1; // white in atari (libs: only (1,2))
  ok(libertyCount(b, 5, 1, 1) === 1, 'white stone is in atari (1 liberty)');
  const res = tryPlay(b, 5, 1, 2, 0); // black plays the last liberty
  ok(res.ok, 'capturing move is legal');
  ok(res.captured.length === 1 && res.board[1][1] === null, 'the white stone is removed');
}

// --- capturing a group ---
{
  const b = boardFrom([
    '.00..',
    '0110.'.replace(/1/g, '1'),
    '.00..',
    '.....',
    '.....',
  ]);
  // white group at (1,1),(1,2); black surrounds all but (1,3)? Rebuild cleanly:
  const g = boardFrom([
    '.00..',
    '011..',
    '.00..',
    '.....',
    '.....',
  ]);
  g[1][0] = 0; g[1][3] = null;
  // white group (1,1)(1,2) liberties: (1,3) only
  ok(libertyCount(g, 5, 1, 1) === 1, 'white 2-group is in atari');
  const res = tryPlay(g, 5, 1, 3, 0);
  ok(res.ok && res.captured.length === 2, 'filling the last liberty captures the whole group');
  ok(res.board[1][1] === null && res.board[1][2] === null, 'both white stones removed');
}

// --- suicide is illegal, but legal if it captures ---
{
  // Black stones surround a single empty point (0,0)'s corner: playing white
  // there is suicide.
  const b = boardFrom([
    '.0...',
    '0....',
    '.....',
    '.....',
    '.....',
  ]);
  const suicide = tryPlay(b, 5, 0, 0, 1); // white into a corner enclosed by black
  ok(!suicide.ok, 'suicide (no liberties, no capture) is illegal');

  // But the same shape is legal when it captures. White at (0,1) & (1,0) in
  // atari; black plays (0,0) capturing... construct a capturing "suicide":
  const cap = boardFrom([
    '.10..',
    '10...',
    '.....',
    '.....',
    '.....',
  ]);
  // white at (0,1),(1,0); black at (0,2),(1,1). White group liberty: (0,0).
  // Black plays (0,0): its own stone would have 0 libs BUT it captures white.
  cap[0][0] = null;
  const res = tryPlay(cap, 5, 0, 0, 0);
  ok(res.ok && res.captured.length >= 1, 'a move that captures is legal even filling its own last liberty');
}

// --- ko: no immediate recapture ---
{
  // Classic ko shape. Seat0=black, seat1=white.
  //   . W B .
  //   W . W B      <- the two center points are the ko
  //   . W B .
  const b = boardFrom([
    '.10..',
    '1010.'.slice(0, 5),
    '.10..',
    '.....',
    '.....',
  ]);
  // Set up: white at (0,1)(1,0)(1,2)(2,1); black at (0,2)(1,3)(2,2); empty (1,1)
  const k = emptyBoard(5);
  k[0][1] = 1; k[1][0] = 1; k[1][2] = 1; k[2][1] = 1;
  k[0][2] = 0; k[2][2] = 0; k[1][3] = 0;
  // Black plays (1,1) capturing white (1,2)? white(1,2) libs: (1,1) only after?
  // white (1,2) neighbours: (0,2)=black,(2,2)=black,(1,1)=empty,(1,3)=black → lib (1,1).
  const res = tryPlay(k, 5, 1, 1, 0); // black captures the white stone at (1,2)
  ok(res.ok && res.captured.length === 1, 'black takes the ko');
  ok(res.koPoint && res.koPoint[0] === 1 && res.koPoint[1] === 2, 'ko point is the captured spot');
  // White cannot immediately retake at the ko point.
  const retake = tryPlay(res.board, 5, 1, 2, 1, res.koPoint);
  ok(!retake.ok, 'immediate ko recapture is forbidden');
}

// --- deterministic colours + start sizes the board ---
{
  const s1 = newGameState(12345);
  const s2 = newGameState(12345);
  ok(s1.blackSeat === s2.blackSeat, 'same seed → same black seat');
  ok(whiteSeat(s1) === 1 - s1.blackSeat, 'white seat is the other seat');
  const st = replayMoves(777, [
    { move_index: 0, player: 0, type: 'start', payload: { size: 9 } },
  ]);
  ok(st.size === 9 && st.board.length === 9, 'start move sizes the board');
  ok(st.turn === st.blackSeat, 'black moves first');
}

// --- full move flow + pass-pass scoring ---
{
  const moves = [
    { move_index: 0, player: 0, type: 'start', payload: { size: 5 } },
  ];
  const s = replayMoves(42, moves);
  const black = s.blackSeat;
  const white = 1 - black;
  // Black builds a wall splitting a 5x5 so it owns the left, white the right.
  const seq = [
    [black, 0, 1], [white, 0, 3],
    [black, 1, 1], [white, 1, 3],
    [black, 2, 1], [white, 2, 3],
    [black, 3, 1], [white, 3, 3],
    [black, 4, 1], [white, 4, 3],
  ];
  let idx = 1;
  for (const [seat, r, c] of seq) {
    applyMove(s, { move_index: idx++, player: seat, type: 'place', payload: { r, c } });
  }
  applyMove(s, { move_index: idx++, player: black, type: 'pass', payload: {} });
  applyMove(s, { move_index: idx++, player: white, type: 'pass', payload: {} });
  ok(s.gameOver, 'two passes end the game');
  ok(s.score, 'a score was computed');
  // Black area: column 0 (territory, 5) + column 1 (stones, 5) = 10.
  ok(s.score.area[black] === 10, 'black area counts its stones + surrounded column');
  ok(s.score.final[white] === s.score.area[white] + KOMI, 'white receives komi');
}

// --- resign ends immediately for the opponent ---
{
  const s = replayMoves(9, [{ move_index: 0, player: 0, type: 'start', payload: { size: 9 } }]);
  applyMove(s, { move_index: 1, player: 0, type: 'forfeit', payload: {} });
  ok(s.gameOver && s.winner === 1, 'resigning hands the win to the opponent');
}

// --- occupied / off-board rejected ---
{
  const b = emptyBoard(5);
  b[2][2] = 0;
  ok(!tryPlay(b, 5, 2, 2, 1).ok, 'cannot play on an occupied point');
  ok(!tryPlay(b, 5, -1, 0, 0).ok, 'cannot play off the board');
  ok(hasLegalMove(b, 5, 1), 'legal moves exist on a nearly-empty board');
}

console.log(`\nweiqi engine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
