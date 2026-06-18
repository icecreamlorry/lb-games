// Builds a game-bound networking facade over the shared rooms layer.
// Each game's net.js calls createNet(GAME_SLUG) so callers don't have to pass
// the slug (or the push `game` default) to every shared function by hand.

import * as rooms from './rooms.js';

export function createNet(GAME_SLUG) {
  return {
    fetchFinishedRooms: (userId) =>
      rooms.fetchFinishedRooms(userId, GAME_SLUG),

    createRoom: (hostName, hostUserId = null, invite = null, maxPlayers = 2) =>
      rooms.createRoom(hostName, hostUserId, invite, GAME_SLUG, maxPlayers),

    joinRoom: (code, name, userId = null) =>
      rooms.joinRoom(code, name, userId),

    fetchMyRooms: (userId) =>
      rooms.fetchMyRooms(userId, GAME_SLUG),

    savePushSubscription: (subscription, opts = {}) =>
      rooms.savePushSubscription(subscription, { game: GAME_SLUG, ...opts }),
  };
}
