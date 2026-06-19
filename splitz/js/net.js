// Splitz networking — thin wrapper around the shared rooms layer.
// createNet binds GAME_SLUG (and the push `game` default) to the room helpers
// so callers in this game don't need to pass the slug explicitly.

import { GAME_SLUG } from './config.js';
import { createNet } from '../../shared/net.js';

export { supabase, seatName, seatUserId, userSeat, seatLeft, markPlayerLeft } from '../../shared/rooms.js';
export { fetchRoom, fetchMoves, updateRoomStatus, finishRoom, triggerPush, RoomConnection } from '../../shared/rooms.js';
export { deletePushSubscription, proposeRematch, REMATCH_MOVE_INDEX } from '../../shared/rooms.js';

export const {
  fetchFinishedRooms, createRoom, joinRoom, fetchMyRooms, savePushSubscription,
} = createNet(GAME_SLUG);
