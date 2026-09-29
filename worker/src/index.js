// LB Games API — the Cloudflare Worker that replaced Supabase.
//
// One Worker serves every game: accounts, rooms + move logs, live room
// channels (the RoomHub Durable Object), leaderboards, friends and Web Push.
// The static games stay on GitHub Pages and call this over fetch/WebSocket
// (client side: shared/api.js). D1 has no row-level security, so every access
// rule that used to live in Supabase RLS/RPCs lives in the handlers below.
//
// Bindings (see wrangler.jsonc):
//   DB                 D1 database (schema: worker/schema.sql)
//   ROOM_HUB           Durable Object namespace (src/room-hub.js)
//   JWT_SECRET         secret — signs session tokens
//   VAPID_PRIVATE_JWK  secret — Web Push signing key (P-256 JWK)
//   VAPID_SUBJECT      var    — mailto: contact for push services
//   EMAIL, EMAIL_FROM  optional send_email binding + from address; without them
//                      magic-link / password-reset endpoints report "unavailable"
//   LEGACY_SUPABASE_URL, LEGACY_SUPABASE_ANON_KEY
//                      optional, TRANSITIONAL — accounts migrated from Supabase
//                      carry no password hash; while these are set, their first
//                      sign-in is checked against Supabase Auth and the password
//                      is then stored here. Remove once everyone has signed in.

import { RoomHub } from './room-hub.js';
import {
  signJwt, verifyJwt, hashPassword, verifyPassword, uuid, randomCode, sha256Hex, b64u, randomBytes,
} from './crypto.js';
import { sendPush, vapidPublicKey } from './webpush.js';

export { RoomHub };

const SESSION_DAYS = 60;
const MAX_BODY = 128 * 1024;
const MAX_PAYLOAD = 64 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- HTTP helpers ---------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, 'Request too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail(400, 'Invalid JSON'); }
}

const now = () => new Date().toISOString();
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^-?\d+$/.test(v) ? parseInt(v, 10) : null));

function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// ---- Auth -----------------------------------------------------------------

function userOut(u) {
  return { id: u.id, email: u.email, user_metadata: { display_name: u.display_name || '' } };
}

async function issueSession(env, u) {
  const iat = Math.floor(Date.now() / 1000);
  const token = await signJwt({ sub: u.id, email: u.email, iat, exp: iat + SESSION_DAYS * 86400 }, env.JWT_SECRET);
  return { token, user: userOut(u) };
}

// The caller's user id from the bearer token, or null for guests.
async function authUid(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const p = await verifyJwt(m[1], env.JWT_SECRET);
  return p?.sub || null;
}

async function requireUid(request, env) {
  const uid = await authUid(request, env);
  if (!uid) fail(401, 'Not signed in');
  return uid;
}

async function findUserByEmail(env, email) {
  return env.DB.prepare('select * from users where email = ?').bind(email).first();
}

async function checkLegacyPassword(env, email, password) {
  if (!env.LEGACY_SUPABASE_URL || !env.LEGACY_SUPABASE_ANON_KEY) return null;
  try {
    const res = await fetch(`${env.LEGACY_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.LEGACY_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user?.id ? data.user : null;
  } catch {
    return null;
  }
}

async function authRoutes(request, env, path) {
  if (path === '/auth/config' && request.method === 'GET') {
    return json({ email: !!(env.EMAIL && env.EMAIL_FROM) });
  }

  if (path === '/auth/signup' && request.method === 'POST') {
    const b = await body(request);
    const email = str(b.email, 320).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (!EMAIL_RE.test(email)) fail(400, 'Please enter a valid email address.');
    if (password.length < 6) fail(400, 'Password should be at least 6 characters.');
    if (await findUserByEmail(env, email)) fail(400, 'User already registered');
    const t = now();
    const u = { id: uuid(), email, display_name: str(b.name, 40) || null };
    await env.DB.prepare('insert into users (id, email, password_hash, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?)')
      .bind(u.id, u.email, await hashPassword(password), u.display_name, t, t).run();
    return json(await issueSession(env, u));
  }

  if (path === '/auth/login' && request.method === 'POST') {
    const b = await body(request);
    const email = str(b.email, 320).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    const bad = () => fail(400, 'Invalid login credentials');
    if (!email || !password) bad();
    let u = await findUserByEmail(env, email);
    if (u?.password_hash) {
      const { ok, rehash } = await verifyPassword(password, u.password_hash);
      if (!ok) bad();
      if (rehash) {
        await env.DB.prepare('update users set password_hash = ?, updated_at = ? where id = ?')
          .bind(await hashPassword(password), now(), u.id).run();
      }
      return json(await issueSession(env, u));
    }
    // No local password yet: a migrated account (or one created on the old
    // site after the migration) — verify once against Supabase, then adopt it.
    const legacy = await checkLegacyPassword(env, email, password);
    if (!legacy) bad();
    const t = now();
    const hash = await hashPassword(password);
    if (u) {
      await env.DB.prepare('update users set password_hash = ?, updated_at = ? where id = ?').bind(hash, t, u.id).run();
    } else {
      u = { id: legacy.id, email, display_name: str(legacy.user_metadata?.display_name, 40) || null };
      await env.DB.prepare('insert into users (id, email, password_hash, display_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?)')
        .bind(u.id, u.email, hash, u.display_name, t, t).run();
    }
    return json(await issueSession(env, u));
  }

  if (path === '/auth/me' && request.method === 'GET') {
    const uid = await requireUid(request, env);
    const u = await env.DB.prepare('select * from users where id = ?').bind(uid).first();
    if (!u) fail(401, 'Account not found');
    return json(await issueSession(env, u)); // sliding session: always a fresh token
  }

  if (path === '/auth/update' && request.method === 'POST') {
    const uid = await requireUid(request, env);
    const b = await body(request);
    const t = now();
    if (typeof b.name === 'string') {
      await env.DB.prepare('update users set display_name = ?, updated_at = ? where id = ?')
        .bind(str(b.name, 40) || null, t, uid).run();
    }
    if (typeof b.password === 'string') {
      if (b.password.length < 6) fail(400, 'Password should be at least 6 characters.');
      await env.DB.prepare('update users set password_hash = ?, updated_at = ? where id = ?')
        .bind(await hashPassword(b.password), t, uid).run();
    }
    const u = await env.DB.prepare('select * from users where id = ?').bind(uid).first();
    if (!u) fail(401, 'Account not found');
    return json(await issueSession(env, u));
  }

  if ((path === '/auth/magic' || path === '/auth/reset') && request.method === 'POST') {
    if (!env.EMAIL || !env.EMAIL_FROM) fail(501, "Email links aren't available yet — sign in with your password.");
    const b = await body(request);
    const email = str(b.email, 320).toLowerCase();
    if (!EMAIL_RE.test(email)) fail(400, 'Please enter a valid email address.');
    const redirect = safeRedirect(b.redirect);
    const kind = path === '/auth/magic' ? 'magic' : 'reset';
    const u = await findUserByEmail(env, email);
    // A reset for an unknown address silently does nothing (no enumeration).
    if (kind === 'reset' && !u) return json({ ok: true });
    const token = b64u(randomBytes(32));
    await env.DB.prepare('insert into auth_tokens (token_hash, user_id, email, kind, meta, expires_at) values (?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), u?.id ?? null, email, kind,
        JSON.stringify({ name: str(b.name, 40) || null }),
        new Date(Date.now() + 60 * 60 * 1000).toISOString()).run();
    const link = `${redirect}#lb_auth=${token}`;
    const subject = kind === 'magic' ? 'Your LB Games sign-in link' : 'Reset your LB Games password';
    const text = kind === 'magic'
      ? `Tap to sign in to LB Games:\n\n${link}\n\nThe link works once and expires in an hour.`
      : `Tap to choose a new LB Games password:\n\n${link}\n\nIf you didn't ask for this, ignore this email.`;
    await env.EMAIL.send({ to: email, from: env.EMAIL_FROM, subject, text });
    return json({ ok: true });
  }

  if (path === '/auth/redeem' && request.method === 'POST') {
    const b = await body(request);
    const token = str(b.token, 200);
    if (!token) fail(400, 'Missing token');
    const row = await env.DB.prepare('delete from auth_tokens where token_hash = ? returning *')
      .bind(await sha256Hex(token)).first();
    if (!row || row.expires_at < now()) fail(400, 'That link has expired — request a new one.');
    let u = row.user_id ? await env.DB.prepare('select * from users where id = ?').bind(row.user_id).first()
      : await findUserByEmail(env, row.email);
    if (!u) {
      if (row.kind !== 'magic') fail(400, 'Account not found');
      const t = now();
      u = { id: uuid(), email: row.email, display_name: parseJson(row.meta, {})?.name || null };
      await env.DB.prepare('insert into users (id, email, password_hash, display_name, created_at, updated_at) values (?, ?, null, ?, ?, ?)')
        .bind(u.id, u.email, u.display_name, t, t).run();
    }
    return json({ ...(await issueSession(env, u)), kind: row.kind });
  }

  return null;
}

function safeRedirect(url) {
  try {
    const u = new URL(url);
    const ok = u.hostname === 'icecreamlorry.github.io' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (ok) return u.origin + u.pathname;
  } catch {}
  return 'https://icecreamlorry.github.io/lb-games/';
}

// ---- Rooms ----------------------------------------------------------------

function roomOut(r) {
  if (!r) return null;
  return {
    code: r.code, id: r.id, game: r.game, seed: r.seed, status: r.status,
    players: parseJson(r.players, []), player_count: r.player_count, max_players: r.max_players,
    invited_user_id: r.invited_user_id, invited_name: r.invited_name,
    result: parseJson(r.result, null), created_at: r.created_at, last_move_at: r.last_move_at,
  };
}

function roomUsersStmts(env, code, game, players) {
  const stmts = [env.DB.prepare('delete from room_users where room_code = ?').bind(code)];
  const ids = new Set(players.map((p) => p?.userId).filter((v) => typeof v === 'string' && v));
  for (const id of ids) {
    stmts.push(env.DB.prepare('insert or ignore into room_users (room_code, user_id, game) values (?, ?, ?)').bind(code, id, game));
  }
  return stmts;
}

function validPlayers(players, max) {
  if (!Array.isArray(players) || players.length > Math.max(max, 1) || players.length > 16) return false;
  return players.every((p) => p && typeof p === 'object' && JSON.stringify(p).length < 4096);
}

async function getRoomRow(env, code) {
  return env.DB.prepare('select * from rooms where code = ?').bind(code).first();
}

async function createRoom(request, env) {
  const uid = await authUid(request, env);
  const b = await body(request);
  const game = str(b.game, 64);
  if (!SLUG_RE.test(game)) fail(400, 'Bad game');
  const max = int(b.max_players) ?? 2;
  if (max < 1 || max > 16) fail(400, 'Bad max_players');
  const players = b.players;
  if (!validPlayers(players, max) || players.length !== 1) fail(400, 'Bad players');
  const hostUid = players[0].userId ?? null;
  if (hostUid !== null && hostUid !== uid) fail(403, 'Host must be you');
  const seed = int(b.seed) ?? Math.floor(Math.random() * 2 ** 31);
  let invitedId = null, invitedName = null;
  if (b.invited_user_id) {
    if (!uid) fail(403, 'Sign in to invite a friend');
    invitedId = str(b.invited_user_id, 64);
    invitedName = str(b.invited_name, 40) || null;
  }
  const t = now();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode(6);
    try {
      await env.DB.batch([
        env.DB.prepare(`insert into rooms (code, id, game, seed, status, players, player_count, max_players,
                          invited_user_id, invited_name, created_at, last_move_at)
                        values (?, ?, ?, ?, 'waiting', ?, 1, ?, ?, ?, ?, ?)`)
          .bind(code, uuid(), game, seed, JSON.stringify(players), max, invitedId, invitedName, t, t),
        ...roomUsersStmts(env, code, game, players),
      ]);
      return json(roomOut(await getRoomRow(env, code)), 201);
    } catch (e) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e;
    }
  }
  fail(500, 'Could not generate a unique room code, please try again.');
}

// Partial update of a room's mutable fields. `expect` is an optional optimistic
// lock ({ player_count }) — joinRoom uses it so two joins never take one seat.
// Returns the updated room, or null (200) when the lock didn't match.
async function patchRoom(request, env, code) {
  const uid = await authUid(request, env);
  const b = await body(request);
  const set = b.set && typeof b.set === 'object' ? b.set : {};
  const cur = await getRoomRow(env, code);
  if (!cur) fail(404, 'No room found with that code.');

  const cols = [];
  const vals = [];
  let newPlayers = null;
  const max = set.max_players !== undefined ? int(set.max_players) : cur.max_players;
  if (max == null || max < 1 || max > 16) fail(400, 'Bad max_players');
  if (set.max_players !== undefined) { cols.push('max_players = ?'); vals.push(max); }

  if (set.players !== undefined) {
    if (!validPlayers(set.players, max)) fail(400, 'Bad players');
    const old = parseJson(cur.players, []);
    // A seat held by an account can't be taken over, and nobody can seat an
    // account other than their own (mirrors the old rooms_guard trigger).
    old.forEach((p, i) => {
      if (p?.userId && set.players[i]?.userId !== p.userId) fail(403, 'That seat is already taken.');
    });
    set.players.forEach((p, i) => {
      if (p?.userId && p.userId !== old[i]?.userId && p.userId !== uid) fail(403, 'You can only take a seat for yourself.');
    });
    newPlayers = set.players;
    cols.push('players = ?'); vals.push(JSON.stringify(newPlayers));
  }
  if (set.player_count !== undefined) {
    const pc = int(set.player_count);
    if (pc == null || pc < 0 || pc > 16) fail(400, 'Bad player_count');
    cols.push('player_count = ?'); vals.push(pc);
  }
  if (set.status !== undefined) {
    const s = str(set.status, 20);
    if (!['waiting', 'full', 'playing', 'finished'].includes(s)) fail(400, 'Bad status');
    cols.push('status = ?'); vals.push(s);
  }
  if (set.last_move_at !== undefined) { cols.push('last_move_at = ?'); vals.push(now()); }
  if (!cols.length) return json(roomOut(cur));

  let where = 'code = ?';
  const whereVals = [code];
  const expectPc = b.expect && int(b.expect.player_count);
  if (expectPc != null) { where += ' and player_count = ?'; whereVals.push(expectPc); }

  const stmts = [env.DB.prepare(`update rooms set ${cols.join(', ')} where ${where} returning *`).bind(...vals, ...whereVals)];
  const results = await env.DB.batch(stmts);
  const row = results[0].results?.[0] || null;
  if (row && newPlayers) await env.DB.batch(roomUsersStmts(env, code, cur.game, newPlayers));
  return json(roomOut(row));
}

async function myRooms(request, env, url) {
  const uid = await authUid(request, env);
  if (!uid) return json([]);
  const game = url.searchParams.get('game');
  const sql = game
    ? `select r.* from rooms r where r.game = ?1 and (r.code in (select room_code from room_users where user_id = ?2 and game = ?1)
         or r.invited_user_id = ?2) order by r.last_move_at desc limit 500`
    : `select r.* from rooms r where r.code in (select room_code from room_users where user_id = ?2)
         or r.invited_user_id = ?2 order by r.last_move_at desc limit 500`;
  const { results } = await env.DB.prepare(sql).bind(game || '', uid).all();
  return json(results.map(roomOut));
}

async function finishRoom(request, env, code) {
  const b = await body(request);
  const result = b.result && typeof b.result === 'object' ? JSON.stringify(b.result) : null;
  if (!result || result.length > MAX_PAYLOAD) fail(400, 'Bad result');
  const stmts = [env.DB.prepare("update rooms set status = 'finished', result = ? where code = ?").bind(result, code)];
  if (b.purge_moves) stmts.push(env.DB.prepare('delete from moves where room_code = ?').bind(code));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

function moveOut(m) {
  return {
    id: m.id, room_code: m.room_code, move_index: m.move_index, player: m.player,
    type: m.type, payload: parseJson(m.payload, {}), created_at: m.created_at,
  };
}

async function listMoves(env, code, url) {
  const from = int(url.searchParams.get('from')) ?? 0;
  const { results } = await env.DB.prepare(
    'select * from moves where room_code = ? and move_index >= ? order by move_index',
  ).bind(code, from).all();
  return json(results.map(moveOut));
}

async function insertMove(request, env, code) {
  const b = await body(request);
  const idx = int(b.move_index);
  const player = int(b.player);
  const type = str(b.type, 40);
  const payload = JSON.stringify(b.payload ?? {});
  if (idx == null || idx < 0 || player == null || !type) fail(400, 'Bad move');
  if (payload.length > MAX_PAYLOAD) fail(413, 'Move too large');
  const t = now();
  try {
    const res = await env.DB.batch([
      env.DB.prepare(`insert into moves (room_code, move_index, player, type, payload, created_at)
                      select ?, ?, ?, ?, ?, ? where exists (select 1 from rooms where code = ?)`)
        .bind(code, idx, player, type, payload, t, code),
      env.DB.prepare('update rooms set last_move_at = ? where code = ?').bind(t, code),
    ]);
    if (!res[0].meta.changes) fail(404, 'No room found with that code.');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (/UNIQUE/i.test(String(e?.message))) fail(409, 'duplicate move_index', '23505');
    throw e;
  }
  return json({ ok: true }, 201);
}

async function roomRoutes(request, env, path, url) {
  if (path === '/rooms' && request.method === 'POST') return createRoom(request, env);
  if (path === '/rooms/mine' && request.method === 'GET') return myRooms(request, env, url);
  const m = /^\/rooms\/([A-Za-z0-9]+)(\/[a-z]+)?$/.exec(path);
  if (!m) return null;
  const code = m[1].toUpperCase();
  if (!CODE_RE.test(code)) fail(400, 'Bad room code');
  const sub = m[2] || '';
  if (sub === '' && request.method === 'GET') {
    const r = await getRoomRow(env, code);
    return json(roomOut(r), r ? 200 : 404);
  }
  if (sub === '' && request.method === 'PATCH') return patchRoom(request, env, code);
  if (sub === '/finish' && request.method === 'POST') return finishRoom(request, env, code);
  if (sub === '/moves' && request.method === 'GET') return listMoves(env, code, url);
  if (sub === '/moves' && request.method === 'POST') return insertMove(request, env, code);
  if (sub === '/ws' && request.method === 'GET') {
    const stub = env.ROOM_HUB.get(env.ROOM_HUB.idFromName(code));
    return stub.fetch(request);
  }
  return null;
}

// ---- Scores ---------------------------------------------------------------

async function scoreRoutes(request, env, path, url) {
  if (path === '/scores' && request.method === 'POST') {
    const uid = await authUid(request, env);
    const b = await body(request);
    const game = str(b.game, 64);
    if (!SLUG_RE.test(game)) fail(400, 'Bad game');
    let key;
    if (uid) key = 'u:' + uid; // trust the session, not the client
    else {
      key = str(b.player_key, 100);
      if (!key.startsWith('g:')) fail(400, 'guest scores must use a g: player key');
    }
    const name = str(b.name, 40) || 'Player';
    const score = Math.max(0, Math.round(Number(b.score) || 0));
    const t = now();
    await env.DB.prepare(`insert into scores (id, game, player_key, user_id, name, score, created_at, updated_at)
                          values (?, ?, ?, ?, ?, ?, ?, ?)
                          on conflict (game, player_key) do update set
                            score = max(scores.score, excluded.score), name = excluded.name,
                            user_id = excluded.user_id, updated_at = excluded.updated_at`)
      .bind(uuid(), game, key, uid, name, score, t, t).run();
    return json({ ok: true });
  }
  if (path === '/scores' && request.method === 'GET') {
    const game = url.searchParams.get('game') || '';
    const limit = Math.min(Math.max(int(url.searchParams.get('limit')) ?? 10, 1), 100);
    const { results } = await env.DB.prepare(
      'select name, score, player_key, updated_at from scores where game = ? order by score desc, updated_at asc limit ?',
    ).bind(game, limit).all();
    return json(results);
  }
  if (path === '/scores/mine' && request.method === 'GET') {
    const row = await env.DB.prepare('select score from scores where game = ? and player_key = ?')
      .bind(url.searchParams.get('game') || '', url.searchParams.get('key') || '').first();
    return json({ score: row ? row.score : null });
  }
  if (path === '/scores/friends' && request.method === 'GET') {
    const uid = await requireUid(request, env);
    const { results } = await env.DB.prepare(`
      with ids as (
        select ?1 as id
        union
        select case when f.requester = ?1 then f.addressee else f.requester end
          from friendships f where f.status = 'accepted' and (f.requester = ?1 or f.addressee = ?1)
      )
      select s.name, s.score, s.player_key, s.updated_at from scores s join ids on ids.id = s.user_id
      where s.game = ?2 order by s.score desc, s.updated_at asc limit 100`)
      .bind(uid, url.searchParams.get('game') || '').all();
    return json(results);
  }
  return null;
}

// ---- Friends --------------------------------------------------------------

async function ensureProfile(env, uid, displayName) {
  const clean = str(displayName ?? '', 40) || null;
  let prof = await env.DB.prepare('select id, display_name, friend_code from profiles where id = ?').bind(uid).first();
  if (!prof) {
    const t = now();
    for (let i = 0; i < 8 && !prof; i++) {
      try {
        prof = await env.DB.prepare(`insert into profiles (id, display_name, friend_code, created_at, updated_at)
                                     values (?, ?, ?, ?, ?) returning id, display_name, friend_code`)
          .bind(uid, clean, randomCode(8), t, t).first();
      } catch (e) {
        if (!/UNIQUE/i.test(String(e?.message)) || i === 7) throw e;
        // friend-code collision → retry; an id collision means another request created it
        prof = await env.DB.prepare('select id, display_name, friend_code from profiles where id = ?').bind(uid).first();
      }
    }
  } else if (clean) {
    prof = await env.DB.prepare('update profiles set display_name = ?, updated_at = ? where id = ? returning id, display_name, friend_code')
      .bind(clean, now(), uid).first();
  }
  return prof;
}

async function friendRoutes(request, env, path) {
  if (!path.startsWith('/friends')) return null;
  const uid = await requireUid(request, env);

  if (path === '/friends/profile' && request.method === 'POST') {
    const b = await body(request);
    return json(await ensureProfile(env, uid, b.display_name));
  }
  if (path === '/friends' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`
      select p.id, p.display_name, p.friend_code from friendships f
      join profiles p on p.id = case when f.requester = ?1 then f.addressee else f.requester end
      where f.status = 'accepted' and (f.requester = ?1 or f.addressee = ?1)
      order by coalesce(p.display_name, '')`).bind(uid).all();
    return json(results);
  }
  if (path === '/friends/requests' && request.method === 'GET') {
    const { results } = await env.DB.prepare(`
      select p.id, p.display_name, p.friend_code from friendships f join profiles p on p.id = f.requester
      where f.status = 'pending' and f.addressee = ? order by f.created_at`).bind(uid).all();
    return json(results);
  }
  if (path === '/friends/request' && request.method === 'POST') {
    const b = await body(request);
    const code = str(b.code, 20).toUpperCase();
    const target = await env.DB.prepare('select id from profiles where friend_code = ?').bind(code).first();
    if (!target) return json('not_found');
    if (target.id === uid) return json('self');
    const rows = (await env.DB.prepare(`select * from friendships where (requester = ?1 and addressee = ?2) or (requester = ?2 and addressee = ?1)`)
      .bind(uid, target.id).all()).results;
    if (rows.some((f) => f.status === 'accepted')) return json('already_friends');
    const theirs = rows.find((f) => f.requester === target.id && f.status === 'pending');
    if (theirs) {
      await env.DB.prepare("update friendships set status = 'accepted', updated_at = ? where id = ?").bind(now(), theirs.id).run();
      return json('accepted');
    }
    if (rows.some((f) => f.requester === uid)) return json('already_requested');
    const t = now();
    await env.DB.prepare(`insert or ignore into friendships (id, requester, addressee, status, created_at, updated_at)
                          values (?, ?, ?, 'pending', ?, ?)`).bind(uuid(), uid, target.id, t, t).run();
    return json('requested');
  }
  if (path === '/friends/respond' && request.method === 'POST') {
    const b = await body(request);
    const requester = str(b.requester, 64);
    if (b.accept) {
      await env.DB.prepare("update friendships set status = 'accepted', updated_at = ? where requester = ? and addressee = ? and status = 'pending'")
        .bind(now(), requester, uid).run();
    } else {
      await env.DB.prepare("delete from friendships where requester = ? and addressee = ? and status = 'pending'")
        .bind(requester, uid).run();
    }
    return json('ok');
  }
  if (path === '/friends/remove' && request.method === 'POST') {
    const b = await body(request);
    const friend = str(b.friend, 64);
    await env.DB.prepare('delete from friendships where (requester = ?1 and addressee = ?2) or (requester = ?2 and addressee = ?1)')
      .bind(uid, friend).run();
    return json('ok');
  }
  return null;
}

// ---- Web Push -------------------------------------------------------------

async function pushRoutes(request, env, path) {
  if (path === '/push/key' && request.method === 'GET') {
    return json({ key: env.VAPID_PRIVATE_JWK ? await vapidPublicKey(env) : null });
  }
  if (path === '/push/subscribe' && request.method === 'POST') {
    const uid = await authUid(request, env);
    const b = await body(request);
    const endpoint = str(b.endpoint, 1000);
    const sub = b.subscription;
    if (!/^https:\/\//.test(endpoint) || !sub?.keys?.p256dh || !sub?.keys?.auth) fail(400, 'Bad subscription');
    // Signed-in devices are user-routed (room/seat forced null); guests are seat-routed.
    await env.DB.prepare(`insert into push_subscriptions (endpoint, subscription, game, user_id, room_code, player, device_id, created_at)
                          values (?, ?, ?, ?, ?, ?, ?, ?)
                          on conflict (endpoint) do update set subscription = excluded.subscription, game = excluded.game,
                            user_id = excluded.user_id, room_code = excluded.room_code, player = excluded.player,
                            device_id = excluded.device_id, created_at = excluded.created_at`)
      .bind(endpoint, JSON.stringify(sub), str(b.game, 64) || null, uid,
        uid ? null : (str(b.room_code, 12) || null), uid ? null : int(b.player),
        str(b.device_id, 100) || null, now()).run();
    return json({ ok: true });
  }
  if (path === '/push/unsubscribe' && request.method === 'POST') {
    const b = await body(request);
    await env.DB.prepare('delete from push_subscriptions where endpoint = ?').bind(str(b.endpoint, 1000)).run();
    return json({ ok: true });
  }
  if (path === '/push/notify' && request.method === 'POST') {
    return notify(env, await body(request));
  }
  return null;
}

// Send a "your turn"-style push. Callable by anyone, so it must be safe when
// abused: the URL is never client-supplied, the text is capped, and it only
// reaches a real seat holder or a real account.
async function notify(env, b) {
  if (!env.VAPID_PRIVATE_JWK) fail(500, 'Push is not configured');
  const roomCode = b.room_code ? str(b.room_code, 12).toUpperCase() : null;
  let recipient = b.user_id ? str(b.user_id, 64) : null;
  let anonSeat = false;
  const player = int(b.player);
  if (!recipient) {
    if (!roomCode || player == null || player < 0) fail(400, 'either user_id, or room_code and player, are required');
    const room = await getRoomRow(env, roomCode);
    if (!room) fail(404, 'no such room');
    const seat = parseJson(room.players, [])[player];
    recipient = seat?.userId || null;
    anonSeat = !!seat;
  } else {
    const prof = await env.DB.prepare('select id from users where id = ?').bind(recipient).first();
    if (!prof) fail(404, 'no such user');
  }
  if (!recipient && !anonSeat) return json({ sent: 0 });

  let subs = [];
  const stale = [];
  if (recipient) {
    // One row per game a device opened notifications in; collapse to one push
    // per real device (device_id), newest row wins.
    const { results } = await env.DB.prepare(
      'select endpoint, subscription, device_id from push_subscriptions where user_id = ? order by created_at desc',
    ).bind(recipient).all();
    const seen = new Set();
    for (const row of results) {
      const key = row.device_id || `endpoint:${row.endpoint}`;
      if (seen.has(key)) { if (row.device_id) stale.push(row.endpoint); continue; }
      seen.add(key);
      subs.push(row);
    }
  } else {
    subs = (await env.DB.prepare('select endpoint, subscription from push_subscriptions where room_code = ? and player = ?')
      .bind(roomCode, player).all()).results;
  }

  const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
  const payload = JSON.stringify({
    title: clip(b.title, 80) || "LB Games — it's your turn",
    body: clip(b.body, 140) || 'Your move!',
    url: './',
    room_code: roomCode,
  });

  let sent = 0;
  await Promise.all(subs.map(async (row) => {
    try {
      const status = await sendPush(env, parseJson(row.subscription, {}), payload);
      if (status >= 200 && status < 300) sent++;
      else if (status === 404 || status === 410 || status === 403) stale.push(row.endpoint);
    } catch { /* one bad subscription never blocks the rest */ }
  }));
  if (stale.length) {
    await env.DB.batch(stale.map((e) => env.DB.prepare('delete from push_subscriptions where endpoint = ?').bind(e)));
  }
  return json({ sent });
}

// ---- One-time import from Supabase (TRANSITIONAL) ------------------------
// POST /admin/import-supabase copies the publicly readable tables (rooms,
// moves, scores) from the old Supabase project's REST API. Only enabled while
// the MIGRATE_FROM_SUPABASE var is '1'. Idempotent and never clobbers newer
// data: a room is only overwritten by a copy at least as recent, moves are
// insert-or-ignore, scores keep the higher value. (Accounts, profiles and
// friendships aren't publicly readable and were copied separately.)

async function supabasePage(env, table, offset, limit) {
  const order = table === 'moves' ? 'id' : 'created_at';
  const res = await fetch(`${env.LEGACY_SUPABASE_URL}/rest/v1/${table}?select=*&order=${order}.asc&limit=${limit}&offset=${offset}`, {
    headers: { apikey: env.LEGACY_SUPABASE_ANON_KEY },
  });
  if (!res.ok) fail(502, `Supabase ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

// One page per call (keeps each request well inside the CPU limit):
// ?table=rooms|moves|scores&offset=N → { table, count, next } (next null = done).
async function importFromSupabase(env, url) {
  if (env.MIGRATE_FROM_SUPABASE !== '1' || !env.LEGACY_SUPABASE_URL) fail(404, 'Not found');
  const table = url.searchParams.get('table');
  if (!['rooms', 'moves', 'scores'].includes(table)) fail(400, 'table must be rooms, moves or scores');
  const offset = int(url.searchParams.get('offset')) ?? 0;
  const LIMIT = 200;
  const rows = await supabasePage(env, table, offset, LIMIT);
  const rooms = table === 'rooms' ? rows : [];
  const moves = table === 'moves' ? rows : [];
  const scores = table === 'scores' ? rows : [];
  const stmts = [];
  for (const r of rooms) {
    const players = Array.isArray(r.players) ? r.players : [];
    stmts.push(env.DB.prepare(`insert into rooms (code, id, game, seed, status, players, player_count, max_players,
                                 invited_user_id, invited_name, result, created_at, last_move_at)
                               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                               on conflict (code) do update set status = excluded.status, players = excluded.players,
                                 player_count = excluded.player_count, max_players = excluded.max_players,
                                 result = excluded.result, last_move_at = excluded.last_move_at
                               where excluded.last_move_at >= rooms.last_move_at`)
      .bind(r.code, r.id, r.game || 'wurdz', r.seed ?? 0, r.status || 'waiting', JSON.stringify(players),
        r.player_count ?? players.length, r.max_players ?? 2, r.invited_user_id ?? null, r.invited_name ?? null,
        r.result == null ? null : JSON.stringify(r.result), iso(r.created_at), iso(r.last_move_at)));
    stmts.push(...roomUsersStmts(env, r.code, r.game || 'wurdz', players));
  }
  for (const m of moves) {
    stmts.push(env.DB.prepare(`insert or ignore into moves (room_code, move_index, player, type, payload, created_at)
                               values (?, ?, ?, ?, ?, ?)`)
      .bind(m.room_code, m.move_index, m.player, m.type, JSON.stringify(m.payload ?? {}), iso(m.created_at)));
  }
  for (const s of scores) {
    stmts.push(env.DB.prepare(`insert into scores (id, game, player_key, user_id, name, score, created_at, updated_at)
                               values (?, ?, ?, ?, ?, ?, ?, ?)
                               on conflict (game, player_key) do update set score = max(scores.score, excluded.score),
                                 updated_at = max(scores.updated_at, excluded.updated_at)`)
      .bind(s.id, s.game, s.player_key, s.user_id ?? null, s.name || 'Player', s.score ?? 0, iso(s.created_at), iso(s.updated_at)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ table, count: rows.length, next: rows.length < LIMIT ? null : offset + LIMIT });
}

// ---- Entry ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/') return json({ ok: true, service: 'lb-games-api' });
      if (path === '/admin/import-supabase' && request.method === 'POST') return await importFromSupabase(env, url);
      const res = (path.startsWith('/auth') && await authRoutes(request, env, path))
        || (path.startsWith('/rooms') && await roomRoutes(request, env, path, url))
        || (path.startsWith('/scores') && await scoreRoutes(request, env, path, url))
        || (path.startsWith('/friends') && await friendRoutes(request, env, path))
        || (path.startsWith('/push') && await pushRoutes(request, env, path));
      return res || json({ error: 'Not found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error(e?.stack || e);
      return json({ error: 'Server error' }, 500);
    }
  },
};
