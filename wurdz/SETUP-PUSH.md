# Enabling Web Push ("your turn" with the browser closed)

The in-app notification (🔔) already works while the tab is alive. These
steps add **server push** so a player gets notified even when their browser
is fully closed. Everything runs on the Supabase project we already use — no
new account. You only need the Supabase CLI installed (`npm i -g supabase`).

## 1. Create the database table

In the Supabase SQL editor, run the `push_subscriptions` section of
[`supabase/schema.sql`](supabase/schema.sql) (the table, its policies, and
the grant). If you'd rather copy/paste, run:

```sql
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  room_code text,                 -- null for signed-in (user-routed) subs
  player int,                     -- null for signed-in (user-routed) subs
  user_id uuid references auth.users (id) on delete cascade,
  game text,
  endpoint text unique not null,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_sub_room_idx on push_subscriptions (room_code, player);
create index if not exists push_sub_user_idx on push_subscriptions (user_id);
alter table push_subscriptions enable row level security;
create policy "players can add push subs" on push_subscriptions for insert to anon, authenticated with check (true);
create policy "players can update push subs" on push_subscriptions for update to anon, authenticated using (true) with check (true);
create policy "players can remove push subs" on push_subscriptions for delete to anon, authenticated using (true);
grant insert, update, delete on table push_subscriptions to anon, authenticated;
```

Signed-in players store their `user_id` here, so a single device subscription
covers every game they play; the function notifies all of an account's devices
across games. Anonymous players store `(room_code, player)` and are notified
per seat, exactly as before.

## 2. Set the VAPID secrets

The **public** key is already in `js/config.js`. The **private** key must be
kept secret — set it (plus a contact `mailto:`) as Edge Function secrets:

```sh
supabase login
supabase link --project-ref ymeobjtrhxbwywcvaova

supabase secrets set \
  VAPID_PUBLIC_KEY="BDw2f2Kt2pCDGw9GpQEZh3G9olKazyL8hQLnRHEmd1-8cogNxMIgZy5G4AZp_9M7QInjdzm2RCJm1N_wbLUUneM" \
  VAPID_PRIVATE_KEY="<the private key I sent you in chat>" \
  VAPID_SUBJECT="mailto:ice.cream.lorry@googlemail.com"
```

(If you ever want to rotate keys, run `npx web-push generate-vapid-keys`,
update the public key in `js/config.js`, and reset the two secrets.)

## 3. Deploy the Edge Function

```sh
supabase functions deploy notify --no-verify-jwt
```

`--no-verify-jwt` is needed because the site uses the new `sb_publishable_…`
API key, which isn't a JWT. The function only ever sends to subscriptions
already stored for a room, so the exposure is limited to "someone who knows a
room code could trigger a redundant "your turn" notification" — fine for a
friends' game.

## 4. On each phone

- **Android:** just open the site and tap 🔔 to allow notifications.
- **iPhone/iPad:** iOS only allows Web Push for installed apps. Open the site
  in Safari, tap **Share → Add to Home Screen**, then open Wurdz from the new
  Home Screen icon and tap 🔔 to allow notifications. (Notifications won't be
  offered in the regular Safari tab — this is an Apple restriction.)

## How it fits together

1. The site registers a service worker (`sw.js`) and, once you allow
   notifications, subscribes the device and stores the subscription in
   `push_subscriptions` keyed by room + seat.
2. When you make a move, your (online) client calls the `notify` Edge
   Function with the seat that now has to play.
3. The function sends a Web Push to that seat's devices; the service worker
   shows it — unless the game is already open and visible, in which case it
   stays quiet.
