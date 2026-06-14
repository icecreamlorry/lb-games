# Accounts — the reusable login layer

Login in Wurdz is **optional** and **shared across games**. Anyone can still
just type a name and play. But if a player signs in, that account works in
*every* game you build on the same Supabase project — one login, no separate
sign-up per game — and they get a **My Games** lobby plus "your turn"
notifications that span all their games at once.

This page explains how to drop the same layer into another small game.

## Why it's shareable

- **Accounts are project-wide.** Supabase Auth lives at the project level, so
  every site pointed at the same project URL/key already shares the same set
  of users. Nothing to sync.
- **The tables are game-independent.** `rooms`, `moves`, and
  `push_subscriptions` carry a `game` slug. Each game filters to its own slug,
  so games never see each other's rooms even though they share the tables.
- **The code is split into game-agnostic and game-specific parts.** The
  account layer doesn't know anything about Wurdz.

## What to copy into another game

These files are game-independent — copy them as-is:

| File | Purpose |
| --- | --- |
| `js/supabaseClient.js` | Shared Supabase client (session persistence, magic-link return) |
| `js/auth.js` | Sign up / in / out, magic link, display name — no game logic |
| `supabase/schema.sql` | The shared, game-independent tables + RLS (run **once** per project) |

Then, in the new game:

1. **Set two lines in `js/config.js`** — reuse the same `SUPABASE_URL` /
   `SUPABASE_ANON_KEY`, and give the game its own identity:

   ```js
   export const GAME_SLUG = 'chess';   // unique per game; keeps rooms separate
   export const GAME_NAME = 'Chess';
   ```

2. **Use the same room/move helpers.** `js/net.js` (`createRoom`, `joinRoom`,
   `fetchMyRooms`, `RoomConnection`, push helpers) is already written against
   the generic schema and `GAME_SLUG`. The only game-specific code is the
   rules engine and board UI.

3. **Wire the UI.** The login modal + "My Games" lobby pattern in
   `index.html` / `js/main.js` / `css/style.css` can be lifted across; only
   the per-room summary (whose turn / score) is game-specific.

No new SQL is needed for additional games — the schema is shared.

## Login methods

Both are supported out of the box (`js/auth.js`):

- **Email + password** — works immediately, no email delivery required.
- **Magic link** — passwordless; needs email sending enabled in the Supabase
  project (Auth → Providers → Email) and the site URL added under
  **Auth → URL Configuration → Redirect URLs** (e.g. your GitHub Pages URL).
  The default Supabase email sender is rate-limited, so configure your own
  SMTP for anything beyond light testing.

Display names live in `user_metadata.display_name`. The friends layer (below)
also mirrors the name into a `profiles` row so other players can see it —
`user_metadata` isn't readable by anyone but its owner.

## Friends & profiles (cross-game)

A second game-independent layer adds a project-wide friends graph. Like the
accounts layer, it's shared across every game on the project — your friends
are your friends in all of them.

- **`supabase/friends.sql`** — run **once** per project. Creates `profiles`
  (one per user, with a unique shareable **friend code**) and `friendships`
  (a request that becomes mutual on accept), all locked behind
  `SECURITY DEFINER` RPCs. It also adds `rooms.invited_user_id` /
  `invited_name` for direct challenges and a `friends_leaderboard()` helper.
- **`js/friends.js`** — copy as-is. Wraps the RPCs: `ensureProfile`,
  `addFriendByCode`, `listFriends`, `listFriendRequests`, `respondToRequest`,
  `removeFriend`.
- **Profile button** (top-right) opens a panel to change your display name,
  sign out, copy your friend code, add friends, and answer requests.

### Direct friend challenges (Wurdz)

From the profile panel's friends list (or the lobby's **Challenge a friend**),
picking a friend creates a room already addressed to them (`invited_user_id`).
It shows up in their **My Games** list within one poll as "*X* challenged you —
tap to accept", no code to share. Accepting claims the guest seat as usual.

A best-effort Web Push also fires to the invited friend. That path needs the
updated **`notify` Edge Function redeployed** (it now accepts a `user_id`
target); the lobby still surfaces the challenge without it.

## Notifications across games

A signed-in device stores **one** push subscription tagged with the user id
(not a single seat). When any of their games hands them the turn, the
`notify` Edge Function looks up that seat's `user_id` and pushes every device
the account registered — so a player juggling several games is notified for
all of them. The service worker only suppresses the alert when the player is
actually looking at *that* game's room. Anonymous players keep the old
per-seat behaviour.
