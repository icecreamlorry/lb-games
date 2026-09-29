# LB Games API (Cloudflare Worker)

The one backend every LB Games title shares: accounts, rooms + move logs, live
room channels, leaderboards, friends and Web Push. It replaced Supabase in
September 2026. The games themselves stay static on GitHub Pages and talk to
this over `fetch` / WebSocket through [`shared/api.js`](../shared/api.js); the
endpoint lives in [`shared/api-config.js`](../shared/api-config.js).

| Piece | What |
| --- | --- |
| `src/index.js` | Router + every handler. D1 has no row-level security, so all access rules live here |
| `src/room-hub.js` | `RoomHub` Durable Object — one per room code; relays broadcasts + presence over WebSockets (hibernation API) |
| `src/webpush.js` | Web Push: VAPID (ES256) + aes128gcm encryption, WebCrypto only |
| `src/crypto.js` | base64url, HS256 session tokens, PBKDF2 password hashes |
| `schema.sql` | D1 schema (idempotent — doubles as the migration) |
| `wrangler.jsonc` | Bindings, for `npx wrangler deploy` |

## Resources

- **Worker** `lb-games-api` on `*.workers.dev`
- **D1** database `lb-games` (`dbd44fe1-5fdb-4746-90d9-1cc7b78e6fb9`, WEUR)
- **Durable Object** class `RoomHub` (SQLite-backed, free-plan compatible)
- **Secrets**: `JWT_SECRET` (session signing), `VAPID_PRIVATE_JWK` (push signing
  key; its public half is `VAPID_PUBLIC_KEY` in `shared/api-config.js`). They were
  generated inside Cloudflare at first deploy and have never been in this repo.

## API

All JSON. Signed-in calls send `Authorization: Bearer <token>`.

| Route | |
| --- | --- |
| `POST /auth/signup` `{email,password,name}` · `POST /auth/login` `{email,password}` | → `{ token, user }` |
| `GET /auth/me` | validate + refresh the session (sliding 60 days) |
| `POST /auth/update` `{name?, password?}` | |
| `GET /auth/config` | `{ email }` — whether email links work (see below) |
| `POST /auth/magic`, `POST /auth/reset`, `POST /auth/redeem` | email-link sign-in / reset |
| `POST /rooms` · `GET/PATCH /rooms/:code` · `GET /rooms/mine?game=` | rooms (PATCH takes `{ set, expect }`; `expect.player_count` is the join lock) |
| `GET/POST /rooms/:code/moves` · `POST /rooms/:code/finish` | move log (duplicate `move_index` → 409, `code: '23505'`) |
| `GET /rooms/:code/ws?key=<seat>&name=` | live channel (WebSocket) |
| `POST /scores` · `GET /scores?game=&limit=` · `GET /scores/mine?game=&key=` · `GET /scores/friends?game=` | leaderboards (`u:<id>` / `g:<guest id>` keys, higher score kept) |
| `/friends…` | profile + friend code, requests, list, remove |
| `POST /push/subscribe` · `POST /push/unsubscribe` · `POST /push/notify` | Web Push |

## Deploying

```sh
cd worker
npx wrangler deploy                       # code + bindings
npx wrangler d1 execute lb-games --remote --file schema.sql   # schema changes
```

## Email links (magic link / forgot password)

Off for now: Cloudflare Email Sending needs the **Workers Paid** plan and a
domain onboarded to Cloudflare Email Service. Until then the Worker answers 501
and the UI hides those buttons (email + password sign-in always works). To turn
it on: onboard a domain, add `"send_email": [{ "name": "EMAIL" }]` and a var
`EMAIL_FROM` to `wrangler.jsonc`, deploy.

## Transitional Supabase hooks (delete when done)

- `LEGACY_SUPABASE_URL` / `LEGACY_SUPABASE_ANON_KEY` — accounts copied from
  Supabase carry no password hash (hashes weren't exported). On an account's
  first sign-in the Worker checks the password against Supabase Auth once, then
  stores its own hash. When every migrated account has signed in
  (`select email from users where password_hash is null` is empty), delete both
  vars and shut the Supabase project down.
- `MIGRATE_FROM_SUPABASE` + `POST /admin/import-supabase?table=rooms|moves|scores&offset=N`
  — one-time, idempotent copy of the public tables. Remove the var after cutover.
