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
