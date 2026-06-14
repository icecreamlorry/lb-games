# Wurdz

A two-player multiplayer word game website. Create a room, share the code with
a friend, and play — moves travel over a realtime websocket when the
connection is good, and automatically fall back to syncing through the
database when it isn't.

No sign-up is needed: enter a name, create or join a room, and you're playing.
**Optionally** log in (email + password, or a passwordless magic link) to get
a **My Games** lobby that lets you run several games at once and "your turn"
notifications that span all of them. The account layer is deliberately
game-independent — see [`ACCOUNTS.md`](ACCOUNTS.md) for how to reuse the same
login across other games on one Supabase project.

## How it works

- **Static site, no game server.** Plain HTML/CSS/JS modules with
  [supabase-js](https://supabase.com/docs/reference/javascript) loaded from a
  CDN. Host it anywhere static files can live (GitHub Pages, Netlify,
  Vercel, `npx serve .`).
- **Database is the source of truth.** Every move is inserted into the
  `moves` table first, then broadcast over a Supabase Realtime channel for
  instant delivery. While the websocket is up the badge shows **live**;
  if it drops, the client switches to **database sync** and polls every
  2.5 s instead. On reconnect it catches up from the database, so no move is
  ever lost regardless of connection quality.
- **Deterministic engine.** Each room stores a random seed. Both clients
  shuffle an identical tile bag from that seed and rebuild the entire game
  state by replaying the ordered move log (`js/engine.js`). Refreshing the
  page or reconnecting just replays the log. (Consequence: tile data lives
  client-side, so a determined cheat could peek at the bag — fine for
  friendly games.)

## Setup

1. **Create the tables.** Open the Supabase SQL editor for the project and
   run [`supabase/schema.sql`](supabase/schema.sql). (Or, once the Supabase
   MCP server in `.mcp.json` is authenticated, ask Claude to apply it.)
2. **Paste the anon key.** In the Supabase dashboard go to
   *Project Settings → API Keys*, copy the `anon` / publishable key, and
   paste it into [`js/config.js`](js/config.js). The project URL is already
   filled in.
3. **Serve the site.**

   ```sh
   npx serve .
   ```

   Then open the printed URL in two browsers (or send it to a friend).

## Playing

1. Enter your name, click **Create a Room**, and share the 6-letter room
   code (click it to copy).
2. Your friend enters their name, clicks **Join a Room**, and types the code.
3. Players sit on opposite sides of the board. The host clicks
   **Start Game**; the engine randomly picks who goes first and deals 7
   tiles each.

### Rules implemented

- 15×15 board with the official premium squares (DL, TL, DW, TW), 100-tile
  English set, racks of 7.
- First word must cover the center star and counts the center's double-word
  bonus. Later words must connect to tiles already on the board.
- Place tiles by tapping a rack tile then a square, or by dragging the tile
  onto a square. Drag tiles within the rack to reorder them (or **Shuffle**).
  Tap a placed tile to take it back. **Play** shows a live score preview
  including cross-words. Premiums count only on the turn their square is
  first covered.
- Blanks: choose the letter when you place one; blanks score 0.
- **Exchange** swaps any number of tiles (allowed while ≥7 remain in the
  bag) and forfeits the turn. **Pass** forfeits the turn.
- Playing all 7 tiles in one turn is a bingo: +50 points.
- **Challenge** the opponent's most recent play to check its word(s) against
  the dictionary. If any word is invalid the play is retracted and they lose
  the turn; if all words are valid the challenge fails and the challenger
  loses the turn (the standard "double challenge" rule). The challenger's
  client decides the outcome by dictionary lookup and records it in the move
  log, so both clients replay the same result.
- The game ends when a player uses their last tile with an empty bag, or
  when both players pass twice in a row (four consecutive passes), or after
  six consecutive scoreless turns overall — whichever comes first. A
  game-rendered dialog confirms each pass, and the Pass button turns red once
  the game is one round away from ending. Final scores are adjusted for
  unplayed tiles per the official rules (the player who went out gains the
  opponent's remaining tile values).
- The **2-Letter Words** button opens a searchable reference of every legal
  two-letter word: 107 from the North American NWL2023 list and 127 from
  Collins (international), with definitions.

Dictionary: two-letter words use the curated list above; words of three or
more letters are validated against the public-domain
[ENABLE word list](https://github.com/dolph/dictionary) (~173k words) in
`data/dictionary.txt`, fetched lazily the first time a challenge needs it.

Tap the 🔔 in the game header to get a notification when it becomes your
turn. There are two layers:

- **In-app notification** (always on once allowed): fired by the page when a
  move arrives while the tab is backgrounded (phone locked, switched apps).
  Needs the browser to still be running.
- **Web Push** (optional, set up once): a Supabase Edge Function pushes the
  opponent when you move, so they're notified even with the browser fully
  closed. See [`SETUP-PUSH.md`](SETUP-PUSH.md). On iPhone, Web Push requires
  adding the site to the Home Screen first (an Apple restriction).

Use different names — rejoining a room with the same name resumes that seat,
which is also how refresh/reconnect works.

### Accounts (optional)

Click **Log in or sign up** on the landing screen to create an account with
an email and password, or to get a one-time magic link by email. Signed-in
players land on a **My Games** screen that lists every game they're in, shows
whose turn it is, and lets them jump between boards — so you can have several
games going at once with the same or different people. Your account is matched
to your seat by id, so your display name doesn't have to be unique. Logging in
is never required; the name-only flow still works exactly as before.

Because Supabase Auth is project-wide, the same login also works in any other
game built on the same Supabase project. See [`ACCOUNTS.md`](ACCOUNTS.md).

## Development

```sh
node test/engine.test.mjs   # engine sanity tests
```

Files:

| Path | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | UI shell and styling |
| `js/engine.js` | Deterministic rules engine (bag, placement validation, scoring, endgame) |
| `js/supabaseClient.js` | Shared Supabase client (game-independent) |
| `js/auth.js` | Optional accounts: sign in/up, magic link (game-independent) |
| `js/net.js` | Supabase rooms/moves API, realtime channel, polling fallback |
| `js/main.js` | Screens, lobby, board/rack interaction, drag-and-drop, modals |
| `js/words2.js` | Two-letter word lists (NWL + Collins) |
| `js/dictionary.js` | Lazy word-validity lookup for challenges |
| `data/dictionary.txt` | ENABLE word list (public domain) |
| `js/notify.js`, `sw.js` | "Your turn" notifications (service worker + Web Push) |
| `supabase/functions/notify/` | Edge Function that sends Web Push |
| `manifest.webmanifest`, `icons/` | PWA install metadata (needed for iOS push) |
| `js/config.js` | Supabase URL + anon key |
| `supabase/schema.sql` | Tables and RLS policies |

Rules and word lists sourced from:
[UltraBoardGames tile game rules](https://ultraboardgames.com/scrabble/game-rules.php),
[scrabblewords tournament lists](https://github.com/scrabblewords/scrabblewords).
