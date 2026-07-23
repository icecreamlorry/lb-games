# Weiqi

The ancient game of **Go** (Chinese: 围棋 *wéiqí*) for LB Games — two-player,
asynchronous, and built on the same shared rooms / accounts / push layer as
Wurdz. Includes a 15-lesson **Training** mode that teaches the game from the
very first stone.

## Playing

Create a game and pick a board:

| Option | Board | Notes |
| --- | --- | --- |
| **Beginner** | 9 × 9 | Quick to learn, a full game in minutes. |
| **Intermediate** | 13 × 13 | A real fight without the marathon. |
| **Full** | 19 × 19 | The classic board. |
| **Training** | — | 15 guided lessons; solo, no opponent needed. |

Share the room code (or challenge a friend from your account). Black plays
first; the seed decides who is Black. On your turn, **tap an intersection to
preview** your stone (captures are previewed too), then tap it again — or press
**Play** — to confirm. **Pass** when nothing useful is left; two passes in a row
end the game and the board is scored.

Like Wurdz, Weiqi is happily asynchronous: an opponent going **offline** is
fine, and turn notifications (in-app, plus Web Push when configured) tell you
when it's your move.

## Rules implemented

- **Liberties & capture** — a stone or connected group is removed when its last
  liberty is filled.
- **Suicide** is illegal, *unless the move captures*.
- **Ko** — you can't immediately recapture a single stone in a way that repeats
  the previous position (the ko point is marked on the board).
- **Scoring** — area (Chinese-style): each side's stones on the board plus the
  empty points it surrounds; White gets **6.5 komi**. The half-point means no
  ties. The count assumes dead stones are already captured or surrounded, so
  settle the position before you pass (the convention casual Go apps use).

## Training

`js/tutorial.js` runs a data-driven lesson engine (`js/tutorial-levels.js`).
Each step can show instructional text, draw annotations on the board (point
marks, region outlines around formations, ghost/hint stones, arrows), and
**lock** the board so the player can only play the point(s) the lesson asks for.
The ← / → arrows move between steps freely so you can re-read; the → arrow only
unlocks a task step once it's solved. Progress is saved per lesson in
`localStorage`.

The 15 lessons: placing stones · liberties · capturing a stone · giving atari ·
capturing a group · escaping atari · suicide & its exception · the ko rule ·
eyes · two eyes = life · one eye is not enough · territory, komi & passing ·
the ladder · double atari · cut & connect.

## Architecture

- `js/engine.js` — pure, deterministic Go rules folded from the move log
  (`start` / `place` / `pass` / `forfeit`). Every client rebuilds the same
  position by replaying moves, so the database is the single source of truth.
- `js/board.js` — shared SVG goban renderer + tap input, used by both the live
  game and the tutorial.
- `js/main.js` — screens, rooms, board-size / training setup, play, offline
  presence, resignation, turn notifications, rematch, scoring UI.
- `js/{config,net,notify}.js` — per-game identity over the shared layer.

No build step; everything is vanilla ES modules.

## Tests

```
node weiqi/test/engine.test.mjs      # Go rules: liberties, capture, ko, suicide, scoring
node weiqi/test/tutorial.test.mjs    # every lesson solution is legal & satisfies its check
```

## Regenerating icons

The app icons are drawn programmatically (no image toolchain needed):

```
node weiqi/tools/make-icons.mjs
```

## Database

Weiqi reuses the shared schema unchanged — the board size rides the `start`
move, so no new columns are needed. Run `supabase/setup.sql` if you haven't
already (it's idempotent).
