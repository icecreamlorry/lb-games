// Shared rooms, invites, and realtime layer for LB Games.
// Pass your GAME_SLUG to createRoom, fetchMyRooms, and savePushSubscription.
//
// Every move is written to the `moves` table first (source of truth), then
// broadcast over a realtime channel for low latency. Slow or flaky connections
// only cost latency, never moves.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { supabase } from './supabaseClient.js';
import { getGuestId } from './guest-id.js';
import { logError } from './devlog.js';

export { supabase };

const POLL_INTERVAL_MS = 2500;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function randomCode(len = 6) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

// ---- Room player helpers ---------------------------------------------------

// Name of the player at seat index, or null if that seat is empty.
export function seatName(room, seat) {
  return room.players?.[seat]?.name ?? null;
}

// User ID of the player at seat index, or null for anonymous / empty seat.
export function seatUserId(room, seat) {
  return room.players?.[seat]?.userId ?? null;
}

// Seat index for a signed-in user, or -1 if they have no seat yet.
export function userSeat(room, userId) {
  if (!userId) return -1;
  return (room.players ?? []).findIndex((p) => p.userId === userId);
}

// Whether the player at seat has left/forfeited this game (see markPlayerLeft).
export function seatLeft(room, seat) {
  return !!room?.players?.[seat]?.left;
}

// ---- Room creation & joining -----------------------------------------------

// Creates a room for gameSlug. hostUserId is null for anonymous hosts.
// invite = { userId, name } pre-addresses the room to a friend so it appears
// in their lobby without code sharing.
// maxPlayers defaults to 2; pass higher for multiplayer games.
export async function createRoom(hostName, hostUserId = null, invite = null, gameSlug, maxPlayers = 2) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const hostPlayer = { seat: 0, name: hostName, userId: hostUserId ?? null };
  if (!hostUserId) hostPlayer.guestId = getGuestId(); // distinguish same-named guests
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const row = {
      code,
      players: [hostPlayer],
      player_count: 1,
      max_players: maxPlayers,
      seed,
      game: gameSlug,
    };
    if (invite) {
      row.invited_user_id = invite.userId;
      row.invited_name = invite.name;
    }
    const { data, error } = await supabase()
      .from('rooms')
      .insert(row)
      .select()
      .single();
    if (!error) return data;
    if (error.code !== '23505') throw error; // retry only on code collision
  }
  throw new Error('Could not generate a unique room code, please try again.');
}

// Resolve and claim a seat in a room. Signed-in players are matched by userId;
// anonymous players by name. Uses player_count as an optimistic lock so two
// simultaneous joins never land on the same seat.
export async function joinRoom(code, name, userId = null) {
  const { data: room, error } = await supabase()
    .from('rooms')
    .select()
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  if (!room) throw new Error('No room found with that code.');

  const players = room.players ?? [];

  // Resume an existing seat. Signed-in players match by account; guests match
  // by their per-session guest id (NOT name — two guests can share a name), so
  // a genuinely new player never resumes someone else's seat. Older rooms whose
  // player records predate guest ids fall back to name matching.
  if (userId) {
    const seat = players.findIndex((p) => p.userId === userId);
    if (seat !== -1) {
      const fresh = players[seat]?.left ? await setSeatLeft(code, players, seat, false) : null;
      return { room: fresh || room, playerIndex: seat };
    }
  } else {
    const gid = getGuestId();
    const seat = players.findIndex((p) => !p.userId && (p.guestId === gid || (!p.guestId && p.name === name)));
    if (seat !== -1) {
      const fresh = players[seat]?.left ? await setSeatLeft(code, players, seat, false) : null;
      return { room: fresh || room, playerIndex: seat };
    }
  }

  if (room.player_count >= room.max_players) {
    throw new Error('That room is already full.');
  }

  const nextSeat = room.player_count;
  const newPlayer = { seat: nextSeat, name, userId: userId ?? null };
  if (!userId) newPlayer.guestId = getGuestId();
  const newPlayers = [...players, newPlayer];
  const newStatus = nextSeat + 1 >= room.max_players ? 'full' : 'waiting';

  const { data: updated, error: updErr } = await supabase()
    .from('rooms')
    .update({ players: newPlayers, player_count: nextSeat + 1, status: newStatus })
    .eq('code', code)
    .eq('player_count', room.player_count) // optimistic lock: claim only if count unchanged
    .select()
    .maybeSingle();
  if (updErr) throw updErr;
  if (!updated) throw new Error('Someone else just took the last seat in that room.');
  return { room: updated, playerIndex: nextSeat };
}

// All rooms a signed-in player appears in or is invited to, newest first.
export async function fetchMyRooms(userId, gameSlug) {
  const { data, error } = await supabase()
    .rpc('my_rooms', { p_user_id: userId, p_game: gameSlug });
  if (error) throw error;
  return data ?? [];
}

export async function fetchRoom(code) {
  const { data, error } = await supabase().from('rooms').select().eq('code', code).single();
  if (error) throw error;
  return data;
}

export async function updateRoomStatus(code, status) {
  const { error } = await supabase().from('rooms').update({ status }).eq('code', code);
  if (error) throw error;
}

// ---- Leaving / forfeiting --------------------------------------------------
//
// When a player exits a game in progress we flag their seat on the room, so the
// OTHER player sees it on their name (not just a transient "offline" dot). The
// flag lives on the players JSON, so it travels with the room everywhere it's
// already fetched (lobby + in-game) with no extra query. It's cleared when the
// player rejoins (see joinRoom). Read-modify-write: leaving is rare and there's
// one writer per seat, so the small race window is acceptable.
async function setSeatLeft(code, players, seat, left) {
  const next = (players ?? []).map((p, i) => {
    if ((p.seat ?? i) !== seat) return p;
    const { left: _l, leftAt: _t, ...rest } = p; // drop any existing flag first
    return left ? { ...rest, left: true, leftAt: new Date().toISOString() } : rest;
  });
  const { data, error } = await supabase()
    .from('rooms').update({ players: next }).eq('code', code).select().maybeSingle();
  if (error) { logError('setSeatLeft failed:', error.message || error); return null; }
  return data;
}

// Flag a seat as having left/forfeited. Returns the updated room, or null.
export async function markPlayerLeft(code, seat) {
  if (!code || seat == null || seat < 0) return null;
  const room = await fetchRoom(code).catch(() => null);
  if (!room) return null;
  if (room.status === 'finished') return room; // a finished game speaks for itself
  return setSeatLeft(code, room.players ?? [], seat, true);
}

// Mark a room finished and store its final result (see schema: rooms.result).
// `result` shape: { scores: number[] by seat, winner: seat|'tie'|null, reason }.
// purgeMoves deletes the room's move log too (Wurdz: the stored result makes it
// redundant). Safe to call from both clients — it's idempotent.
export async function finishRoom(code, result, purgeMoves = false) {
  const payload = { ...result, endedAt: result.endedAt || new Date().toISOString() };
  const { error } = await supabase()
    .rpc('finish_room', { p_code: code, p_result: payload, p_purge_moves: purgeMoves });
  if (error) {
    // If the RPC hasn't been deployed yet, fall back to a direct table update.
    // (The RPC also optionally purges moves, but Scramblr never sets purgeMoves.)
    if (error.code === 'PGRST202' || (error.message || '').includes('Could not find the function')) {
      const { error: e2 } = await supabase()
        .from('rooms')
        .update({ status: 'finished', result: payload })
        .eq('code', code);
      if (e2) { logError('finishRoom fallback failed:', e2.message || e2); throw e2; }
      return payload;
    }
    logError('finishRoom failed:', error.message || error);
    throw error;
  }
  return payload;
}

// Finished rooms this player took part in, newest first, each with its stored
// result. (History is a signed-in feature — guest rooms aren't user-routed.)
export async function fetchFinishedRooms(userId, gameSlug) {
  const rooms = await fetchMyRooms(userId, gameSlug);
  return rooms.filter((r) => r.status === 'finished' && r.result);
}

// ---- Web Push -------------------------------------------------------------

// Two modes:
//   • Signed in  → pass { userId }: one subscription covers every game/seat
//     the account occupies so notifications work across games.
//   • Anonymous  → pass { roomCode, player }: notified for that seat only.
export async function savePushSubscription(subscription, { userId = null, roomCode = null, player = null, game } = {}) {
  const row = userId
    ? { user_id: userId, room_code: null, player: null, game, endpoint: subscription.endpoint, subscription }
    : { user_id: null, room_code: roomCode, player, game, endpoint: subscription.endpoint, subscription };
  const { error } = await supabase()
    .from('push_subscriptions')
    .upsert(row, { onConflict: 'endpoint', returning: 'minimal' });
  if (error) {
    logError('savePushSubscription failed:', error.message || error);
    throw error;
  }
}

export async function deletePushSubscription(endpoint) {
  const { error } = await supabase().from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) {
    logError('deletePushSubscription failed:', error.message || error);
    throw error;
  }
}

// Ask the Edge Function to push someone. Target a seat ({ room_code, player })
// or a user directly ({ user_id }, e.g. for friend invites). Fire-and-forget.
export async function triggerPush({ room_code, player, user_id, title, body, url }) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ room_code, player, user_id, title, body, url }),
  });
  if (!res.ok) {
    logError(`triggerPush failed (${res.status}):`, await res.text().catch(() => ''));
    throw new Error(`push trigger failed (${res.status})`);
  }
  return res.json();
}

export async function fetchMoves(code, fromIndex = 0) {
  const { data, error } = await supabase()
    .from('moves')
    .select()
    .eq('room_code', code)
    .gte('move_index', fromIndex)
    .order('move_index');
  if (error) throw error;
  return data;
}

// ---- Rematch --------------------------------------------------------------
//
// To rematch, a player creates a fresh room and records its code on the OLD
// room as a single 'rematch' move at a fixed, very-high index. The unique
// (room_code, move_index) constraint makes that insert a one-winner lock: if
// two players hit Rematch at once, only the first lands and everyone converges
// on that room. The code rides the move payload; peers still in the old room
// pick it up over the live channel or the next poll and follow along.
export const REMATCH_MOVE_INDEX = 9_000_000;

export async function proposeRematch(oldCode, newCode, seat) {
  const move = {
    room_code: oldCode, move_index: REMATCH_MOVE_INDEX,
    player: seat ?? 0, type: 'rematch', payload: { code: newCode },
  };
  const { error } = await supabase().from('moves').insert(move);
  if (!error) return { code: newCode, host: true };
  // Someone proposed first — follow their room instead.
  const moves = await fetchMoves(oldCode, REMATCH_MOVE_INDEX).catch(() => []);
  const rm = moves.find((m) => m.type === 'rematch');
  return { code: rm?.payload?.code || newCode, host: false };
}

// ---- RoomConnection -------------------------------------------------------
//
// Manages the realtime channel, presence, and the polling fallback.
// Handlers: onMove(move), onPresence(onlineSet), onMode(mode), onRoomUpdate(room).
// Mode is 'live' (websocket) or 'db' (polling).
export class RoomConnection {
  constructor(code, playerIndex, name, handlers) {
    this.code = code;
    this.playerIndex = playerIndex;
    this.name = name;
    this.handlers = handlers;
    this.channel = null;
    this.pollTimer = null;
    this.mode = 'db';
    this.nextIndex = 0; // next move_index we expect; owner updates via setNextIndex
    this.closed = false;
  }

  setNextIndex(i) {
    this.nextIndex = Math.max(this.nextIndex, i);
  }

  connect() {
    this.channel = supabase().channel(`room:${this.code}`, {
      config: {
        broadcast: { self: false },
        presence: { key: String(this.playerIndex) },
      },
    });

    this.channel
      .on('broadcast', { event: 'move' }, ({ payload }) => {
        this.handlers.onMove?.(payload.move);
      })
      .on('broadcast', { event: 'room' }, ({ payload }) => {
        this.handlers.onRoomUpdate?.(payload.room);
      })
      .on('presence', { event: 'sync' }, () => {
        const present = new Set(Object.keys(this.channel.presenceState()));
        this.handlers.onPresence?.(present);
      })
      .subscribe(async (status) => {
        if (this.closed) return;
        if (status === 'SUBSCRIBED') {
          this.setMode('live');
          await this.channel.track({ name: this.name, player: this.playerIndex });
          await this.pollOnce(); // catch up on anything missed while offline
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.setMode('db');
        }
      });

    // Poller runs continuously but only does work in db mode.
    this.pollTimer = setInterval(() => {
      if (this.mode === 'db') this.pollOnce().catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.handlers.onMode?.(mode);
  }

  async pollOnce() {
    if (this.closed) return;
    const moves = await fetchMoves(this.code, this.nextIndex);
    if (this.closed) return; // closed mid-fetch — deliver nothing
    for (const m of moves) this.handlers.onMove?.(m);
    if (this.mode === 'db') {
      const room = await fetchRoom(this.code);
      if (this.closed) return;
      this.handlers.onRoomUpdate?.(room);
    }
  }

  // Persist the move, then broadcast if the socket is up. The database
  // write is what makes the move official; the broadcast is just speed.
  async sendMove(move) {
    const { error } = await supabase().from('moves').insert({
      room_code: this.code,
      move_index: move.move_index,
      player: move.player,
      type: move.type,
      payload: move.payload,
    });
    if (error) throw error;
    supabase().from('rooms').update({ last_move_at: new Date().toISOString() }).eq('code', this.code).then(() => {}, () => {});
    if (this.mode === 'live') {
      this.channel.send({ type: 'broadcast', event: 'move', payload: { move } }).catch(() => {});
    }
  }

  async broadcastRoom(room) {
    if (this.mode === 'live') {
      this.channel.send({ type: 'broadcast', event: 'room', payload: { room } }).catch(() => {});
    }
  }

  // Push a move over the live channel without persisting it (already written,
  // or written elsewhere). Used to deliver a rematch pointer instantly.
  broadcastMove(move) {
    if (this.mode === 'live' && this.channel) {
      this.channel.send({ type: 'broadcast', event: 'move', payload: { move } }).catch(() => {});
    }
  }

  close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.channel) supabase().removeChannel(this.channel);
  }
}
