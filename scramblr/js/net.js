// Wurdz networking — thin wrapper around the shared rooms layer.
// Binds GAME_SLUG and the wurdz push default to every shared function so
// callers in this game don't need to pass the slug explicitly.

import { GAME_SLUG } from './config.js';
import * as rooms from '../../shared/rooms.js';

export { supabase, seatName, seatUserId, userSeat } from '../../shared/rooms.js';
export { fetchRoom, fetchMoves, updateRoomStatus, triggerPush, RoomConnection } from '../../shared/rooms.js';
export { deletePushSubscription } from '../../shared/rooms.js';

export const createRoom = (hostName, hostUserId = null, invite = null, maxPlayers = 2) =>
  rooms.createRoom(hostName, hostUserId, invite, GAME_SLUG, maxPlayers);

export const joinRoom = (code, name, userId = null) =>
  rooms.joinRoom(code, name, userId);

export const fetchMyRooms = (userId) =>
  rooms.fetchMyRooms(userId, GAME_SLUG);

export const savePushSubscription = (subscription, opts = {}) =>
  rooms.savePushSubscription(subscription, { game: GAME_SLUG, ...opts });
