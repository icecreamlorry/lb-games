// Shared rematch flow for room-based games.
//
// One tap spins up a fresh room and pulls everyone still on the end screen
// into it. The initiator records the new room's code on the old room as a
// single high-index `rematch` move; the unique (room_code, move_index) lock
// picks one winner if both players tap at once, and the others follow over
// the live channel or the next poll.
//
// Games differ only in a few field names / helper signatures, so those are
// injected:
//
//   const rematch = createRematch({
//     state,                 // the game's `app`: reads .code/.conn/.name/.userId
//                            //   and the seat field; reads+writes .rematching
//     seatKey: 'seat',       // app field holding this player's seat (default 'seat')
//     createRoom,            // (name, userId) => freshRoom  (slug/maxPlayers pre-bound)
//     joinRoom,              // (code, name, userId) => { room, playerIndex }
//     enterRoom,             // (code, seat, name, room) => Promise
//     button: () => document.getElementById('btn-rematch'),   // optional
//     onError: (msg) => {},  // optional, e.g. show a status line
//   });
//   button.addEventListener('click', rematch.start);
//   // in the move handler: if (move.type === 'rematch') return rematch.follow(move.payload?.code);

import { proposeRematch, REMATCH_MOVE_INDEX } from './rooms.js';

export function createRematch(opts) {
  const { state, createRoom, joinRoom, enterRoom } = opts;
  const seatKey = opts.seatKey || 'seat';
  const button = opts.button || (() => document.getElementById('btn-rematch'));
  const onError = opts.onError || (() => {});

  // Initiator path: create a fresh room, claim the rematch lock, then either
  // host the new room (and broadcast the code) or follow the player who won it.
  async function start() {
    if (state.rematching) return;
    state.rematching = true;
    const rb = button(); if (rb) rb.disabled = true;
    try {
      const oldCode = state.code, oldConn = state.conn;
      const fresh = await createRoom(state.name, state.userId);
      const { code, host } = await proposeRematch(oldCode, fresh.code, state[seatKey]);
      if (host) {
        oldConn?.broadcastMove({ room_code: oldCode, move_index: REMATCH_MOVE_INDEX, player: state[seatKey], type: 'rematch', payload: { code: fresh.code } });
        await enterRoom(fresh.code, 0, state.name, fresh);
      } else {
        const { room, playerIndex } = await joinRoom(code, state.name, state.userId);
        await enterRoom(code, playerIndex, state.name, room);
      }
    } catch (e) {
      state.rematching = false;
      const rb2 = button(); if (rb2) rb2.disabled = false;
      onError(`Could not start a rematch (${e.message}).`);
    }
  }

  // Peer path: a rematch move arrived, hop into the new room. Ignore pointers
  // to the room we're already in (a stale connection re-delivering the move
  // must never re-enter the current room).
  function follow(code) {
    if (state.rematching || !code || code === state.code) return;
    state.rematching = true;
    joinRoom(code, state.name, state.userId)
      .then(({ room, playerIndex }) => enterRoom(code, playerIndex, state.name, room))
      .catch(() => { state.rematching = false; });
  }

  return { start, follow };
}
