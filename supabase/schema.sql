-- LB Games shared database schema
-- Run this in the Supabase SQL editor (or via the Supabase MCP server).
--
-- This schema is deliberately game-independent. Multiple games share ONE
-- Supabase project: accounts (Supabase Auth) are project-wide, and these
-- tables carry a `game` slug so each game only sees its own rooms. To add
-- another game, point it at the same project and set its GAME_SLUG in
-- js/config.js — no new SQL required.
--
-- Every statement is written to be safe to re-run, so this doubles as the
-- migration for an existing database.

-- ---- rooms --------------------------------------------------------------

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  host_name text not null,
  guest_name text,
  seed bigint not null,
  status text not null default 'waiting', -- waiting | full | playing | finished
  created_at timestamptz not null default now()
);

-- Columns added for the accounts layer (no-ops if already present).
alter table rooms add column if not exists game text not null default 'wurdz';
alter table rooms add column if not exists host_user_id uuid references auth.users (id) on delete set null;
alter table rooms add column if not exists guest_user_id uuid references auth.users (id) on delete set null;
-- Bumped whenever a move lands, so "My Games" can sort by most recent.
alter table rooms add column if not exists last_move_at timestamptz not null default now();

-- Fast lookup of "all rooms this signed-in player is in, for this game".
create index if not exists rooms_host_user_idx on rooms (game, host_user_id);
create index if not exists rooms_guest_user_idx on rooms (game, guest_user_id);

-- ---- moves --------------------------------------------------------------

create table if not exists moves (
  id bigint generated always as identity primary key,
  room_code text not null references rooms (code) on delete cascade,
  move_index int not null,
  player int not null, -- 0 = host, 1 = guest
  type text not null,  -- wurdz: start|place|exchange|pass|challenge|forfeit · scramblr: start|result
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (room_code, move_index)
);

create index if not exists moves_room_idx on moves (room_code, move_index);

-- ---- Row Level Security -------------------------------------------------
--
-- This is a casual game, so the policies are deliberately permissive for
-- both anonymous and signed-in players. Don't reuse them for anything
-- sensitive. Each policy targets `anon, authenticated` so logged-in users
-- have exactly the same access as guests.

alter table rooms enable row level security;
alter table moves enable row level security;

drop policy if exists "anon can read rooms" on rooms;
drop policy if exists "players can read rooms" on rooms;
create policy "players can read rooms" on rooms
  for select to anon, authenticated using (true);

drop policy if exists "anon can create rooms" on rooms;
drop policy if exists "players can create rooms" on rooms;
create policy "players can create rooms" on rooms
  for insert to anon, authenticated with check (true);

drop policy if exists "anon can update rooms" on rooms;
drop policy if exists "players can update rooms" on rooms;
create policy "players can update rooms" on rooms
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anon can read moves" on moves;
drop policy if exists "players can read moves" on moves;
create policy "players can read moves" on moves
  for select to anon, authenticated using (true);

drop policy if exists "anon can insert moves" on moves;
drop policy if exists "players can insert moves" on moves;
create policy "players can insert moves" on moves
  for insert to anon, authenticated with check (true);

-- ---- Web Push subscriptions ---------------------------------------------
--
-- One row per device that opted in. Routing differs by whether the player is
-- signed in:
--   • signed-in players store their user_id, so the Edge Function can push
--     EVERY game/seat they occupy from a single device subscription — this
--     is what makes "your turn" notifications work across several games.
--   • anonymous players store (room_code, player) and are notified per-seat,
--     exactly as before.
-- The Edge Function reads these with the service role (bypassing RLS).

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  room_code text,                 -- null for signed-in (user-routed) subs
  player int,                     -- 0 = host, 1 = guest (null when user-routed)
  user_id uuid references auth.users (id) on delete cascade,
  game text,                      -- which game this device opted in from
  endpoint text unique not null,  -- the push endpoint (stable per device)
  subscription jsonb not null,    -- full PushSubscription JSON
  created_at timestamptz not null default now()
);

-- Migrate an existing table that predates user-routed pushes.
alter table push_subscriptions add column if not exists user_id uuid references auth.users (id) on delete cascade;
alter table push_subscriptions add column if not exists game text;
alter table push_subscriptions alter column room_code drop not null;
alter table push_subscriptions alter column player drop not null;

create index if not exists push_sub_room_idx on push_subscriptions (room_code, player);
create index if not exists push_sub_user_idx on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;

drop policy if exists "anon can add push subs" on push_subscriptions;
drop policy if exists "players can add push subs" on push_subscriptions;
create policy "players can add push subs" on push_subscriptions
  for insert to anon, authenticated with check (true);

drop policy if exists "anon can update push subs" on push_subscriptions;
drop policy if exists "players can update push subs" on push_subscriptions;
create policy "players can update push subs" on push_subscriptions
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "anon can remove push subs" on push_subscriptions;
drop policy if exists "players can remove push subs" on push_subscriptions;
create policy "players can remove push subs" on push_subscriptions
  for delete to anon, authenticated using (true);

-- ---- Grants (required in addition to RLS policies) ----------------------

grant select, insert, update on table rooms to anon, authenticated;
grant select, insert on table moves to anon, authenticated;
-- Deliberately NO full select for players on push_subscriptions: rows hold
-- other devices' push auth keys. Consequences:
--   • clients cannot UPSERT here (Postgres runs upsert as INSERT … ON
--     CONFLICT DO UPDATE, which needs SELECT on every column referenced via
--     EXCLUDED) — savePushSubscription in shared/rooms.js does
--     delete-then-insert instead;
--   • the endpoint COLUMN alone is select-granted, because any
--     DELETE/UPDATE … WHERE endpoint = … must read that column.
grant insert, update, delete on table push_subscriptions to anon, authenticated;
grant select (endpoint) on table push_subscriptions to anon, authenticated;

-- The notify Edge Function runs as the service role. service_role has
-- BYPASSRLS but that does NOT bypass table privileges, and tables created via
-- raw SQL aren't always granted to it automatically — so grant explicitly.
grant select on table rooms to service_role;
grant select, delete on table push_subscriptions to service_role;

-- ---- N-player rooms (shared rooms layer) --------------------------------
--
-- Replaces the flat host_name/guest_name/host_user_id/guest_user_id columns
-- with a players JSONB array: [{seat, name, userId}, ...].
-- The old flat columns are kept nullable for backward compatibility with any
-- existing data but are no longer written by the application.

-- host_name was NOT NULL in the original schema; new inserts omit it.
alter table rooms alter column host_name drop not null;

-- players JSONB: ordered array of seated players, one entry per seat.
alter table rooms add column if not exists players jsonb not null default '[]';

-- max_players: how many seats the game requires before it can start.
alter table rooms add column if not exists max_players int not null default 2;

-- player_count mirrors jsonb_array_length(players). Used as an optimistic
-- lock in joinRoom so two simultaneous joins never land on the same seat.
alter table rooms add column if not exists player_count int not null default 1;

-- Back-fill existing 2-player rooms from the old flat columns.
update rooms
set players = jsonb_build_array(
  jsonb_build_object('seat', 0, 'name', host_name, 'userId', host_user_id)
)
where players = '[]'::jsonb
  and host_name is not null;

update rooms
set players    = players || jsonb_build_array(
                   jsonb_build_object('seat', 1, 'name', guest_name, 'userId', guest_user_id)
                 ),
    player_count = 2
where guest_name is not null
  and jsonb_array_length(players) = 1;

-- Sync player_count for any rows that diverged (e.g. repeated migrations).
update rooms
set player_count = jsonb_array_length(players)
where player_count != jsonb_array_length(players);

-- Fast containment search: "all rooms where this user has a seat".
create index if not exists rooms_players_gin on rooms using gin (players);

-- Fast index for the new invited-user lookup alongside the GIN search.
create index if not exists rooms_invited_user_idx on rooms (game, invited_user_id);

-- RPC used by fetchMyRooms: returns all rooms a signed-in player appears in
-- (either as a seated player or as the pending invite recipient).
drop function if exists my_rooms(uuid, text);
create function my_rooms(p_user_id uuid, p_game text)
returns setof rooms
language sql stable security definer as $$
  select * from rooms
  where game = p_game
    and (
      players @> jsonb_build_array(jsonb_build_object('userId', p_user_id))
      or invited_user_id = p_user_id
    )
  order by last_move_at desc;
$$;

grant execute on function my_rooms(uuid, text) to anon, authenticated;

-- ---- Finished-game results ----------------------------------------------
--
-- When a game ends we store its final result on the room so history and the
-- lobby can show outcomes WITHOUT replaying the move log. Shape (per game):
--   { "scores": [bySeat...], "winner": <seat>|"tie"|null, "reason": "...",
--     "endedAt": "<iso>" }
-- `scores` is indexed by seat so it lines up with rooms.players.
alter table rooms add column if not exists result jsonb;

-- finish_room: mark a room finished and store its result in one shot, and
-- optionally purge the move log (Wurdz does this — once the result is stored
-- the moves are dead weight). SECURITY DEFINER so it can delete moves without
-- a broad DELETE grant on the table; both clients may call it idempotently.
drop function if exists finish_room(text, jsonb, boolean);
create function finish_room(p_code text, p_result jsonb, p_purge_moves boolean default false)
returns void
language plpgsql security definer as $$
begin
  update rooms
     set status = 'finished',
         result = p_result
   where code = p_code;
  if p_purge_moves then
    delete from moves where room_code = p_code;
  end if;
end;
$$;

grant execute on function finish_room(text, jsonb, boolean) to anon, authenticated;

-- IMPORTANT: my_rooms() above uses `select *`, and a `language sql` function
-- freezes its `*`-expansion at creation time — so the copy created earlier in
-- this file does NOT include the `result` column we just added, and finished
-- games would come back with result = null (empty Game History). Recreate it
-- now that `result` exists so the column is returned. (Kept here, after the
-- column add, so a single top-to-bottom run leaves the function correct.)
drop function if exists my_rooms(uuid, text);
create function my_rooms(p_user_id uuid, p_game text)
returns setof rooms
language sql stable security definer as $$
  select * from rooms
  where game = p_game
    and (
      players @> jsonb_build_array(jsonb_build_object('userId', p_user_id))
      or invited_user_id = p_user_id
    )
  order by last_move_at desc;
$$;

grant execute on function my_rooms(uuid, text) to anon, authenticated;
