# Chess

Classic two-player **chess** for LB Games — asynchronous, and built on the same
shared rooms / accounts / push layer as Wurdz and Weiqi. Includes a 15-lesson
**Training** mode that teaches the game from how each piece moves up to
checkmate, castling, en passant, promotion and a couple of basic tactics.

## Playing

Create a game and pick a **per-move time control**:

| Option | Per move | Notes |
| --- | --- | --- |
| **Unlimited** | — | No timer; play over hours or days. |
| **3 days** | 3 days | Relaxed correspondence. |
| **1 day** | 1 day | A move or two a day. |
| **1 hour** | 1 hour | Same-evening games. |
| **10 min** | 10 min | Casual, sit-down pace. |
| **1 min** | 1 min | Fast and sharp. |
| **Training** | — | 15 guided lessons; solo, no opponent needed. |

Share the room code (or challenge a friend from your account). The seed decides
who plays White (and therefore moves first). On your turn, **tap one of your
pieces** to see its legal moves, then tap a highlighted square — or **drag** the
piece — to move there. A pawn reaching the last rank opens a **promotion** picker.
Castling and en passant light up automatically when they're legal.

By default moves are **staged for confirmation** (a preview with Confirm / Cancel,
or re-tap the destination); the **Confirm moves** toggle in the burger menu turns
this off for instant play. Both the timer and this toggle come from the shared
turn-based-table-game kit (`shared/time-control.js`, `shared/move-confirm.js`).

Like Wurdz and Weiqi, Chess is happily asynchronous: an opponent going
**offline** is fine, and turn notifications (in-app, plus Web Push when
configured) tell you when it's your move.

## The per-move clock

The time control is a budget **per move** that resets each turn — not a single
game clock — which is what makes both blitz and multi-day correspondence work
from the same UI. The clock is anchored to the last move's server timestamp
(`rooms.last_move_at`), so a reload mid-turn shows the right remaining time. When
a player's clock hits zero:

- their own open client submits a **`timeout`** move conceding the game;
- the opponent's client claims the win after a short grace period (for clock
  skew) by submitting the same move.

Both target the same `move_index`, so the unique `(room_code, move_index)`
constraint means only one lands and both sides agree on the result. Flagging
against a lone king (or other material that **can't** checkmate) is scored a
**draw**, per FIDE. **Unlimited** games run no clock at all.

## Rules implemented

Full legal-move generation: pawn pushes/captures, the two-square jump,
**en passant**, **promotion** (with underpromotion), knight/bishop/rook/queen/king
moves, **castling** (both sides, with all the through-check / empty-square /
not-moved conditions), and pins (you can't leave your own king in check).

Game endings: **checkmate**, **resignation**, **timeout**, and draws by
**stalemate**, **insufficient material** (K vs K, K+minor vs K, K+B vs K+B on the
same colour), the **fifty-move rule**, **threefold repetition**, and **agreement**
(offer a draw with the ½ button).

## Training

`js/tutorial.js` runs a data-driven lesson engine (`js/tutorial-levels.js`). Each
step is authored as a **FEN** position and can show instructional text, draw
annotations (rings, arrows, region outlines, ghost pieces, labels) and **lock**
the board so the player can only play the move(s) the lesson asks for. The ← / →
arrows move between steps freely so you can re-read; the → arrow only unlocks a
task once it's solved. Progress is saved per lesson in `localStorage`.

The 15 lessons: pawns · rook · bishop · queen · knight · king · winning material ·
check · getting out of check · checkmate · castling · en passant · promotion ·
the fork · back-rank mate.

## Architecture

- `js/engine.js` — pure, deterministic chess rules folded from the move log
  (`start` / `move` / `resign` / `timeout` / `draw-offer` / `draw-accept` /
  `draw-decline`). Every client rebuilds the same position by replaying moves, so
  the database is the single source of truth. Includes FEN parsing and a `perft`
  helper for the tests. The per-move time control rides the `start` move.
- `js/board.js` — shared SVG board renderer + tap input (orientation flip, legal-
  move dots, highlights, and a tutorial annotation layer), used by both the live
  game and the tutorial.
- `js/main.js` — screens, rooms, time-control / training setup, play, the per-move
  clock + timeout claims, promotion, draw offers, offline presence, resignation,
  turn notifications, rematch, game-over UI.
- `js/{config,net,notify}.js` — per-game identity over the shared layer.

No build step; everything is vanilla ES modules.

## Tests

```
node chess/test/engine.test.mjs      # rules: perft (start / Kiwipete / pos-3), castling, ep, promotion, mates, draws
node chess/test/tutorial.test.mjs    # every lesson move is legal & satisfies its predicate
```

## Regenerating icons

The app icons are drawn programmatically (no image toolchain needed):

```
node chess/tools/make-icons.mjs
```

## Database

Chess reuses the shared schema unchanged — the time control rides the `start`
move and the host's chosen control is stamped onto their player record, so no new
columns are needed (see `worker/schema.sql`).
