// Shared rooms, invites, and realtime layer for LB Games.
// Pass your GAME_SLUG to createRoom, fetchMyRooms, and savePushSubscription.
//
// Every move is written to the move log first (source of truth, via the LB
// Games API), then broadcast over the room's live channel for low latency.
// Slow or flaky connections only cost latency, never moves.

import { api, wsUrl, ApiError } from './api.js';
import { getGuestId } from './guest-id.js';
import { getPushDeviceId } from './push-device-id.js';
import { logError } from './devlog.js';

const POLL_INTERVAL_MS = 2500;

// ---- Room player helpers ---------------------------------------------------

// A seat always stores a real display name — never null/empty. This is the
// backstop for entry paths that skip the name prompt (notably the ?room= deep
// links), so an opponent never sees "null" and nothing downstream breaks on a
// missing name. Callers should still pass a good name; this only fills the gap.
export function cleanName(name) {
  const v = (typeof name === 'string' ? name.trim() : '').slice(0, 20);
  return v || 'Guest';
}

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
// extraHostFields (e.g. { matchWins, matchPoints } — see shared/rematch.js
// callers) is merged straight into the host's players[] entry, so a rematch
// chain can carry a running score forward with no extra round-trip.
// The server picks the (unique) room code.
export async function createRoom(hostName, hostUserId = null, invite = null, gameSlug, maxPlayers = 2, extraHostFields = null) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  const hostPlayer = { seat: 0, name: cleanName(hostName), userId: hostUserId ?? null, ...extraHostFields };
  if (!hostUserId) hostPlayer.guestId = getGuestId(); // distinguish same-named guests
  const row = { players: [hostPlayer], max_players: maxPlayers, seed, game: gameSlug };
  if (invite) {
    row.invited_user_id = invite.userId;
    row.invited_name = invite.name;
  }
  return api('/rooms', { method: 'POST', body: row });
}

// Update a room's mutable fields (players, player_count, status, max_players).
// Resolves to the updated room. With expect (e.g. { player_count: 1 }) the
// write only lands if the room still matches — resolves to null otherwise.
export async function updateRoom(code, set, expect = null) {
  return api(`/rooms/${encodeURIComponent(code)}`, { method: 'PATCH', body: { set, expect } });
}

// Resolve and claim a seat in a room. Signed-in players are matched by userId;
// anonymous players by name. Uses player_count as an optimistic lock so two
// simultaneous joins never land on the same seat.
// extraGuestFields (see createRoom above) is merged into the NEW seat entry
// only — a player resuming a seat they already hold keeps whatever is already
// there, since that's the row a prior stamp (or this same merge, last time)
// already wrote.
export async function joinRoom(code, name, userId = null, extraGuestFields = null) {
  const room = await api(`/rooms/${encodeURIComponent(code)}`, { allow404: true }).catch((e) => {
    if (e.status === 400) return null; // malformed code
    throw e;
  });
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
  const newPlayer = { seat: nextSeat, name: cleanName(name), userId: userId ?? null, ...extraGuestFields };
  if (!userId) newPlayer.guestId = getGuestId();
  const newPlayers = [...players, newPlayer];
  const newStatus = nextSeat + 1 >= room.max_players ? 'full' : 'waiting';

  const updated = await updateRoom(
    code,
    { players: newPlayers, player_count: nextSeat + 1, status: newStatus },
    { player_count: room.player_count }, // optimistic lock: claim only if count unchanged
  );
  if (!updated) throw new Error('Someone else just took the last seat in that room.');
  return { room: updated, playerIndex: nextSeat };
}

// All rooms the signed-in player appears in or is invited to, newest first.
// (The server takes the player from the session; userId is kept for callers.)
export async function fetchMyRooms(userId, gameSlug) {
  if (!userId) return [];
  const q = gameSlug ? `?game=${encodeURIComponent(gameSlug)}` : '';
  return (await api(`/rooms/mine${q}`)) ?? [];
}

export async function fetchRoom(code) {
  const room = await api(`/rooms/${encodeURIComponent(code)}`, { allow404: true });
  if (!room) throw new ApiError('No room found with that code.', 404);
  return room;
}

export async function updateRoomStatus(code, status) {
  await updateRoom(code, { status });
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
  try {
    return await updateRoom(code, { players: next });
  } catch (error) {
    logError('setSeatLeft failed:', error.message || error);
    return null;
  }
}

// Flag a seat as having left/forfeited. Returns the updated room, or null.
export async function markPlayerLeft(code, seat) {
  if (!code || seat == null || seat < 0) return null;
  const room = await fetchRoom(code).catch(() => null);
  if (!room) return null;
  if (room.status === 'finished') return room; // a finished game speaks for itself
  return setSeatLeft(code, room.players ?? [], seat, true);
}

// Mark a room finished and store its final result (rooms.result).
// `result` shape: { scores: number[] by seat, winner: seat|'tie'|null, reason }.
// purgeMoves deletes the room's move log too (Wurdz: the stored result makes it
// redundant). Safe to call from both clients — it's idempotent.
export async function finishRoom(code, result, purgeMoves = false) {
  const payload = { ...result, endedAt: result.endedAt || new Date().toISOString() };
  try {
    await api(`/rooms/${encodeURIComponent(code)}/finish`, {
      method: 'POST', body: { result: payload, purge_moves: !!purgeMoves },
    });
  } catch (error) {
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
//     the account occupies so notifications work across games. Each game
//     registers its own service worker scope, so the same browser still ends
//     up with one row per game — device_id (shared per-browser, see
//     push-device-id.js) is how the server collapses those back down to one
//     push per physical device instead of one per game.
//   • Anonymous  → pass { roomCode, player }: notified for that seat only.
// Identity is taken from the session server-side, so `userId` here only
// decides whether we pass the guest's seat-routing args.
export async function savePushSubscription(subscription, { userId = null, roomCode = null, player = null, game } = {}) {
  try {
    await api('/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: subscription.endpoint,
        subscription,
        game,
        room_code: userId ? null : roomCode,
        player: userId ? null : player,
        device_id: getPushDeviceId(),
      },
    });
  } catch (error) {
    logError('savePushSubscription failed:', error.message || error);
    throw error;
  }
}

export async function deletePushSubscription(endpoint) {
  try {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint } });
  } catch (error) {
    logError('deletePushSubscription failed:', error.message || error);
    throw error;
  }
}

// Ask the server to push someone. Target a seat ({ room_code, player }) or a
// user directly ({ user_id }, e.g. for friend invites). Fire-and-forget.
export async function triggerPush({ room_code, player, user_id, title, body, url }) {
  try {
    return await api('/push/notify', { method: 'POST', body: { room_code, player, user_id, title, body, url } });
  } catch (error) {
    logError(`triggerPush failed (${error.status}):`, error.message || '');
    throw new Error(`push trigger failed (${error.status})`);
  }
}

export async function fetchMoves(code, fromIndex = 0) {
  return (await api(`/rooms/${encodeURIComponent(code)}/moves?from=${fromIndex | 0}`)) ?? [];
}

// Append one move to a room's log. Rejects with code '23505' (the old
// Postgres unique-violation code, which callers test for) when that
// move_index is already taken.
export async function insertMove(code, move) {
  await api(`/rooms/${encodeURIComponent(code)}/moves`, {
    method: 'POST',
    body: { move_index: move.move_index, player: move.player, type: move.type, payload: move.payload ?? {} },
  });
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
  const move = { move_index: REMATCH_MOVE_INDEX, player: seat ?? 0, type: 'rematch', payload: { code: newCode } };
  try {
    await insertMove(oldCode, move);
    return { code: newCode, host: true };
  } catch {
    // Someone proposed first — follow their room instead.
    const moves = await fetchMoves(oldCode, REMATCH_MOVE_INDEX).catch(() => []);
    const rm = moves.find((m) => m.type === 'rematch');
    return { code: rm?.payload?.code || newCode, host: false };
  }
}

// ---- RoomConnection -------------------------------------------------------
//
// Manages the live channel (a WebSocket to the room's RoomHub), presence, and
// the polling fallback.
// Handlers: onMove(move), onPresence(onlineSet), onMode(mode), onRoomUpdate(room).
// Mode is 'live' (websocket) or 'db' (polling).
export class RoomConnection {
  constructor(code, playerIndex, name, handlers) {
    this.code = code;
    this.playerIndex = playerIndex;
    this.name = name;
    this.handlers = handlers;
    this.ws = null;
    this.pollTimer = null;
    this.pingTimer = null;
    this.retryTimer = null;
    this.retries = 0;
    this.mode = 'db';
    this.nextIndex = 0; // next move_index we expect; owner updates via setNextIndex
    this.closed = false;
  }

  setNextIndex(i) {
    this.nextIndex = Math.max(this.nextIndex, i);
  }

  connect() {
    this.openSocket();
    // Poller runs continuously but only does work in db mode.
    this.pollTimer = setInterval(() => {
      if (this.mode === 'db') this.pollOnce().catch(() => {});
    }, POLL_INTERVAL_MS);
    this.onVisible = () => {
      if (document.visibilityState === 'visible' && !this.closed && !this.ws) this.openSocket();
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  openSocket() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    const q = `?key=${encodeURIComponent(String(this.playerIndex))}&name=${encodeURIComponent(this.name || '')}`;
    let ws;
    try { ws = new WebSocket(wsUrl(`/rooms/${encodeURIComponent(this.code)}/ws${q}`)); }
    catch { this.scheduleReconnect(); return; }
    this.ws = ws;

    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      this.retries = 0;
      this.setMode('live');
      this.pollOnce().catch(() => {}); // catch up on anything missed while offline
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { try { ws.send('ping'); } catch {} }, 25000);
    };
    ws.onmessage = (ev) => {
      if (this.closed || typeof ev.data !== 'string' || ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'presence') {
        this.handlers.onPresence?.(new Set(msg.keys || []));
      } else if (msg.type === 'broadcast') {
        if (msg.event === 'move' && msg.payload?.move) this.handlers.onMove?.(msg.payload.move);
        else if (msg.event === 'room' && msg.payload?.room) this.handlers.onRoomUpdate?.(msg.payload.room);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      if (this.closed) return;
      this.setMode('db');
      this.scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  scheduleReconnect() {
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retries++, 5));
    this.retryTimer = setTimeout(() => {
      if (document.visibilityState === 'hidden') return; // reopened by onVisible
      this.openSocket();
    }, delay);
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

  send(event, payload) {
    if (this.mode !== 'live' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify({ type: 'broadcast', event, payload })); } catch {}
  }

  // Persist the move, then broadcast if the socket is up. The log write is
  // what makes the move official; the broadcast is just speed. (The server
  // bumps the room's last_move_at as part of the same write.)
  async sendMove(move) {
    await insertMove(this.code, move);
    this.send('move', { move });
  }

  async broadcastRoom(room) {
    this.send('room', { room });
  }

  // Push a move over the live channel without persisting it (already written,
  // or written elsewhere). Used to deliver a rematch pointer instantly.
  broadcastMove(move) {
    this.send('move', { move });
  }

  close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    if (this.ws) { try { this.ws.close(1000); } catch {} this.ws = null; }
  }
}
