-- ============================================================================
-- LB Games — combined Supabase setup
-- ----------------------------------------------------------------------------
-- One script that sets up / migrates the whole shared Supabase project for
-- every game (Wurdz, Scramblr, Splitz, Chromagrid). It is the four files from
-- the supabase/ folder concatenated in dependency order:
--     1) schema.sql       rooms, moves, push_subscriptions, finish_room, my_rooms
--     2) leaderboard.sql  scores + submit_score
--     3) friends.sql      profiles, friendships, friend invites, friend RPCs
--     4) security.sql     hardened submit_score, room guard, friends RPC lockdown
--
-- Every statement is idempotent, so this is safe to run on a fresh project OR
-- to re-run on an existing one to bring it back in sync with the app. Paste the
-- whole thing into the Supabase SQL Editor and Run. If the editor reports an
-- error, fix that one statement and re-run — the run is a single transaction,
-- so an error rolls everything back (which is why a half-applied grant earlier
-- may not have stuck).
-- ============================================================================

-- ── prerequisites ──────────────────────────────────────────────────────────
-- Ensure the rooms table and its invite columns exist before the schema
-- section below indexes/queries them (the invite columns are otherwise only
-- added later, in the friends section). No-ops on an existing database.
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  host_name text not null,
  guest_name text,
  seed bigint not null,
  status text not null default 'waiting',
  created_at timestamptz not null default now()
);
alter table rooms add column if not exists invited_user_id uuid references auth.users (id) on delete set null;
alter table rooms add column if not exists invited_name text;


-- ========================== 1/4  schema.sql =================================
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
  type text not null,  -- wurdz: start|place|exchange|pass|challenge|forfeit · scramblr: start|result · weiqi: start|place|pass|forfeit
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
--   • clients cannot UPSERT here directly (Postgres runs upsert as INSERT … ON
--     CONFLICT DO UPDATE, which needs SELECT on every column referenced via
--     EXCLUDED) — so subscribing goes through save_push_subscription() below;
--   • the endpoint COLUMN alone is select-granted, because any
--     DELETE/UPDATE … WHERE endpoint = … must read that column.
grant insert, update, delete on table push_subscriptions to anon, authenticated;
grant select (endpoint) on table push_subscriptions to anon, authenticated;

-- The notify Edge Function runs as the service role. service_role has
-- BYPASSRLS but that does NOT bypass table privileges, and tables created via
-- raw SQL aren't always granted to it automatically — so grant explicitly.
grant select on table rooms to service_role;
grant select, delete on table push_subscriptions to service_role;

-- ---- save_push_subscription() -------------------------------------------
-- Atomic upsert keyed on the endpoint's unique constraint. The old client-side
-- delete-then-insert wasn't atomic: two near-simultaneous subscribes for the
-- same device raced as delete, delete, insert, insert — the second insert
-- tripping push_subscriptions_endpoint_key. A single INSERT … ON CONFLICT can't
-- race. It runs SECURITY DEFINER (as the owner) so it may read the conflicting
-- row despite the no-SELECT grant, and — like submit_score — derives the
-- signed-in user from the JWT (auth.uid()) instead of trusting the caller, so a
-- device can't be attached to someone else's account. Signed-in devices are
-- user-routed (room_code/player forced null); guests are seat-routed.
create or replace function save_push_subscription(
  p_endpoint     text,
  p_subscription jsonb,
  p_game         text,
  p_room_code    text default null,
  p_player       int  default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  insert into push_subscriptions (endpoint, subscription, game, user_id, room_code, player)
  values (
    p_endpoint, p_subscription, p_game,
    uid,
    case when uid is null then p_room_code end,
    case when uid is null then p_player end
  )
  on conflict (endpoint) do update
    set subscription = excluded.subscription,
        game         = excluded.game,
        user_id      = excluded.user_id,
        room_code    = excluded.room_code,
        player       = excluded.player,
        created_at   = now();
end;
$$;

grant execute on function save_push_subscription(text, jsonb, text, text, int) to anon, authenticated;

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


-- ======================= 2/4  leaderboard.sql ===============================
-- Chromagrid leaderboard schema.
-- Run this in the Supabase SQL editor (or via the Supabase MCP server).
--
-- Deliberately game-independent, matching the rest of the shared project:
-- every row carries a `game` slug, so several small games can keep their
-- high scores in this one table. To add another game's leaderboard, point it
-- at the same project and set its GAME_SLUG in js/config.js — no new SQL.
--
-- Every statement is safe to re-run, so this doubles as the migration.

-- ---- scores -------------------------------------------------------------

create table if not exists scores (
  id          uuid primary key default gen_random_uuid(),
  game        text not null,
  player_key  text not null,          -- 'u:<auth user id>' or 'g:<guest id>'
  user_id     uuid references auth.users (id) on delete set null,
  name        text not null,
  score       int  not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (game, player_key)
);

create index if not exists scores_game_score_idx on scores (game, score desc);

-- ---- Row Level Security -------------------------------------------------

alter table scores enable row level security;

-- The leaderboard is public to read.
drop policy if exists "anyone can read scores" on scores;
create policy "anyone can read scores" on scores
  for select to anon, authenticated using (true);

grant select on table scores to anon, authenticated;

-- Writes go exclusively through submit_score() below (SECURITY DEFINER), so
-- we deliberately do NOT grant insert/update on the table itself.

-- ---- submit_score() -----------------------------------------------------
-- Atomic "keep the higher score" upsert keyed on (game, player_key). Running
-- it bypasses RLS (security definer) so the table can stay write-locked while
-- anyone may still record a score through this one well-defined entry point.

create or replace function submit_score(
  p_game       text,
  p_player_key text,
  p_name       text,
  p_score      int,
  p_user_id    uuid
) returns void
language sql
security definer
set search_path = public
as $$
  insert into scores (game, player_key, user_id, name, score)
  values (
    p_game,
    p_player_key,
    p_user_id,
    coalesce(nullif(trim(p_name), ''), 'Player'),
    greatest(p_score, 0)
  )
  on conflict (game, player_key) do update
    set score      = greatest(scores.score, excluded.score),
        name       = excluded.name,
        user_id    = excluded.user_id,
        updated_at = now();
$$;

grant execute on function submit_score(text, text, text, int, uuid) to anon, authenticated;


-- ========================= 3/4  friends.sql =================================
-- Friends layer — project-wide social graph shared across every game on this
-- Supabase project. Run this ONCE in the Supabase SQL editor (or via the
-- Supabase MCP server). It is game-independent, like the accounts layer:
--   • profiles    — one row per signed-in user, with a unique friend code
--   • friendships — directed request that becomes mutual once accepted
-- plus a few SECURITY DEFINER RPCs that are the only way clients touch them,
-- so the tables themselves stay locked down (RLS denies direct access).
--
-- It also adds the columns Wurdz needs to invite a friend straight into a
-- room (rooms.invited_user_id / invited_name) and the friends-leaderboard
-- helper Chromagrid uses. Both games live on the same project, so this single
-- file covers both. Every statement is safe to re-run.

-- ---- profiles -----------------------------------------------------------

create table if not exists profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  friend_code  text unique not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---- friendships --------------------------------------------------------
-- One row per relationship. `requester` asked, `addressee` was asked. The
-- pair is unordered for "are we friends?" purposes once status = 'accepted'.

create table if not exists friendships (
  id         uuid primary key default gen_random_uuid(),
  requester  uuid not null references auth.users (id) on delete cascade,
  addressee  uuid not null references auth.users (id) on delete cascade,
  status     text not null default 'pending',   -- pending | accepted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requester, addressee),
  check (requester <> addressee)
);

create index if not exists friendships_addressee_idx on friendships (addressee, status);
create index if not exists friendships_requester_idx on friendships (requester, status);

-- ---- rooms: direct friend invites (Wurdz) -------------------------------
-- A room can be created already addressed to a friend, so they see it in
-- their games list and accept without anyone sharing a code. No-ops if the
-- rooms table doesn't exist yet (e.g. a project with only Chromagrid).

do $$
begin
  if to_regclass('public.rooms') is not null then
    alter table rooms add column if not exists invited_user_id uuid references auth.users (id) on delete set null;
    alter table rooms add column if not exists invited_name text;
    create index if not exists rooms_invited_user_idx on rooms (game, invited_user_id);
  end if;
end $$;

-- ---- Row Level Security -------------------------------------------------
-- Lock both tables: clients never read/write them directly, only through the
-- SECURITY DEFINER functions below (which run as the table owner and so
-- bypass RLS). With RLS on and no policies, direct access is denied.

alter table profiles enable row level security;
alter table friendships enable row level security;

-- ---- helpers ------------------------------------------------------------

-- Random shareable code: 8 chars, no ambiguous 0/O/1/I/L.
create or replace function gen_friend_code() returns text
language plpgsql as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text := '';
  i int;
begin
  for i in 1..8 loop
    code := code || substr(alphabet, floor(random() * length(alphabet))::int + 1, 1);
  end loop;
  return code;
end;
$$;

-- Ensure the caller has a profile (creating one with a unique friend code on
-- first call) and optionally update their display name. Returns the row.
create or replace function ensure_profile(p_display_name text default null)
returns profiles
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  prof profiles;
  newcode text;
  attempts int := 0;
  clean text := nullif(trim(coalesce(p_display_name, '')), '');
begin
  if uid is null then raise exception 'not authenticated'; end if;

  select * into prof from profiles where id = uid;
  if not found then
    loop
      attempts := attempts + 1;
      newcode := gen_friend_code();
      begin
        insert into profiles (id, display_name, friend_code)
        values (uid, clean, newcode)
        returning * into prof;
        exit;
      exception when unique_violation then
        if attempts >= 8 then raise; end if;
      end;
    end loop;
  elsif clean is not null then
    update profiles set display_name = clean, updated_at = now()
    where id = uid returning * into prof;
  end if;
  return prof;
end;
$$;

-- Add a friend by their code. Auto-accepts if they had already requested us.
-- Returns: requested | accepted | already_friends | already_requested
--        | self | not_found
create or replace function send_friend_request(p_code text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  target uuid;
  existing friendships;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select id into target from profiles where friend_code = upper(trim(p_code));
  if target is null then return 'not_found'; end if;
  if target = uid then return 'self'; end if;

  -- Already friends in either direction?
  perform 1 from friendships
   where status = 'accepted'
     and ((requester = uid and addressee = target)
       or (requester = target and addressee = uid));
  if found then return 'already_friends'; end if;

  -- They already asked us → accept it.
  select * into existing from friendships
   where requester = target and addressee = uid and status = 'pending' limit 1;
  if found then
    update friendships set status = 'accepted', updated_at = now() where id = existing.id;
    return 'accepted';
  end if;

  -- We already asked them?
  select * into existing from friendships
   where requester = uid and addressee = target limit 1;
  if found then
    if existing.status = 'pending'  then return 'already_requested'; end if;
    if existing.status = 'accepted' then return 'already_friends';   end if;
  end if;

  insert into friendships (requester, addressee, status)
  values (uid, target, 'pending')
  on conflict (requester, addressee) do nothing;
  return 'requested';
end;
$$;

-- Accept or decline an incoming request from p_requester.
create or replace function respond_friend_request(p_requester uuid, p_accept boolean)
returns text
language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_accept then
    update friendships set status = 'accepted', updated_at = now()
     where requester = p_requester and addressee = uid and status = 'pending';
  else
    delete from friendships
     where requester = p_requester and addressee = uid and status = 'pending';
  end if;
  return 'ok';
end;
$$;

-- Remove a friendship (either direction), or cancel a pending request.
create or replace function remove_friend(p_friend uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  delete from friendships
   where (requester = uid and addressee = p_friend)
      or (requester = p_friend and addressee = uid);
  return 'ok';
end;
$$;

-- Accepted friends of the caller, with their names + codes.
create or replace function list_friends()
returns table (id uuid, display_name text, friend_code text)
language sql security definer set search_path = public
as $$
  select p.id, p.display_name, p.friend_code
  from friendships f
  join profiles p
    on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
  where f.status = 'accepted'
    and (f.requester = auth.uid() or f.addressee = auth.uid())
  order by coalesce(p.display_name, '');
$$;

-- Incoming pending requests for the caller, with the requester's name + code.
create or replace function list_friend_requests()
returns table (id uuid, display_name text, friend_code text)
language sql security definer set search_path = public
as $$
  select p.id, p.display_name, p.friend_code
  from friendships f
  join profiles p on p.id = f.requester
  where f.status = 'pending' and f.addressee = auth.uid()
  order by f.created_at;
$$;

-- Leaderboard filtered to the caller + their accepted friends, for one game.
-- (Only signed-in players appear, since scores.user_id is null for guests.)
create or replace function friends_leaderboard(p_game text)
returns table (name text, score int, player_key text, updated_at timestamptz)
language sql security definer set search_path = public
as $$
  with ids as (
    select auth.uid() as id
    union
    select case when f.requester = auth.uid() then f.addressee else f.requester end
    from friendships f
    where f.status = 'accepted'
      and (f.requester = auth.uid() or f.addressee = auth.uid())
  )
  select s.name, s.score, s.player_key, s.updated_at
  from scores s
  join ids on ids.id = s.user_id
  where s.game = p_game
  order by s.score desc, s.updated_at asc
  limit 100;
$$;

-- ---- Grants -------------------------------------------------------------

grant execute on function ensure_profile(text)               to authenticated;
grant execute on function send_friend_request(text)          to authenticated;
grant execute on function respond_friend_request(uuid, bool) to authenticated;
grant execute on function remove_friend(uuid)                to authenticated;
grant execute on function list_friends()                     to authenticated;
grant execute on function list_friend_requests()             to authenticated;
grant execute on function friends_leaderboard(text)          to authenticated;


-- ======================== 4/4  security.sql =================================
-- Phase-1 security hardening for the shared Supabase project.
-- Run ONCE in the SQL editor (covers both Wurdz and Chromagrid — same project).
-- Every statement is idempotent and safe to re-run.
--
-- Scope: close the avenues that don't require server-side game validation —
--   1. submit_score can no longer be used to spoof another player's identity
--   2. rooms have immutable creation fields + a non-stealable guest seat
--   3. friends RPCs are no longer executable by anonymous callers
-- (Read-enumeration of rooms/moves and move-injection are left as-is: closing
-- them fully needs server-side validation, deliberately out of scope here.)

-- ---- 1. Harden submit_score --------------------------------------------
-- Signed-in callers: identity (user_id + 'u:<id>' key) is derived from the
-- JWT, so the client can no longer attach a score to someone else's id or
-- overwrite another user's row. Guests: unchanged, but must use a 'g:' key,
-- so they can't clobber a signed-in player's 'u:' row either.

create or replace function submit_score(
  p_game       text,
  p_player_key text,
  p_name       text,
  p_score      int,
  p_user_id    uuid   -- kept for signature/back-compat; ignored, see below
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  key text;
begin
  if uid is not null then
    key := 'u:' || uid;                 -- trust the session, not the client
  else
    key := p_player_key;
    if key is null or left(key, 2) <> 'g:' then
      raise exception 'guest scores must use a g: player key';
    end if;
  end if;

  insert into scores (game, player_key, user_id, name, score)
  values (
    p_game,
    key,
    uid,
    coalesce(nullif(trim(p_name), ''), 'Player'),
    greatest(coalesce(p_score, 0), 0)
  )
  on conflict (game, player_key) do update
    set score      = greatest(scores.score, excluded.score),
        name       = excluded.name,
        user_id    = excluded.user_id,
        updated_at = now();
end;
$$;

-- ---- 2. Room immutability + guest-seat guard ---------------------------
-- Creation-time fields can never be changed by an UPDATE (no more seed
-- corruption / host or invite spoofing), and a claimed guest seat can't be
-- reassigned. Mutable by design: status, last_move_at, and claiming an empty
-- guest seat (guest_name / guest_user_id null -> set).

do $$
begin
  if to_regclass('public.rooms') is null then
    raise notice 'rooms table not present; skipping room guard';
    return;
  end if;

  create or replace function rooms_guard() returns trigger
  language plpgsql as $fn$
  begin
    if new.code            is distinct from old.code
    or new.seed            is distinct from old.seed
    or new.game            is distinct from old.game
    or new.host_user_id    is distinct from old.host_user_id
    or new.host_name       is distinct from old.host_name
    or new.created_at      is distinct from old.created_at
    or new.invited_user_id is distinct from old.invited_user_id
    or new.invited_name    is distinct from old.invited_name then
      raise exception 'immutable room field changed';
    end if;

    if old.guest_user_id is not null
       and new.guest_user_id is distinct from old.guest_user_id then
      raise exception 'guest seat already taken';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists rooms_guard_trg on rooms;
  create trigger rooms_guard_trg
    before update on rooms
    for each row execute function rooms_guard();
end $$;

-- ---- 3. Friends RPCs: authenticated only -------------------------------
-- They already no-op for anonymous callers (auth.uid() is null); this is
-- defense-in-depth so anon can't even invoke them. submit_score stays open to
-- anon on purpose (guests submit scores).

-- The notify Edge Function (service role) checks a profile exists before a
-- direct user push. service_role bypasses RLS but still needs the table grant.
grant select on table profiles to service_role;

revoke execute on function ensure_profile(text)               from public, anon;
revoke execute on function send_friend_request(text)          from public, anon;
revoke execute on function respond_friend_request(uuid, bool) from public, anon;
revoke execute on function remove_friend(uuid)                from public, anon;
revoke execute on function list_friends()                     from public, anon;
revoke execute on function list_friend_requests()             from public, anon;
revoke execute on function friends_leaderboard(text)          from public, anon;
