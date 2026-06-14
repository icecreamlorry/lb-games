// Networking: Supabase realtime websocket with a database fallback.
//
// Every move is written to the `moves` table first (the source of truth),
// then broadcast over a realtime channel for low latency. While the
// websocket is connected we apply broadcasts instantly; whenever it drops
// we poll the database instead, and we always catch up from the database
// on (re)connect. Slow or flaky connections only cost latency, never moves.

import { SUPABASE_URL, SUPABASE_ANON_KEY, GAME_SLUG } from './config.js';
import { supabase } from '../../shared/supabaseClient.js';

export { supabase };

const POLL_INTERVAL_MS = 2500;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function randomCode(len = 6) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

// hostUserId is null for anonymous hosts, or the signed-in user's id.
// invite (optional) = { userId, name }: pre-address the room to a friend so it
// appears in their games list to accept, with no code to share.
export async function createRoom(hostName, hostUserId = null, invite = null) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const row = { code, host_name: hostName, seed, game: GAME_SLUG, host_user_id: hostUserId };
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

// Resolve (and if needed claim) this player's seat in a room. Signed-in
// players (userId set) are matched by account, so they resume the right seat
// regardless of display name; anonymous players are matched by name.
export async function joinRoom(code, name, userId = null) {
  const { data: room, error } = await supabase()
    .from('rooms')
    .select()
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  if (!room) throw new Error('No room found with that code.');

  if (userId) {
    if (room.host_user_id === userId) return { room, playerIndex: 0 };
    if (room.guest_user_id === userId) return { room, playerIndex: 1 };
  } else {
    // Anonymous: resume by name, but never claim a seat owned by an account.
    if (!room.host_user_id && room.host_name === name && !room.guest_name) {
      return { room, playerIndex: 0 }; // host reconnecting before guest joined
    }
    if (!room.guest_user_id && room.guest_name === name) return { room, playerIndex: 1 };
    if (!room.host_user_id && room.host_name === name) return { room, playerIndex: 0 };
  }
  if (room.guest_name) throw new Error('That room already has two players.');

  const update = { guest_name: name, status: 'full' };
  if (userId) update.guest_user_id = userId;
  const { data: updated, error: updErr } = await supabase()
    .from('rooms')
    .update(update)
    .eq('code', code)
    .is('guest_name', null)
    .select()
    .maybeSingle();
  if (updErr) throw updErr;
  if (!updated) throw new Error('Someone else just took the last seat in that room.');
  return { room: updated, playerIndex: 1 };
}

// Every room this signed-in player is a seat in, newest activity first. Used
// to render the "My Games" lobby. Scoped to the current game by GAME_SLUG.
export async function fetchMyRooms(userId) {
  const { data, error } = await supabase()
    .from('rooms')
    .select()
    .eq('game', GAME_SLUG)
    .or(`host_user_id.eq.${userId},guest_user_id.eq.${userId},invited_user_id.eq.${userId}`)
    .order('last_move_at', { ascending: false });
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

// ---- Web Push ------------------------------------------------------------

// Store (or refresh) this device's push subscription, keyed by endpoint so
// the same device updates in place rather than duplicating.
//
// Two modes:
//   • Signed in  → pass { userId }: ONE subscription covers every game/seat
//     the account occupies, so the Edge Function can notify across games.
//   • Anonymous  → pass { roomCode, player }: notified for that seat only.
export async function savePushSubscription(subscription, { userId = null, roomCode = null, player = null, game = GAME_SLUG } = {}) {
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

// Ask the Edge Function to push someone. Either target a seat in a room
// ({ room_code, player }) or a user directly ({ user_id }, used for friend
// invites where the recipient hasn't taken a seat yet). Fire-and-forget.
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

// RoomConnection manages the realtime channel, presence, and the polling
// fallback. Handlers: onMove(move), onPresence(onlineSet), onMode(mode),
// onRoomUpdate(room). Mode is 'live' (websocket) or 'db' (polling).
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
          // Catch up on anything that happened while we were offline.
          await this.pollOnce();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.setMode('db');
        }
      });

    // The poller runs continuously but only does work in db mode; this is
    // the fallback path when the websocket is unavailable.
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

  // Persist the move, then broadcast it if the socket is up. The database
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
    // Surface recent activity to the "My Games" lobby (best effort).
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
