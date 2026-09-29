-- LB Games — D1 (SQLite) schema for the Cloudflare backend.
--
-- Replaces the old Supabase Postgres schema (see git history for supabase/).
-- There is no row-level security in D1: the database is only reachable through
-- the Worker (worker/src/index.js), which is where every access rule now lives.
-- JSON columns (rooms.players/result, moves.payload, push_subscriptions.subscription)
-- are stored as TEXT and parsed/serialised by the Worker. Timestamps are ISO-8601
-- UTC strings ("2026-09-29T21:00:00.000Z"), which sort correctly as text.
--
-- Every statement is idempotent, so this doubles as the migration.

-- ---- accounts -------------------------------------------------------------
-- password_hash is NULL for accounts migrated from Supabase that haven't signed
-- in since; their first sign-in is verified against the legacy Supabase Auth
-- (while LEGACY_SUPABASE_URL is set) and then stored here.
create table if not exists users (
  id            text primary key,              -- uuid (kept from Supabase)
  email         text not null unique collate nocase,
  password_hash text,                          -- pbkdf2_sha256$iter$salt$hash
  display_name  text,
  created_at    text not null,
  updated_at    text not null
);

-- One-time email links (magic sign-in, password reset). Only the SHA-256 of
-- the token is stored.
create table if not exists auth_tokens (
  token_hash text primary key,
  user_id    text,
  email      text not null,
  kind       text not null,                    -- magic | reset
  meta       text,                             -- JSON (e.g. display name for a magic sign-up)
  expires_at text not null
);

-- ---- friends --------------------------------------------------------------
create table if not exists profiles (
  id           text primary key,               -- users.id
  display_name text,
  friend_code  text not null unique,
  created_at   text not null,
  updated_at   text not null
);

create table if not exists friendships (
  id         text primary key,
  requester  text not null,
  addressee  text not null,
  status     text not null default 'pending',  -- pending | accepted
  created_at text not null,
  updated_at text not null,
  unique (requester, addressee),
  check (requester <> addressee)
);
create index if not exists friendships_addressee_idx on friendships (addressee, status);
create index if not exists friendships_requester_idx on friendships (requester, status);

-- ---- rooms + moves --------------------------------------------------------
create table if not exists rooms (
  code            text primary key,
  id              text not null,
  game            text not null,
  seed            integer not null,
  status          text not null default 'waiting', -- waiting | full | playing | finished
  players         text not null default '[]',      -- JSON [{seat,name,userId,guestId,...}]
  player_count    integer not null default 1,
  max_players     integer not null default 2,
  invited_user_id text,
  invited_name    text,
  result          text,                            -- JSON, set by finish
  created_at      text not null,
  last_move_at    text not null
);
create index if not exists rooms_game_idx on rooms (game, last_move_at);
create index if not exists rooms_invited_idx on rooms (invited_user_id, game);

-- Denormalised "which accounts sit in which room" so My Games is an index
-- lookup rather than a JSON scan. Maintained by the Worker on every players write.
create table if not exists room_users (
  room_code text not null,
  user_id   text not null,
  game      text not null,
  primary key (user_id, game, room_code)
);
create index if not exists room_users_room_idx on room_users (room_code);

create table if not exists moves (
  id         integer primary key autoincrement,
  room_code  text not null,
  move_index integer not null,
  player     integer not null,
  type       text not null,
  payload    text not null default '{}',
  created_at text not null,
  unique (room_code, move_index)
);

-- ---- leaderboards ---------------------------------------------------------
create table if not exists scores (
  id         text primary key,
  game       text not null,
  player_key text not null,                    -- 'u:<user id>' | 'g:<guest id>'
  user_id    text,
  name       text not null,
  score      integer not null,
  created_at text not null,
  updated_at text not null,
  unique (game, player_key)
);
create index if not exists scores_game_score_idx on scores (game, score desc, updated_at);

-- ---- web push -------------------------------------------------------------
create table if not exists push_subscriptions (
  endpoint     text primary key,
  subscription text not null,                  -- JSON PushSubscription
  game         text,
  user_id      text,                           -- signed-in: user-routed
  room_code    text,                           -- guest: seat-routed
  player       integer,
  device_id    text,
  created_at   text not null
);
create index if not exists push_sub_user_idx on push_subscriptions (user_id);
create index if not exists push_sub_room_idx on push_subscriptions (room_code, player);
