// Shared rooms, invites, and realtime layer for LB Games.
// Pass your GAME_SLUG to createRoom, fetchMyRooms, and savePushSubscription.
//
// Every move is written to the `moves` table first (source of truth), then
// broadcast over a realtime channel for low latency. Slow or flaky connections
// only cost latency, never moves.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { supabase } from './supabaseClient.js';
import { getGuestId } from './guest-id.js';

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
    if (seat !== -1) return { room, playerIndex: seat };
  } else {
    const gid = getGuestId();
    const seat = players.findIndex((p) => !p.userId && (p.guestId === gid || (!p.guestId && p.name === name)));
    if (seat !== -1) return { room, playerIndex: seat };
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
  if (error) throw error;
}

export async function deletePushSubscription(endpoint) {
  const { error } = await supabase().from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) throw error;
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
  if (!res.ok) throw new Error(`push trigger failed (${res.status})`);
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
    for (const m of moves) this.handlers.onMove?.(m);
    if (this.mode === 'db') {
      const room = await fetchRoom(this.code);
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

  close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.channel) supabase().removeChannel(this.channel);
  }
}
