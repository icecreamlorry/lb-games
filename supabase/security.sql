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
