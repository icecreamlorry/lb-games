// In-page stub of the LB Games API (worker/src/index.js) for browser/e2e tests.
// Tests inject this file's text with context.addInitScript({ content }) so it
// runs before the app: it wraps window.fetch for the API origin with an
// in-memory store and makes the room WebSocket fail, so RoomConnection stays
// in polling mode and moves injected into __DB sync on the next poll.
//
// Single-page in-memory store — enough for the guest create/join/play flow and
// the signed-in "My Games" lobby. Tests configure the signed-in view through
// globals set BEFORE the app loads (page.addInitScript):
//
//   globalThis.__TEST_USER     -> the user returned by /auth/me
//                                 e.g. { id: 'u1', email: 'a@b.c',
//                                        user_metadata: { display_name: 'Alice' } }
//   globalThis.__TEST_MYROOMS  -> array returned by /rooms/mine; each row is
//                                 { code, status, players: [{seat,name,userId}],
//                                   invited_user_id, … }
//
// Signed-in tests must ALSO seed the persisted session (shared/boot.js +
// auth.cachedUser() read it to route before first paint):
//
//   localStorage.setItem('lb.auth', JSON.stringify({ token: 'tok', user: <same as __TEST_USER> }));
//
// Leave them unset for the anonymous-guest flow.
(function () {
  var DB = (globalThis.__DB = globalThis.__DB || { rooms: new Map(), moves: [] });
  var realFetch = window.fetch.bind(window);

  function reply(status, body) {
    return Promise.resolve(new Response(body === undefined ? 'null' : JSON.stringify(body), {
      status: status, headers: { 'Content-Type': 'application/json' },
    }));
  }

  function isApi(url) { return /\/\/lb-games-api\./.test(url); }

  function handle(method, path, query, body) {
    var m;
    if (path === '/auth/me') {
      var u = globalThis.__TEST_USER || null;
      return u ? reply(200, { token: 'tok', user: u }) : reply(401, { error: 'Not signed in' });
    }
    if (path === '/auth/config') return reply(200, { email: false });
    if (path === '/rooms/mine') return reply(200, globalThis.__TEST_MYROOMS || []);
    if (path === '/rooms' && method === 'POST') {
      var code = 'T' + String(DB.rooms.size + 10000).slice(-5);
      var r = Object.assign({ code: code, status: 'waiting', result: null,
        created_at: new Date().toISOString(), last_move_at: new Date().toISOString() }, body);
      // Seed a second player so the host can start a 2-player game in the test.
      r.players = (r.players || []).concat([{ seat: 1, name: 'Bob', userId: null, guestId: 'bob' }]);
      r.player_count = r.players.length;
      DB.rooms.set(code, r);
      return reply(201, r);
    }
    if ((m = /^\/rooms\/([A-Z0-9]+)$/.exec(path))) {
      var room = DB.rooms.get(m[1]);
      if (!room) return reply(404, null);
      if (method === 'PATCH') {
        if (body.expect && body.expect.player_count != null && room.player_count !== body.expect.player_count) return reply(200, null);
        Object.assign(room, body.set || {});
      }
      return reply(200, room);
    }
    if ((m = /^\/rooms\/([A-Z0-9]+)\/moves$/.exec(path))) {
      if (method === 'POST') {
        if (DB.moves.some(function (x) { return x.room_code === m[1] && x.move_index === body.move_index; })) {
          return reply(409, { error: 'duplicate move_index', code: '23505' });
        }
        DB.moves.push(Object.assign({ room_code: m[1] }, body));
        return reply(201, { ok: true });
      }
      var from = parseInt(query.get('from') || '0', 10);
      return reply(200, DB.moves
        .filter(function (x) { return x.room_code === m[1] && x.move_index >= from; })
        .sort(function (a, b) { return a.move_index - b.move_index; }));
    }
    if ((m = /^\/rooms\/([A-Z0-9]+)\/finish$/.exec(path))) {
      var fr = DB.rooms.get(m[1]);
      if (fr) { fr.status = 'finished'; fr.result = body.result; }
      return reply(200, { ok: true });
    }
    if (path === '/scores' && method === 'GET') return reply(200, []);
    if (path === '/scores/mine') return reply(200, { score: null });
    if (path === '/friends' || path === '/friends/requests' || path === '/scores/friends') return reply(200, []);
    return reply(200, { ok: true });
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    if (!isApi(url)) return realFetch(input, init);
    var u = new URL(url);
    var method = (init && init.method) || 'GET';
    var body = init && init.body ? JSON.parse(init.body) : {};
    return handle(method, u.pathname, u.searchParams, body);
  };

  // Live channel always fails → the app polls the stubbed move log.
  var RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (!isApi(url)) return new RealWS(url, protocols);
    var ws = { readyState: 3, send: function () {}, close: function () {} };
    setTimeout(function () { if (ws.onclose) ws.onclose({ code: 1006 }); }, 0);
    return ws;
  };
  window.WebSocket.OPEN = 1;
})();
