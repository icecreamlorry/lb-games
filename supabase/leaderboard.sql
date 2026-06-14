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
