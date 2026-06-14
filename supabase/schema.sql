-- Wurdz database schema
-- Run this in the Supabase SQL editor (or via the Supabase MCP server).
--
-- This schema is deliberately game-independent. Several small two-player,
-- turn-based games can share ONE Supabase project: accounts (Supabase Auth)
-- are project-wide, and these tables carry a `game` slug so each game only
-- sees its own rooms. To add another game, point it at the same project and
-- set its GAME_SLUG in js/config.js — no new SQL required.
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
  type text not null,  -- start | place | exchange | pass | challenge | forfeit
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
grant insert, update, delete on table push_subscriptions to anon, authenticated;

-- The notify Edge Function runs as the service role. service_role has
-- BYPASSRLS but that does NOT bypass table privileges, and tables created via
-- raw SQL aren't always granted to it automatically — so grant explicitly.
grant select on table rooms to service_role;
grant select, delete on table push_subscriptions to service_role;
