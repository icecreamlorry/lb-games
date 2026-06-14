# Accounts & Leaderboard

Chromagrid uses the same **project-wide login** as Wurdz: accounts live at the
Supabase *project* level, so one account works across every game that points at
the project. Login is **optional** — players can just enter a name and play as a
guest, and still appear on the leaderboard.

## Files (the game-agnostic login layer)

Copied verbatim from Wurdz — only `config.js` changes per game:

| File | Role |
| --- | --- |
| `js/config.js` | Supabase URL + anon key (shared), and this game's `GAME_SLUG` / `GAME_NAME` |
| `js/supabaseClient.js` | Singleton Supabase client |
| `js/auth.js` | Thin wrapper over Supabase Auth (sign up / in / out, magic link, display name) |
| `js/leaderboard.js` | Chromagrid score submit / fetch |
| `js/account-ui.js` | Wires the above into Chromagrid's screens |

The game logic (the big inline `<script>` in `index.html`) is untouched — it
just dispatches a `chromagrid:gameover` event with the final score, which
`account-ui.js` listens for to record the run and show the leaderboard.

## One-time Supabase setup

1. **Create the leaderboard table.** In the Supabase dashboard → SQL Editor,
   run [`supabase/leaderboard.sql`](supabase/leaderboard.sql). It is safe to
   re-run. It creates a game-slugged `scores` table (so other games can share
   it), public read access, and an atomic `submit_score()` RPC that keeps each
   player's best score.

2. **(Magic links only) allow the redirect URL.** Auth → URL Configuration →
   Redirect URLs, add the deployed game URL:
   `https://icecreamlorry.github.io/chromagrid/`. Email + password sign-in
   works without this.

That's it. The anon key in `js/config.js` is a *publishable* key and is safe to
ship in client code — access is governed by Row Level Security, and all writes
go through the `submit_score()` function rather than direct table access.

## How players are identified

- **Logged in:** keyed by their Supabase user id (`u:<id>`), name from their
  account display name.
- **Guest:** keyed by a random id kept in `localStorage` (`g:<id>`), name from
  the "Set name" prompt (defaults to `Player`).

Either way a returning player keeps updating their own single leaderboard row.
