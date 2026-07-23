// Weiqi tutorial curriculum — 15 lessons, from placing your first stone to
// real capturing techniques. The tutorial runner (tutorial.js) walks these
// steps, reconstructing each step's board deterministically so the ← / →
// arrows can move freely and re-read.
//
// Each lesson pairs a worked EXAMPLE with a TASK on a *different* position, so
// the second half is always a fresh configuration teaching the same idea rather
// than a rerun of the picture just shown.
//
// Step shape (all fields optional unless noted):
//   text                 HTML instruction shown in the panel.
//   setup {black,white}   Absolute board when entering the step (also the
//                         reconstruction anchor). Coordinates are [row,col].
//   marks/regions/arrows/labels   Annotations passed straight to the board
//                         renderer (see board.js). A gold ring (circle mark)
//                         is how a task points at where to play.
//   task { ... }         Present ⇒ the step is a task the player must complete
//                         before the → arrow unlocks:
//     seat 'black'|'white'   Whose stone the player places (default 'black').
//     allow [[r,c]...]       The ONLY points that accept a stone (the "lock").
//     solution [r,c]         Canonical move, used to rebuild later boards.
//     replies [[r,c]...]     Opponent's scripted answer, played after a success.
//     check(ctx)             Extra success test; ctx = {r,c,before,after,captured,size}.
//     hint / success / onWrong   Feedback lines.
//     type 'place'|'pass'    'pass' shows a Pass button instead (ends & scores).

import { libertyCount } from './engine.js';

const GOLD = '#f2c14e';
const RED = '#e8604c';
const GREEN = '#5bbf8a';
const BLUE = '#6fb1e0';
const GREY = '#8fa0b2';

// Success-check builders (ctx = {r,c,before,after,captured,size}).
const captured = (n = 1) => (x) => x.captured.length >= n;
const putsInAtari = (tr, tc) => (x) => x.after[tr]?.[tc] != null && libertyCount(x.after, x.size, tr, tc) === 1;
const escapesAtari = (tr, tc) => (x) => libertyCount(x.after, x.size, tr, tc) >= 2;
// Every orthogonal neighbour of (tr,tc) is a black stone (board edges count as
// walls) → a real eye for black.
const makesEye = (tr, tc) => (x) => {
  const b = x.after, S = x.size;
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nr = tr + dr, nc = tc + dc;
    if (nr < 0 || nc < 0 || nr >= S || nc >= S) continue; // edge = wall
    if (b[nr][nc] !== 0) return false;
  }
  return b[tr][tc] === null;
};

const ring = (r, c, color = GOLD) => ({ r, c, shape: 'circle', color });

export const LEVELS = [
  // 1 ───────────────────────────────────────────────────────────────────────
  {
    id: 'place', title: 'Placing stones', size: 9,
    steps: [
      {
        text: 'Welcome to <b>Weiqi</b> — also known as <b>Go</b>. Two players, <b>Black</b> and <b>White</b>, take turns placing stones. Black plays first. The aim is to surround more <b>territory</b> (empty space) than your opponent.',
      },
      {
        text: 'Stones go on the <b>crossings</b> of the lines — the <i>intersections</i> — not inside the squares. Tap the highlighted crossing to place your first Black stone.',
        marks: [ring(4, 4)],
        task: {
          allow: [[4, 4]], solution: [4, 4],
          hint: 'Tap the marked crossing in the centre.',
          success: 'That\'s your first stone. Placed stones never move — they only leave the board if they\'re captured.',
        },
      },
      {
        text: 'Good. In a real game White would now answer somewhere else, and you\'d take turns building shapes and surrounding space. First, though, you need to understand how stones stay alive — and how they\'re captured.',
      },
    ],
  },

  // 2 ───────────────────────────────────────────────────────────────────────
  {
    id: 'liberties', title: 'Liberties', size: 9,
    steps: [
      {
        text: 'Every stone breathes through its <b>liberties</b> — the empty points <b>directly</b> next to it (up, down, left, right; diagonals don\'t count). This lone stone has <b>4</b> liberties, marked here.',
        setup: { black: [[4, 4]] },
        marks: [ring(3, 4, BLUE), ring(5, 4, BLUE), ring(4, 3, BLUE), ring(4, 5, BLUE)],
      },
      {
        text: 'On the <b>edge</b> a stone has only <b>3</b> liberties, and in the <b>corner</b> just <b>2</b>. Fewer liberties means a stone is easier to surround and capture — so the edges and corners are more dangerous places to be.',
        setup: { black: [[0, 4]], white: [[8, 0]] },
        marks: [ring(0, 3, BLUE), ring(0, 5, BLUE), ring(1, 4, BLUE), ring(7, 0, BLUE), ring(8, 1, BLUE)],
      },
      {
        text: 'You take a liberty away by playing next to a stone. This White stone has 4 liberties — place a Black stone on <b>any one</b> of them to take a breath away.',
        setup: { white: [[4, 4]] },
        marks: [ring(3, 4), ring(5, 4), ring(4, 3), ring(4, 5)],
        task: {
          allow: [[3, 4], [5, 4], [4, 3], [4, 5]], solution: [4, 5],
          hint: 'Play on any point next to the White stone.',
          success: 'One liberty gone — White is down to 3. Keep taking them all and the stone is captured.',
        },
      },
    ],
  },

  // 3 ───────────────────────────────────────────────────────────────────────
  {
    id: 'capture', title: 'Capturing a stone', size: 9,
    steps: [
      {
        text: 'When a stone has just <b>one</b> liberty left, it\'s in <b>atari</b> — one move away from capture. This White stone\'s last liberty is marked in red.',
        setup: { black: [[3, 4], [5, 4], [4, 3]], white: [[4, 4]] },
        marks: [{ r: 4, c: 5, shape: 'circle', color: RED }],
        labels: [{ r: 4, c: 4, text: '!', color: RED }],
      },
      {
        text: 'Now a different one — a White stone in atari on the <b>edge</b>. <b>Capture it</b> by filling its last liberty (marked). The stone is lifted straight off the board.',
        setup: { black: [[1, 0], [2, 1]], white: [[2, 0]] },
        marks: [ring(3, 0)],
        task: {
          allow: [[3, 0]], solution: [3, 0], check: captured(1),
          hint: 'Fill the marked last liberty.',
          success: 'Captured! Captured stones are worth a point each at the end. Surrounding is everything in Weiqi.',
        },
      },
    ],
  },

  // 4 ───────────────────────────────────────────────────────────────────────
  {
    id: 'atari', title: 'Giving atari', size: 9,
    steps: [
      {
        text: 'Usually you can\'t capture in one move — first you chase a stone down to its last liberty. Reducing a stone or group to a single liberty is called <b>giving atari</b>. This stone still has two liberties (marked).',
        setup: { black: [[3, 4], [4, 3]], white: [[4, 4]] },
        marks: [ring(5, 4, BLUE), ring(4, 5, BLUE)],
      },
      {
        text: 'Here\'s another White stone with two liberties. Play a move that puts it in <b>atari</b> — down to one liberty — <b>without</b> capturing it yet.',
        setup: { black: [[6, 1], [7, 2]], white: [[6, 2]] },
        marks: [ring(5, 2), ring(6, 3)],
        task: {
          allow: [[5, 2], [6, 3]], solution: [5, 2], check: putsInAtari(6, 2),
          hint: 'Take one of its two liberties.',
          success: 'Atari! White is down to a single liberty and must respond now or lose the stone next move.',
        },
      },
    ],
  },

  // 5 ───────────────────────────────────────────────────────────────────────
  {
    id: 'group', title: 'Capturing a group', size: 9,
    steps: [
      {
        text: 'Stones of the same colour that <b>touch along the lines</b> join into one <b>group</b> and share all their liberties. A group is captured only when its <b>last shared liberty</b> is filled. This White pair has one liberty left.',
        setup: { black: [[3, 4], [3, 5], [5, 4], [5, 5], [4, 3]], white: [[4, 4], [4, 5]] },
        regions: [{ points: [[4, 4], [4, 5]], color: BLUE, label: 'one group' }],
        marks: [{ r: 4, c: 6, shape: 'circle', color: RED }],
      },
      {
        text: 'Now a different group — two White stones stacked <b>vertically</b>, down to their last liberty (marked). <b>Capture the whole group</b> by filling it.',
        setup: { black: [[4, 2], [7, 2], [5, 1], [6, 1], [5, 3]], white: [[5, 2], [6, 2]] },
        regions: [{ points: [[5, 2], [6, 2]], color: BLUE }],
        marks: [ring(6, 3)],
        task: {
          allow: [[6, 3]], solution: [6, 3], check: captured(2),
          hint: 'Fill the group\'s last liberty.',
          success: 'Both stones come off at once. Big groups are stronger, but a surrounded group falls together.',
        },
      },
    ],
  },

  // 6 ───────────────────────────────────────────────────────────────────────
  {
    id: 'escape', title: 'Escaping atari', size: 9,
    steps: [
      {
        text: 'When it\'s <b>your</b> stone in atari, you don\'t have to lose it. One way out is to <b>extend</b> — add a connected stone and gain fresh liberties, running out into open space.',
        setup: { black: [[4, 4]], white: [[3, 4], [4, 3], [4, 5]] },
        marks: [{ r: 5, c: 4, shape: 'circle', color: GREEN }],
        labels: [{ r: 4, c: 4, text: '!', color: RED }],
      },
      {
        text: 'Here\'s one of your Black stones in atari in a different spot. <b>Extend</b> into the open at the marked point to give the group room to breathe.',
        setup: { black: [[2, 6]], white: [[1, 6], [2, 5], [2, 7]] },
        marks: [ring(3, 6)],
        labels: [{ r: 2, c: 6, text: '!', color: RED }],
        task: {
          allow: [[3, 6]], solution: [3, 6], check: escapesAtari(2, 6),
          hint: 'Extend into the empty space below.',
          success: 'Now the group has more liberties — you\'ve escaped. (The other way out is to capture whatever is attacking you.)',
        },
      },
    ],
  },

  // 7 ───────────────────────────────────────────────────────────────────────
  {
    id: 'suicide', title: 'The suicide rule', size: 9,
    steps: [
      {
        text: 'You may <b>not</b> play a stone that would have <b>no liberties</b> — that\'s <b>suicide</b>, and it\'s illegal. The marked point is surrounded by White on all sides, so Black can\'t play there.',
        setup: { white: [[3, 4], [5, 4], [4, 3], [4, 5]] },
        marks: [{ r: 4, c: 4, shape: 'cross', color: RED }],
      },
      {
        text: 'There\'s one exception: a move <b>is</b> legal if it <b>captures</b>. Here the marked point looks surrounded — but playing it takes White\'s last liberty and removes that stone, so your stone ends up with a liberty. <b>Play it.</b>',
        setup: { black: [[3, 4], [5, 4], [4, 3], [3, 5], [5, 5], [4, 6]], white: [[4, 5]] },
        marks: [ring(4, 4)],
        task: {
          allow: [[4, 4]], solution: [4, 4], check: captured(1),
          hint: 'It captures, so it\'s allowed — play the marked point.',
          success: 'Legal! Because it captured, your stone gained a liberty. "Capturing beats suicide" — remember it.',
        },
      },
    ],
  },

  // 8 ───────────────────────────────────────────────────────────────────────
  {
    id: 'ko', title: 'The ko rule', size: 9,
    steps: [
      {
        text: 'Sometimes a single stone can be captured back and forth forever. To stop endless repetition there\'s the <b>ko rule</b>. Here Black can capture the marked White stone — its only liberty is the empty point beside it.',
        setup: { black: [[3, 5], [5, 5], [4, 6]], white: [[3, 4], [4, 3], [5, 4], [4, 5]] },
        marks: [{ r: 4, c: 5, shape: 'triangle', color: RED }],
      },
      {
        text: '<b>Take the ko.</b> Play the empty point to capture that White stone.',
        setup: { black: [[3, 5], [5, 5], [4, 6]], white: [[3, 4], [4, 3], [5, 4], [4, 5]] },
        marks: [ring(4, 4)],
        task: {
          allow: [[4, 4]], solution: [4, 4], check: captured(1),
          hint: 'Capture at the marked point.',
          success: 'Captured. Now your stone sits there in atari — White would love to take it straight back...',
        },
      },
      {
        text: 'But the <b>ko rule forbids White from recapturing immediately</b>, because it would return the board to the position it was just in. White must play elsewhere first (a "ko threat"); only then may they retake. The forbidden point is marked.',
        setup: { black: [[3, 5], [5, 5], [4, 6], [4, 4]], white: [[3, 4], [4, 3], [5, 4]] },
        marks: [{ r: 4, c: 5, shape: 'cross', color: RED }],
      },
    ],
  },

  // 9 ───────────────────────────────────────────────────────────────────────
  {
    id: 'eye', title: 'Eyes', size: 9,
    steps: [
      {
        text: 'An <b>eye</b> is an empty point completely surrounded by one colour. Your opponent can\'t play inside it — that would be suicide. This Black shape has one eye, marked.',
        setup: { black: [[3, 4], [4, 3], [4, 5], [5, 4]] },
        marks: [{ r: 4, c: 4, shape: 'square', color: GREEN }],
        regions: [{ points: [[3, 4], [4, 3], [4, 5], [5, 4]], color: GREEN }],
      },
      {
        text: 'Eyes on the edge need fewer stones — the board edge already forms some of the walls. Complete this <b>corner</b> eye: play the marked point so the corner is fully enclosed.',
        setup: { black: [[0, 1]] },
        marks: [{ r: 0, c: 0, shape: 'square', color: GREEN }, ring(1, 0)],
        task: {
          allow: [[1, 0]], solution: [1, 0], check: makesEye(0, 0),
          hint: 'Close the last open side of the corner.',
          success: 'A real corner eye — walled by your two stones and the two board edges. Eyes keep groups alive.',
        },
      },
    ],
  },

  // 10 ──────────────────────────────────────────────────────────────────────
  {
    id: 'twoeyes', title: 'Two eyes = life', size: 9,
    steps: [
      {
        text: 'The golden rule of life and death: a group with <b>two separate eyes</b> can <b>never</b> be captured. Your opponent can\'t fill both at once, and can\'t play in either. This group has two eyes — it\'s <b>alive</b> forever.',
        setup: { black: [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [8, 2], [8, 4], [8, 6]] },
        marks: [{ r: 8, c: 3, shape: 'square', color: GREEN }, { r: 8, c: 5, shape: 'square', color: GREEN }],
        regions: [{ points: [[7, 2], [7, 6], [8, 2], [8, 6]], color: GREEN, label: 'alive' }],
      },
      {
        text: 'Here\'s a different group, on the <b>right edge</b>, with one eye already made (green). <b>Make the second eye</b> — play the marked point so the lower space becomes an eye too, and the group lives.',
        setup: { black: [[2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [2, 8], [4, 8]] },
        marks: [{ r: 3, c: 8, shape: 'square', color: GREEN }, { r: 5, c: 8, shape: 'square', color: GOLD }, ring(6, 8)],
        task: {
          allow: [[6, 8]], solution: [6, 8], check: makesEye(5, 8),
          hint: 'Enclose the second eye at the marked point.',
          success: 'Two eyes — this group is unconditionally alive. Whatever White does, it can never be captured.',
        },
      },
    ],
  },

  // 11 ──────────────────────────────────────────────────────────────────────
  {
    id: 'oneeye', title: 'One eye is not enough', size: 9,
    steps: [
      {
        text: 'A single eye is <b>not</b> enough to live. This White group has one eye and nothing else — every outside liberty is already filled by Black. Its only remaining liberty is the eye itself.',
        setup: {
          white: [[3, 4], [4, 3], [4, 5], [5, 4]],
          black: [[2, 4], [3, 3], [3, 5], [4, 2], [5, 3], [4, 6], [5, 5], [6, 4]],
        },
        regions: [{ points: [[3, 4], [4, 3], [4, 5], [5, 4]], color: RED, label: 'dead' }],
        marks: [{ r: 4, c: 4, shape: 'square', color: RED }],
      },
      {
        text: 'Here\'s a different one-eyed group, dead in the <b>corner</b>. Finish it: play <b>inside the eye</b>. Normally suicide — but it fills the group\'s last liberty and <b>captures all three stones</b>, so it\'s legal.',
        setup: {
          white: [[0, 1], [1, 0], [1, 1]],
          black: [[0, 2], [1, 2], [2, 1], [2, 0]],
        },
        regions: [{ points: [[0, 1], [1, 0], [1, 1]], color: RED, label: 'dead' }],
        marks: [ring(0, 0)],
        task: {
          allow: [[0, 0]], solution: [0, 0], check: captured(3),
          hint: 'Play in the eye — it captures, so it\'s allowed.',
          success: 'Captured. The lesson: <b>two</b> eyes lives, <b>one</b> eye dies. Making two eyes — or destroying your opponent\'s second — is the heart of the game.',
        },
      },
    ],
  },

  // 12 ──────────────────────────────────────────────────────────────────────
  {
    id: 'territory', title: 'Scoring & passing', size: 9,
    steps: [
      {
        text: 'The game ends when both players <b>pass</b>. Here two <b>solid walls</b> split the board — Black owns the left, White the right. The empty points behind each wall are that player\'s <b>territory</b> (some are dotted).',
        setup: {
          black: [[0, 2], [0, 3], [1, 2], [1, 3], [2, 2], [2, 3], [3, 2], [3, 3], [4, 2], [4, 3], [5, 2], [5, 3], [6, 2], [6, 3], [7, 2], [7, 3], [8, 2], [8, 3]],
          white: [[0, 5], [0, 6], [1, 5], [1, 6], [2, 5], [2, 6], [3, 5], [3, 6], [4, 5], [4, 6], [5, 5], [5, 6], [6, 5], [6, 6], [7, 5], [7, 6], [8, 5], [8, 6]],
        },
        marks: [
          { r: 2, c: 0, shape: 'dot', color: GREEN }, { r: 4, c: 1, shape: 'dot', color: GREEN }, { r: 6, c: 0, shape: 'dot', color: GREEN },
          { r: 2, c: 8, shape: 'dot', color: BLUE }, { r: 4, c: 7, shape: 'dot', color: BLUE }, { r: 6, c: 8, shape: 'dot', color: BLUE },
        ],
      },
      {
        text: 'Your <b>score</b> = your stones on the board + the empty points you surround. White also gets <b>komi</b> — here <b>6.5</b> points — to make up for Black moving first. The half-point means games can never end in a tie. The middle column touches both sides, so it\'s <b>neutral</b> (worth nothing).',
        setup: {
          black: [[0, 2], [0, 3], [1, 2], [1, 3], [2, 2], [2, 3], [3, 2], [3, 3], [4, 2], [4, 3], [5, 2], [5, 3], [6, 2], [6, 3], [7, 2], [7, 3], [8, 2], [8, 3]],
          white: [[0, 5], [0, 6], [1, 5], [1, 6], [2, 5], [2, 6], [3, 5], [3, 6], [4, 5], [4, 6], [5, 5], [5, 6], [6, 5], [6, 6], [7, 5], [7, 6], [8, 5], [8, 6]],
        },
        marks: [{ r: 2, c: 4, shape: 'cross', color: GREY }, { r: 4, c: 4, shape: 'cross', color: GREY }, { r: 6, c: 4, shape: 'cross', color: GREY }],
      },
      {
        text: 'Nothing can be gained by playing on — inside your own area you\'d only fill your own territory, and you can\'t live behind a solid wall. So end the game: tap <b>Pass</b>.',
        setup: {
          black: [[0, 2], [0, 3], [1, 2], [1, 3], [2, 2], [2, 3], [3, 2], [3, 3], [4, 2], [4, 3], [5, 2], [5, 3], [6, 2], [6, 3], [7, 2], [7, 3], [8, 2], [8, 3]],
          white: [[0, 5], [0, 6], [1, 5], [1, 6], [2, 5], [2, 6], [3, 5], [3, 6], [4, 5], [4, 6], [5, 5], [5, 6], [6, 5], [6, 6], [7, 5], [7, 6], [8, 5], [8, 6]],
        },
        task: {
          type: 'pass',
          hint: 'Tap the Pass button to end and score the game.',
          success: 'Counted! Black: 18 stones + 18 territory = <b>36</b>. White: 18 + 18 + 6.5 komi = <b>42.5</b>. White wins by 6.5. That\'s a whole game of Weiqi.',
        },
      },
    ],
  },

  // 13 ──────────────────────────────────────────────────────────────────────
  {
    id: 'ladder', title: 'The ladder', size: 9,
    steps: [
      {
        text: 'A stone with two liberties can sometimes be caught in a <b>ladder</b> — a forced zig-zag where <b>every</b> move is atari, driving it into the corner until it runs out of room. Here\'s a White stone ready to be laddered.',
        setup: { black: [[1, 2], [2, 3], [3, 1]], white: [[2, 2]] },
        marks: [{ r: 2, c: 2, shape: 'triangle', color: RED }],
      },
      {
        text: 'Start the ladder: put White in <b>atari</b> from below. Each time you give atari, White is forced to run to its single liberty — and you chase.',
        setup: { black: [[1, 2], [2, 3], [3, 1]], white: [[2, 2]] },
        marks: [ring(3, 2)],
        task: { allow: [[3, 2]], solution: [3, 2], replies: [[2, 1]], hint: 'Atari at the marked point.', success: 'White runs — chase it again.' },
      },
      {
        text: 'White ran to the left. <b>Keep the ladder going</b> — atari again from above, and White is forced further toward the corner.',
        marks: [ring(1, 1)],
        task: { allow: [[1, 1]], solution: [1, 1], replies: [[2, 0]], hint: 'Atari at the marked point.', success: 'Still forced — one more push.' },
      },
      {
        text: 'Almost there. Atari once more to press White against the edge, where it has nowhere left to run.',
        marks: [ring(3, 0)],
        task: { allow: [[3, 0]], solution: [3, 0], replies: [[1, 0]], hint: 'Atari at the marked point.', success: 'White is trapped on the edge — now finish it.' },
      },
      {
        text: 'The ladder reaches the corner. <b>Capture the whole chain</b> with the final move.',
        marks: [ring(0, 0)],
        task: { allow: [[0, 0]], solution: [0, 0], check: captured(4), hint: 'Fill the last liberty in the corner.', success: 'The entire ladder falls! Warning: a ladder only works if nothing of White\'s waits along its path — a stone there (a "ladder breaker") lets White escape, so read it out before you start.' },
      },
    ],
  },

  // 14 ──────────────────────────────────────────────────────────────────────
  {
    id: 'doubleatari', title: 'Double atari', size: 9,
    steps: [
      {
        text: 'A <b>double atari</b> is one move that puts <b>two</b> separate groups in atari at the same time. Your opponent can only save one — you capture the other. Look for a point that two weak enemy stones share as a liberty.',
        setup: { black: [[2, 5], [3, 6], [6, 5], [5, 6]], white: [[3, 5], [5, 5]] },
        marks: [ring(4, 5)],
      },
      {
        text: 'Here\'s a fresh position. Two White stones each have two liberties and share the marked point. <b>Play it</b> to atari both at once.',
        setup: { black: [[2, 2], [3, 1], [6, 2], [5, 1]], white: [[3, 2], [5, 2]] },
        marks: [ring(4, 2)],
        task: {
          allow: [[4, 2]], solution: [4, 2],
          check: (x) => putsInAtari(3, 2)(x) && putsInAtari(5, 2)(x),
          hint: 'Play the shared liberty.',
          success: 'Double atari! Whichever stone White saves, you capture the other next move. One move, two threats.',
        },
      },
    ],
  },

  // 15 ──────────────────────────────────────────────────────────────────────
  {
    id: 'cutconnect', title: 'Cut & connect', size: 9,
    steps: [
      {
        text: 'Two of your groups that <b>touch</b> are far stronger than two that merely sit close — one strong group is much harder to attack. When there\'s a gap an opponent could push through, <b>connect</b> it.',
        setup: { black: [[4, 3], [4, 5]], white: [[3, 4], [5, 4]] },
        marks: [ring(4, 4)],
      },
      {
        text: 'Here are two Black stones with a gap between them, and White poised to split them. <b>Connect</b> them into one group at the marked point.',
        setup: { black: [[3, 6], [5, 6]], white: [[4, 5], [4, 7]] },
        marks: [ring(4, 6)],
        task: { allow: [[4, 6]], solution: [4, 6], hint: 'Fill the gap to link up.', success: 'Now they\'re one solid group — no weakness for White to exploit.' },
      },
      {
        text: 'The flip side is <b>cutting</b>: keep your opponent\'s stones apart so each stays weak. These two White stones have a one-point gap and want to link at the marked crossing — the <b>cutting point</b>.',
        setup: { black: [[3, 5], [5, 5]], white: [[4, 4], [4, 6]] },
        marks: [{ r: 4, c: 5, shape: 'triangle', color: BLUE }],
      },
      {
        text: 'A different cut. These two White stones want to join through the marked point. <b>Cut them apart</b> — play it so White stays two weak groups you can hunt separately.',
        setup: { black: [[3, 3], [3, 5]], white: [[2, 4], [4, 4]] },
        marks: [ring(3, 4)],
        task: {
          allow: [[3, 4]], solution: [3, 4],
          hint: 'Play between the two White stones.',
          success: 'Cut! White is two weak groups now, not one strong one. Connect your own stones, cut your opponent\'s — that\'s Weiqi in a nutshell. You\'ve finished the tutorial!',
        },
      },
    ],
  },
];
