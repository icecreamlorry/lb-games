// In-memory Supabase stub for browser/e2e tests. The real app imports
// createClient from the @supabase CDN; tests serve this module's text in its
// place (e.g. Playwright route fulfilment) so the app runs offline.
//
// Single-page in-memory store — enough for the guest create/join/play flow and
// the signed-in "My Games" lobby. Tests configure the signed-in view through
// globals set BEFORE the app loads (page.addInitScript):
//
//   globalThis.__TEST_USER     -> the object returned by auth.getUser()/getSession()
//                                 e.g. { id: 'u1', email: 'a@b.c',
//                                        user_metadata: { display_name: 'Alice' } }
//   globalThis.__TEST_MYROOMS  -> array returned by rpc('my_rooms', …); each row
//                                 is { code, status, players: [{seat,name,userId}],
//                                      invited_user_id, … }
//
// Signed-in tests must ALSO seed the persisted-session key the real
// supabase-js writes (shared/boot.js + auth.cachedUser() read it to route
// before first paint):
//
//   localStorage.setItem('sb-test-auth-token',
//     JSON.stringify({ access_token: 'tok', user: <same as __TEST_USER> }));
//
// Leave them unset for the anonymous-guest flow (getUser → null, my_rooms → []).

const DB = (globalThis.__DB = globalThis.__DB || { rooms: new Map(), moves: [] });

function builder(table) {
  const st = { table, op: 'select', row: null, patch: null, filters: [], selected: false, single: false, maybe: false };
  const api = {
    insert(row) { st.op = 'insert'; st.row = row; return api; },
    update(patch) { st.op = 'update'; st.patch = patch; return api; },
    upsert(row) { st.op = 'upsert'; st.row = row; return api; },
    delete() { st.op = 'delete'; return api; },
    select() { st.selected = true; return api; },
    eq(k, v) { st.filters.push(['eq', k, v]); return api; },
    gte(k, v) { st.filters.push(['gte', k, v]); return api; },
    order() { return api; },
    single() { st.single = true; return api; },
    maybeSingle() { st.maybe = true; return api; },
    then(res, rej) { return Promise.resolve().then(() => run(st)).then(res, rej); },
  };
  return api;
}

function matchRoomCode(st) { const f = st.filters.find((x) => x[1] === 'code'); return f ? f[2] : null; }

function run(st) {
  try {
    if (st.table === 'rooms') {
      if (st.op === 'insert') {
        const r = { ...st.row, status: st.row.status || 'waiting' };
        // Seed a second player so the host can start a 2-player game in the test.
        r.players = [...(r.players || []), { seat: 1, name: 'Bob', userId: null, guestId: 'bob' }];
        r.player_count = r.players.length;
        DB.rooms.set(r.code, r);
        return { data: r, error: null };
      }
      if (st.op === 'update') { const r = DB.rooms.get(matchRoomCode(st)); if (r) Object.assign(r, st.patch); return { data: r, error: null }; }
      const r = DB.rooms.get(matchRoomCode(st)) || null;
      return { data: r, error: null };
    }
    if (st.table === 'moves') {
      if (st.op === 'insert') { DB.moves.push({ ...st.row }); return { data: st.row, error: null }; }
      // select
      let rows = DB.moves.filter((m) => m.room_code === (st.filters.find((f) => f[1] === 'room_code')?.[2]));
      const g = st.filters.find((f) => f[0] === 'gte' && f[1] === 'move_index');
      if (g) rows = rows.filter((m) => m.move_index >= g[2]);
      rows = rows.slice().sort((a, b) => a.move_index - b.move_index);
      return { data: rows, error: null };
    }
    return { data: st.single ? null : [], error: null };
  } catch (e) { return { data: null, error: { message: String(e) } }; }
}

function channel() {
  const ch = {
    on() { return ch; },
    subscribe() { return ch; }, // stay in DB polling mode so injected moves sync
    track() { return Promise.resolve(); },
    send() { return Promise.resolve(); },
    presenceState() { return {}; },
  };
  return ch;
}

function testUser() { return globalThis.__TEST_USER || null; }

export function createClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: testUser() }, error: null }),
      getSession: async () => {
        const user = testUser();
        return { data: { session: user ? { user } : null }, error: null };
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => {
        globalThis.__TEST_USER = null;
        try { localStorage.removeItem('sb-test-auth-token'); } catch {}
        return { error: null };
      },
    },
    from: (t) => builder(t),
    rpc: async (name) => (name === 'my_rooms'
      ? { data: globalThis.__TEST_MYROOMS || [], error: null }
      : { data: null, error: null }),
    channel: () => channel(),
    removeChannel() {},
  };
}
