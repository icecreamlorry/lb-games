// Splitz — multiplayer crossword tile race. Reuses the shared rooms/account
// layer (account-ui.js handles login/profile/friends/menu); this module handles
// the landing/lobby/room flow and the Splitz gameplay.
//
// The shared move log carries only pool-affecting events (start / draw / swap /
// win). Each player's crossword grid is PRIVATE and local (persisted to
// localStorage); it's only validated when they DRAW (used all tiles) or SPLITZ.

import { deriveState, handLetters, handSize, validateGrid, disconnectedKeys } from './engine.js';
import { loadDictionary, isWord, dictionaryLoaded } from './dictionary.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMyRooms, updateRoomStatus,
  finishRoom, RoomConnection, triggerPush, seatName, userSeat, markPlayerLeft,
} from './net.js';
import { createRematch } from '../../shared/rematch.js';
import { configReady, GAME_SLUG } from './config.js';
import { cachedUser, onAuthChange, displayName } from '../../shared/auth.js';
import { openHistory } from '../../shared/history.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';
import { getGuestName } from '../../shared/guest-name.js';
import {
  registerServiceWorker, requestNotifications, isEnabled as notifyEnabled,
  subscribeToPush, showLocalNotification, notificationsSupported, notificationPermission,
} from './notify.js';

const $ = (id) => document.getElementById(id);
const MAX_PLAYERS = 8;
const SESSION_KEY = 'splitz_session';
const CELL = 46; // grid cell size in px
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const app = {
  user: null, userId: null, name: null,
  code: null, seat: null, room: null, conn: null,
  seed: 0,
  moves: [],                 // the shared move log (deduped, sorted)
  state: null,               // deriveState() result
  placed: new Map(),         // "r,c" -> letter (this player's private grid)
  hand: [],                  // letters not yet placed (derived)
  pan: { x: 0, y: 0 },
  swapArmed: false,
  prevDraws: 0,
  finishPersisted: false,
  online: new Set(),
  // Spectating: at game over every client publishes its board so anyone can
  // tap a player to review their final grid + leftover tiles.
  spectateSeat: null,         // null = my own board; otherwise a seat to watch
  boards: new Map(),          // seat -> { placed: Map, hand: [] } from 'board' moves
  boardPublished: false,
  gameoverDismissed: false,
};

function playerName() { return app.user ? displayName(app.user) : getGuestName(); }

// ---- Screens --------------------------------------------------------------

function showScreen(which) {
  for (const id of ['screen-landing', 'screen-lobby', 'screen-game']) {
    $(id).classList.toggle('hidden', id !== `screen-${which}`);
  }
  if (which !== 'lobby') stopLobbyPolling();
}

// ---- Landing --------------------------------------------------------------

function landingError(msg) { $('landing-error').textContent = msg || ''; }
function requireName(errFn) {
  const n = playerName();
  if (!n) { errFn('Set your name first.'); return null; }
  return n;
}

$('btn-create').addEventListener('click', async () => {
  const name = requireName(landingError); if (!name) return;
  landingError('');
  try {
    const room = await createRoom(name, app.userId, null, MAX_PLAYERS);
    await enterRoom(room.code, 0, name, room);
  } catch (e) { landingError(e.message || 'Could not create a room.'); }
});

$('btn-join').addEventListener('click', () => {
  if (!requireName(landingError)) return;
  $('join-box').classList.toggle('hidden');
  $('code-input').focus();
});

function doJoin(codeEl, errFn) {
  const name = requireName(errFn); if (!name) return;
  const code = codeEl.value.trim().toUpperCase();
  if (code.length < 4) { errFn('Enter the room code.'); return; }
  errFn('');
  joinAndEnter(code, name, errFn);
}
async function joinAndEnter(code, name, errFn) {
  try {
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
  } catch (e) { errFn(e.message || 'Could not join that room.'); }
}
$('btn-join-go').addEventListener('click', () => doJoin($('code-input'), landingError));
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin($('code-input'), landingError); });
$('btn-go-lobby').addEventListener('click', () => { showScreen('lobby'); renderLobby(); });

// ---- Auth -----------------------------------------------------------------

function onAuth(user) {
  app.user = user;
  app.userId = user?.id ?? null;
  app.name = playerName();
  $('btn-go-lobby').classList.toggle('hidden', !user);
  if ($('screen-game').classList.contains('hidden')) {
    if (user) { showScreen('lobby'); renderLobby(); }
    else showScreen('landing');
  }
}

// ---- Lobby ----------------------------------------------------------------

let lobbyPoll = null;
function startLobbyPolling() {
  stopLobbyPolling();
  lobbyPoll = setInterval(() => {
    if (!$('screen-lobby').classList.contains('hidden') && !document.hidden) renderLobby();
  }, 6000);
}
function stopLobbyPolling() { if (lobbyPoll) { clearInterval(lobbyPoll); lobbyPoll = null; } }

$('btn-lobby-new').addEventListener('click', async () => {
  try {
    const room = await createRoom(app.name, app.userId, null, MAX_PLAYERS);
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { $('lobby-error').textContent = e.message; }
});
$('btn-lobby-join').addEventListener('click', () => { $('lobby-join-box').classList.toggle('hidden'); $('lobby-code-input').focus(); });
$('btn-lobby-join-go').addEventListener('click', () => doJoin($('lobby-code-input'), (m) => ($('lobby-error').textContent = m)));
$('lobby-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-lobby-join-go').click(); });
$('btn-lobby-refresh').addEventListener('click', renderLobby);
$('btn-lobby-challenge').addEventListener('click', () => window.LBAccount?.openProfile());
$('btn-lobby-history').addEventListener('click', () => openHistory({ userId: app.userId, gameSlug: GAME_SLUG }));
$('btn-logout-lobby').addEventListener('click', async () => { const { signOut } = await import('../../shared/auth.js'); try { await signOut(); } catch {} });

async function renderLobby() {
  if (!app.userId) return;
  startLobbyPolling();
  revealNotify();
  $('lobby-name').textContent = app.name || 'player';
  let rooms;
  try { rooms = await fetchMyRooms(app.userId); }
  catch (e) { $('lobby-error').textContent = `Could not load games (${e.message}).`; return; }
  rooms = filterDismissed(app.userId, rooms);
  const list = $('lobby-list');
  if (!rooms.length) {
    list.innerHTML = '<p class="lobby-empty">No games yet. <strong>NEW GAME</strong> to start one, or challenge a friend.</p>';
    return;
  }
  list.innerHTML = '';
  for (const room of rooms) list.appendChild(lobbyCard(room));
}

function lobbyCard(room) {
  const players = room.players ?? [];
  const invitedMe = room.invited_user_id === app.userId && players.every((p) => p.userId !== app.userId);
  const finished = room.status === 'finished';
  const playing = room.status === 'playing';
  let label, status, live = false;
  if (invitedMe) { label = `${players[0]?.name || 'Someone'} invited you`; status = 'Tap to join'; live = true; }
  else { label = `${players.length} player${players.length === 1 ? '' : 's'}`; status = finished ? 'Finished' : playing ? 'In progress' : 'Waiting — tap to open'; live = playing; }

  const card = document.createElement('button');
  card.className = 'lobby-game' + (live ? ' live' : '') + (finished ? ' finished' : '');
  card.innerHTML = `<span class="lobby-opp">${esc(label)}</span><span class="lobby-status">${esc(status)}</span>`
    + `<span class="lobby-score">${room.code}</span>`;
  card.addEventListener('click', () => openFromLobby(room, invitedMe));
  card.appendChild(makeDismissControl({
    userId: app.userId, code: room.code, card,
    onRemoved: () => { if (!$('lobby-list').children.length) renderLobby(); },
  }));
  return card;
}

async function openFromLobby(room, invitedMe) {
  try {
    const { room: updated, playerIndex } = await joinRoom(room.code, app.name, app.userId);
    await enterRoom(room.code, playerIndex, app.name, updated);
  } catch (e) { $('lobby-error').textContent = e.message; }
}

// ---- Challenge a friend ---------------------------------------------------
// The friend list lives in the shared profile dialog; we just feed it the
// game-specific action via LB_CONFIG.onChallengeFriend (set in boot()).

async function challengeFriend(friend) {
  try {
    const room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name }, MAX_PLAYERS);
    triggerPush({ user_id: friend.id, title: 'Splitz challenge!', body: `${app.name} challenged you to Splitz.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { $('lobby-error').textContent = e.message; }
}

// ---- Room lifecycle -------------------------------------------------------

function resetGame() {
  if (app.conn) { app.conn.close(); app.conn = null; }
  app.moves = [];
  app.state = null;
  app.placed = new Map();
  app.hand = [];
  app.pan = { x: 0, y: 0 };
  app.swapArmed = false;
  app.prevDraws = 0;
  app.finishPersisted = false;
  app.online = new Set();
  app.spectateSeat = null;
  app.boards = new Map();
  app.boardPublished = false;
  app.gameoverDismissed = false;
  app.rematching = false;
  // Wipe any stale end-of-game UI so a previous "SPLITZ!" can't linger.
  $('gameover-overlay')?.classList.add('hidden');
  const gt = $('gameover-title'); if (gt) { gt.textContent = 'SPLITZ!'; gt.classList.remove('loss'); }
  if ($('gameover-detail')) $('gameover-detail').textContent = '';
  $('btn-peel')?.classList.add('hidden');
  if ($('btn-dump')) { $('btn-dump').classList.remove('armed'); $('btn-dump').textContent = 'SWAP'; }
  if ($('btn-rematch')) $('btn-rematch').disabled = false;
  $('spectate-hint')?.classList.add('hidden');
  setStatus('');
}

async function enterRoom(code, seat, name, room) {
  resetGame();
  app.code = code; app.seat = seat; app.name = name; app.room = room;
  app.seed = Number(room.seed) >>> 0;
  loadPlaced();
  $('room-code-text').textContent = code;
  showScreen('game');
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name }));
  loadDictionary().then(() => { renderGrid(); updateControls(); }).catch(() => {});

  app.conn = new RoomConnection(code, seat, name, {
    onMove: handleMove,
    onPresence: handlePresence,
    onMode: () => {},
    onRoomUpdate: handleRoomUpdate,
  });
  app.conn.connect();

  recompute();
  renderAll();
  requestAnimationFrame(() => { if (app.placed.size) recenter(); else centerOrigin(); renderGrid(); });

  if (notifyEnabled()) subscribeToPush({ userId: app.userId || undefined, roomCode: app.userId ? undefined : code, player: app.userId ? undefined : seat }).catch(() => {});
}

$('btn-leave').addEventListener('click', leaveRoom);
$('btn-gameover-done').addEventListener('click', () => { if (app.code) dismissGame(app.userId, app.code); leaveRoom(); });

async function leaveRoom() {
  // Flag our seat as left if we walk out of a game in progress, so the others
  // see it (cleared if we rejoin). Skipped once the game has finished.
  if (app.code != null && app.seat != null && app.room && app.room.status !== 'finished') {
    try { const room = await markPlayerLeft(app.code, app.seat); if (room) app.conn?.broadcastRoom(room); } catch { /* best effort */ }
  }
  sessionStorage.removeItem(SESSION_KEY);
  resetGame();
  app.code = null; app.seat = null; app.room = null;
  if (app.user) { showScreen('lobby'); renderLobby(); } else showScreen('landing');
}

$('room-code-chip').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(app.code); setStatus('Room code copied.'); } catch {}
});

// ---- Move log -------------------------------------------------------------

function nextIndex() {
  let max = -1;
  for (const m of app.moves) if (m.move_index > max) max = m.move_index;
  return max + 1;
}

// Append a pool-affecting move. Pool moves are an interleaved, concurrent log,
// so on a duplicate-index clash we catch up from the server and retry.
async function appendMove(type, payload = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const move = { move_index: nextIndex(), player: app.seat, type, payload };
    try {
      await app.conn.sendMove(move);
      handleMove(move); // broadcast won't echo to us, so apply locally
      return move;
    } catch {
      try { await app.conn.pollOnce(); } catch {}
      await delay(120 * (attempt + 1));
    }
  }
  throw new Error('Could not sync with the other players — please retry.');
}

function handleMove(move) {
  if (move.type === 'rematch') { rematch.follow(move.payload?.code); return; }
  if (app.moves.some((m) => m.move_index === move.move_index)) return; // dedup
  app.moves.push(move);
  app.moves.sort((a, b) => a.move_index - b.move_index);
  recompute();
  reactToState();
  renderAll();
}

function handlePresence(set) {
  app.online = set;
  const known = (app.room?.players ?? []).length;
  let maxSeat = -1;
  set.forEach((k) => { const n = Number(k); if (Number.isFinite(n)) maxSeat = Math.max(maxSeat, n); });
  if (maxSeat + 1 > known) {
    fetchRoom(app.code).then((r) => { app.room = r; renderPlayers(); renderPrestart(); }).catch(() => {});
  }
  renderPlayers();
}

function handleRoomUpdate(room) {
  if (!room) return;
  app.room = room;
  renderPlayers();
  renderPrestart();
}

// Collect published end-of-game boards (type 'board' moves) for spectating.
function collectBoards() {
  app.boards = new Map();
  for (const m of app.moves) {
    if (m.type === 'board') {
      app.boards.set(m.player, {
        placed: new Map(m.payload?.placed || []),
        hand: Array.isArray(m.payload?.hand) ? m.payload.hand : [],
      });
    }
  }
}

// Recompute derived pool state + this player's hand from the log.
function recompute() {
  app.state = deriveState(app.seed, app.moves);
  collectBoards();
  // Before the deal lands (e.g. resuming while the log is still loading) keep
  // the restored grid untouched — there's no entitlement to reconcile against
  // yet, and wiping it here would lose the player's crossword.
  if (!app.state.started) { app.hand = []; return; }
  const entitled = app.state.entitled[app.seat] || [];
  // handLetters tolerates placed tiles that aren't (yet) in `entitled`, so the
  // hand is correct even mid-replay. Pruning stale placements is deferred (see
  // scheduleReconcile) so a resume — where DRAW moves arrive one at a time —
  // never deletes valid tiles from a draw that simply hasn't replayed yet.
  app.hand = handLetters(entitled, placedLetters());
  scheduleReconcile();
}

// Drop placed tiles not backed by our entitlement (stale storage), but only
// after the move log settles. Debounced: a burst of catch-up moves on resume
// reconciles once, against the COMPLETE entitlement — never against a partial
// one mid-replay (which would wrongly delete valid placements).
let reconcileTimer = null;
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    if (!app.state?.started) return;
    const entitled = app.state.entitled[app.seat] || [];
    const before = app.placed.size;
    reconcilePlaced(entitled);
    if (app.placed.size !== before) {
      app.hand = handLetters(entitled, placedLetters());
      savePlaced();
      renderAll();
    }
  }, 0);
}

// Drop any placed tiles not backed by our entitlement (e.g. stale storage).
function reconcilePlaced(entitled) {
  const avail = new Map();
  for (const l of entitled) avail.set(l, (avail.get(l) || 0) + 1);
  for (const [k, letter] of [...app.placed]) {
    const n = avail.get(letter) || 0;
    if (n <= 0) app.placed.delete(k);
    else avail.set(letter, n - 1);
  }
}

// Side effects when the log changes: draw notices and game over.
function reactToState() {
  const st = app.state;
  if (st.draws > app.prevDraws && st.lastDrawBy != null && st.lastDrawBy !== app.seat) {
    const who = seatName(app.room, st.lastDrawBy) || 'A player';
    setStatus(`${who} finished a grid — everyone draws a tile.`);
    if (document.hidden) showLocalNotification('Splitz', `${who} finished — you drew a tile.`);
  }
  app.prevDraws = st.draws;

  if (st.gameOver) {
    if (!app.finishPersisted) persistFinish();
    publishBoard(); // share my final board so others can spectate it
  }
}

// Publish my final grid + leftover tiles (once) so everyone can review it.
// Sparse, per-seat index keeps it clear of the sequential pool log.
async function publishBoard() {
  if (app.boardPublished || app.seat == null) return;
  app.boardPublished = true;
  const move = {
    move_index: 900000 + app.seat,
    player: app.seat,
    type: 'board',
    payload: { placed: [...app.placed], hand: app.hand },
  };
  try { await app.conn.sendMove(move); handleMove(move); }
  catch { /* already published, or offline — best effort */ }
}

async function persistFinish() {
  app.finishPersisted = true;
  const players = app.state.players;
  const scores = Array.from({ length: players }, (_, s) => (s === app.state.winner ? 1 : 0));
  const result = { scores, winner: app.state.winner, reason: 'win' };
  try {
    await finishRoom(app.code, result, false);
    if (app.room) { app.room.status = 'finished'; app.room.result = result; }
  } catch { app.finishPersisted = false; }
}

// ---- Prestart / players / pool --------------------------------------------

function renderPrestart() {
  const ov = $('prestart-overlay');
  const started = app.state?.started;
  ov.classList.toggle('hidden', !!started);
  if (started) return;

  const players = app.room?.players ?? [];
  const count = players.length;
  const isHost = app.seat === 0;
  $('start-title').textContent = count >= 2 ? 'READY TO SPLIT' : 'WAITING FOR PLAYERS';
  $('start-info').textContent = count >= 2
    ? `${count} player${count === 1 ? '' : 's'} in. ${handSize(count)} tiles each.`
    : `Share code ${app.code} — at least 2 players needed.`;
  const canStart = isHost && count >= 2;
  $('btn-start').classList.toggle('hidden', !canStart);
  $('start-waiting').classList.toggle('hidden', isHost || count < 2);
}

$('btn-start').addEventListener('click', async () => {
  const count = (app.room?.players ?? []).length;
  if (count < 2) return;
  $('btn-start').disabled = true;
  try {
    await appendMove('start', { players: count, hand: handSize(count) });
    updateRoomStatus(app.code, 'playing').catch(() => {});
  } catch (e) { setStatus(e.message); }
  finally { $('btn-start').disabled = false; }
});

function renderPlayers() {
  const strip = $('players-strip');
  const players = app.room?.players ?? [];
  strip.innerHTML = '';
  players.forEach((p) => {
    const entitled = app.state?.entitled?.[p.seat]?.length;
    const div = document.createElement('div');
    const viewing = (app.spectateSeat ?? app.seat) === p.seat;
    div.className = 'pchip' + (p.seat === app.seat ? ' me' : '')
      + (viewing ? ' viewing' : '')
      + (app.state?.lastDrawBy === p.seat ? ' drew' : '');
    const online = app.online.has(String(p.seat));
    div.innerHTML = `<span class="pdot ${online ? '' : 'off'}"></span>`
      + `<span class="pname">${esc(p.name || `P${p.seat + 1}`)}</span>`
      + `<span class="ptiles">${entitled == null ? '·' : entitled}</span>`;
    div.addEventListener('click', () => spectate(p.seat));
    strip.appendChild(div);
  });
  $('spectate-hint').classList.toggle('hidden', !app.state?.started || players.length < 2);
}

// ---- Spectating other players' boards -------------------------------------

function isSpectating() { return app.spectateSeat != null && app.spectateSeat !== app.seat; }
function viewPlaced() { return isSpectating() ? (app.boards.get(app.spectateSeat)?.placed || new Map()) : app.placed; }
function viewHand() { return isSpectating() ? (app.boards.get(app.spectateSeat)?.hand || []) : app.hand; }

function spectate(seat) {
  if (seat === app.seat) { app.spectateSeat = null; }
  else if (app.boards.has(seat)) { app.spectateSeat = seat; }
  else { setStatus("That player's board appears once the game ends."); return; }
  recenter();
  renderAll();
  if (isSpectating()) {
    const who = seatName(app.room, app.spectateSeat) || `Player ${app.spectateSeat + 1}`;
    setStatus(`Spectating ${who} — tap your own name to go back.`);
  } else setStatus('');
}

function updatePool() {
  $('pool-count').textContent = app.state?.started ? app.state.poolRemaining : '–';
}

// ---- Grid rendering + panning ---------------------------------------------

const gridLayer = $('grid-layer');

function placedLetters() { return [...app.placed.values()]; }
function cellKey(r, c) { return r + ',' + c; }

function tileLeft(c) { return app.pan.x + c * CELL; }
function tileTop(r) { return app.pan.y + r * CELL; }

function cellFromPoint(clientX, clientY) {
  const rect = gridLayer.getBoundingClientRect();
  const lx = clientX - rect.left - app.pan.x;
  const ly = clientY - rect.top - app.pan.y;
  return { r: Math.floor(ly / CELL), c: Math.floor(lx / CELL) };
}

function centerOrigin() {
  const rect = gridLayer.getBoundingClientRect();
  app.pan.x = Math.round(rect.width / 2 - CELL / 2);
  app.pan.y = Math.round(rect.height / 2 - CELL / 2);
}

function recenter() {
  const rect = gridLayer.getBoundingClientRect();
  const placed = viewPlaced();
  if (!placed.size) { centerOrigin(); renderGrid(); return; }
  let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
  for (const k of placed.keys()) {
    const [r, c] = k.split(',').map(Number);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  const midC = (minC + maxC + 1) / 2;
  const midR = (minR + maxR + 1) / 2;
  app.pan.x = Math.round(rect.width / 2 - midC * CELL);
  app.pan.y = Math.round(rect.height / 2 - midR * CELL);
  renderGrid();
}
$('btn-recenter').addEventListener('click', recenter);

// Lift every invalid tile (disconnected from the main group, or in a non-word)
// back into the hand in one tap.
function returnInvalidTiles() {
  if (isSpectating() || !app.state?.started || app.state.gameOver) return;
  const bad = invalidTileKeys(app.placed);
  if (!bad.size) return;
  for (const k of bad) app.placed.delete(k);
  afterGridChange();
}
$('btn-return-invalid').addEventListener('click', returnInvalidTiles);

// Tiles to flag red as invalid: anything not joined to the biggest contiguous
// group (disconnected islands + strays), plus tiles in a non-dictionary run.
function invalidTileKeys(placed) {
  const bad = new Set();
  if (!placed || placed.size < 2) return bad;
  // Not connected to the main crossword — always flagged (no dictionary needed).
  for (const k of disconnectedKeys(placed)) bad.add(k);
  // Tiles in a run that isn't a real word (only once the dictionary is ready).
  if (dictionaryLoaded()) {
    const has = (r, c) => placed.has(cellKey(r, c));
    for (const k of placed.keys()) {
      const [r, c] = k.split(',').map(Number);
      if (!has(r, c - 1) && has(r, c + 1)) {
        let w = '', cc = c; const keys = [];
        while (has(r, cc)) { w += placed.get(cellKey(r, cc)); keys.push(cellKey(r, cc)); cc++; }
        if (!isWord(w)) keys.forEach((kk) => bad.add(kk));
      }
      if (!has(r - 1, c) && has(r + 1, c)) {
        let w = '', rr = r; const keys = [];
        while (has(rr, c)) { w += placed.get(cellKey(rr, c)); keys.push(cellKey(rr, c)); rr++; }
        if (!isWord(w)) keys.forEach((kk) => bad.add(kk));
      }
    }
  }
  return bad;
}

function renderGrid() {
  const placed = viewPlaced();
  gridLayer.style.backgroundSize = `${CELL}px ${CELL}px`;
  gridLayer.style.backgroundPosition = `${app.pan.x}px ${app.pan.y}px`;
  gridLayer.querySelectorAll('.gtile').forEach((el) => el.remove());
  const bad = invalidTileKeys(placed);
  const btnRet = $('btn-return-invalid');
  if (btnRet) btnRet.disabled = isSpectating() || !app.state?.started || app.state?.gameOver || bad.size === 0;
  for (const [k, letter] of placed) {
    const [r, c] = k.split(',').map(Number);
    const el = document.createElement('div');
    el.className = 'gtile' + (bad.has(k) ? ' bad' : '');
    el.style.width = el.style.height = CELL - 4 + 'px';
    el.style.left = tileLeft(c) + 2 + 'px';
    el.style.top = tileTop(r) + 2 + 'px';
    el.style.fontSize = '1.3rem';
    el.textContent = letter;
    el.dataset.key = k;
    el.addEventListener('pointerdown', (e) => onTilePointerDown(e, k));
    gridLayer.appendChild(el);
  }
}

function renderHand() {
  const el = $('hand');
  const hand = viewHand();
  el.classList.toggle('armed', app.swapArmed && !isSpectating());
  el.innerHTML = '';
  if (!hand.length) {
    const span = document.createElement('span');
    span.className = 'hand-empty';
    span.textContent = isSpectating() ? 'No tiles left in hand.'
      : app.state?.started ? "Hand empty — hit DRAW when your grid's valid!" : 'Waiting to start…';
    el.appendChild(span);
    return;
  }
  hand.forEach((letter, i) => {
    const t = document.createElement('div');
    t.className = 'htile';
    t.textContent = letter;
    t.dataset.handIndex = String(i);
    t.addEventListener('pointerdown', (e) => onHandPointerDown(e, letter));
    el.appendChild(t);
  });
}

// ---- Pointer drag + pan ---------------------------------------------------

let drag = null; // { kind:'hand'|'grid', letter, fromKey, el }
let panning = null; // { startX, startY, panX, panY, moved }

function onHandPointerDown(e, letter) {
  e.preventDefault();
  if (isSpectating()) return;
  if (app.swapArmed) { doSwap(letter); return; }
  if (!app.state?.started || app.state.gameOver) return;
  beginDrag({ kind: 'hand', letter }, e);
}

function onTilePointerDown(e, key) {
  e.preventDefault();
  e.stopPropagation();
  if (isSpectating() || !app.state?.started || app.state.gameOver) return;
  const letter = app.placed.get(key);
  if (letter == null) return;
  app.placed.delete(key); // lift it off the board
  renderGrid();
  beginDrag({ kind: 'grid', letter, fromKey: key }, e);
}

function beginDrag(d, e) {
  const el = document.createElement('div');
  el.className = 'drag-tile';
  el.style.width = el.style.height = CELL - 4 + 'px';
  el.style.fontSize = '1.3rem';
  el.textContent = d.letter;
  document.body.appendChild(el);
  drag = { ...d, el };
  moveDragTo(e.clientX, e.clientY);
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
}

function moveDragTo(x, y) {
  if (!drag) return;
  drag.el.style.left = x - (CELL - 4) / 2 + 'px';
  drag.el.style.top = y - (CELL - 4) / 2 + 'px';
}

function onDragMove(e) { moveDragTo(e.clientX, e.clientY); }

function onDragEnd(e) {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  const d = drag; drag = null;
  if (d?.el) d.el.remove();
  if (!d) return;

  const handRect = $('hand').getBoundingClientRect();
  const gridRect = gridLayer.getBoundingClientRect();
  const inHand = e.clientX >= handRect.left && e.clientX <= handRect.right && e.clientY >= handRect.top && e.clientY <= handRect.bottom;
  const inGrid = e.clientX >= gridRect.left && e.clientX <= gridRect.right && e.clientY >= gridRect.top && e.clientY <= gridRect.bottom;

  if (inHand) {
    // Return to hand: a grid tile is already lifted; a hand tile stays put.
  } else if (inGrid) {
    const { r, c } = cellFromPoint(e.clientX, e.clientY);
    const key = cellKey(r, c);
    if (!app.placed.has(key)) app.placed.set(key, d.letter);
    else if (d.kind === 'grid' && d.fromKey) app.placed.set(d.fromKey, d.letter); // occupied: snap back
  } else if (d.kind === 'grid' && d.fromKey) {
    app.placed.set(d.fromKey, d.letter); // dropped off-board: snap back
  }
  afterGridChange();
}

// Pan when dragging empty grid space.
gridLayer.addEventListener('pointerdown', (e) => {
  if (e.target !== gridLayer) return; // tiles handle their own
  e.preventDefault();
  panning = { startX: e.clientX, startY: e.clientY, panX: app.pan.x, panY: app.pan.y, moved: false };
  gridLayer.classList.add('panning');
  window.addEventListener('pointermove', onPanMove);
  window.addEventListener('pointerup', onPanEnd);
});
function onPanMove(e) {
  if (!panning) return;
  app.pan.x = panning.panX + (e.clientX - panning.startX);
  app.pan.y = panning.panY + (e.clientY - panning.startY);
  if (Math.abs(e.clientX - panning.startX) + Math.abs(e.clientY - panning.startY) > 3) panning.moved = true;
  renderGrid();
}
function onPanEnd() {
  window.removeEventListener('pointermove', onPanMove);
  window.removeEventListener('pointerup', onPanEnd);
  gridLayer.classList.remove('panning');
  if (panning?.moved) savePlaced();
  panning = null;
}

function afterGridChange() {
  app.hand = handLetters(app.state?.entitled?.[app.seat] || [], placedLetters());
  savePlaced();
  renderGrid();
  renderHand();
  updateControls();
}

// ---- Swap / shuffle / draw / win ------------------------------------------

$('btn-dump').addEventListener('click', () => {
  if ($('btn-dump').disabled) return;
  app.swapArmed = !app.swapArmed;
  $('btn-dump').classList.toggle('armed', app.swapArmed);
  $('btn-dump').textContent = app.swapArmed ? 'CANCEL' : 'SWAP';
  renderHand();
  setStatus(app.swapArmed ? 'Tap a tile in your hand to swap it for three.' : '');
});

async function doSwap(letter) {
  app.swapArmed = false;
  $('btn-dump').classList.remove('armed');
  $('btn-dump').textContent = 'SWAP';
  if (!app.state || app.state.poolRemaining < 3) { setStatus('Not enough tiles left in the pool to swap.'); renderHand(); return; }
  try { await appendMove('swap', { letter }); setStatus('Swapped 1 tile for 3.'); }
  catch (e) { setStatus(e.message); }
}

$('btn-shuffle').addEventListener('click', () => {
  for (let i = app.hand.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [app.hand[i], app.hand[j]] = [app.hand[j], app.hand[i]];
  }
  renderHand();
});

$('btn-peel').addEventListener('click', async () => {
  const v = validateGrid(app.placed, isWord);
  if (!v.valid) { setStatus(v.reason); return; }
  if (app.hand.length) { setStatus('Place all your tiles first.'); return; }
  const win = app.state.poolRemaining < app.state.players;
  try {
    await appendMove(win ? 'win' : 'draw', {});
    setStatus(win ? 'SPLITZ! 🎉' : 'You finished a grid — everyone draws a tile.');
  } catch (e) { setStatus(e.message); }
});

function updateControls() {
  const st = app.state;
  // When watching another player's board, all my action controls are off.
  if (isSpectating()) {
    $('btn-dump').disabled = true;
    $('btn-shuffle').disabled = true;
    $('btn-peel').classList.add('hidden');
    return;
  }
  const playing = !!st?.started && !st.gameOver;
  const handLen = app.hand.length;
  $('btn-dump').disabled = !(playing && handLen > 0 && st.poolRemaining >= 3);
  $('btn-shuffle').disabled = !(playing && handLen > 0);

  const ready = playing && handLen === 0 && app.placed.size > 0 && dictionaryLoaded() && validateGrid(app.placed, isWord).valid;
  const drawBtn = $('btn-peel');
  if (ready) {
    const win = st.poolRemaining < st.players;
    drawBtn.classList.remove('hidden');
    drawBtn.classList.toggle('win', win);
    drawBtn.textContent = win ? 'SPLITZ!' : 'DRAW!';
  } else {
    drawBtn.classList.add('hidden');
  }

  // A nudge when the hand is empty but the grid isn't valid yet.
  if (playing && handLen === 0 && app.placed.size > 0 && dictionaryLoaded() && !ready) {
    const v = validateGrid(app.placed, isWord);
    if (!v.valid) setStatus(v.reason);
  }
}

// ---- Game over ------------------------------------------------------------

function renderGameOver() {
  const ov = $('gameover-overlay');
  const over = !!app.state?.gameOver;
  ov.classList.toggle('hidden', !over || app.gameoverDismissed);
  if (!over) return;
  const iWon = app.state.winner === app.seat;
  const winner = seatName(app.room, app.state.winner) || `Player ${app.state.winner + 1}`;
  const title = $('gameover-title');
  title.textContent = iWon ? 'SPLITZ! YOU WIN 🎉' : 'GAME OVER';
  title.classList.toggle('loss', !iWon);
  $('gameover-detail').textContent = iWon ? 'You finished your grid with the pool too low to draw.' : `${winner} called Splitz first.`;
}

// Dismiss the winner box to look around the final boards (tap a player to view).
function dismissGameover() {
  app.gameoverDismissed = true;
  $('gameover-overlay').classList.add('hidden');
  setStatus('Tap a player up top to see their final board.');
}
$('btn-gameover-close').addEventListener('click', dismissGameover);
$('btn-gameover-look').addEventListener('click', dismissGameover);

// ---- Rematch (shared) -----------------------------------------------------
// One tap spins up a fresh room and pulls everyone still here into it.
const rematch = createRematch({
  state: app,
  createRoom: (name, userId) => createRoom(name, userId, null, MAX_PLAYERS),
  joinRoom, enterRoom,
  onError: (msg) => setStatus(msg),
});
$('btn-rematch').addEventListener('click', rematch.start);

// ---- Status + render-all --------------------------------------------------

function setStatus(msg) { $('status-line').textContent = msg || ''; }

function renderAll() {
  renderPrestart();
  renderPlayers();
  updatePool();
  renderGrid();
  renderHand();
  updateControls();
  renderGameOver();
}

// ---- Local grid persistence ----------------------------------------------

function placedStoreKey() { return `splitz.grid.${app.code}.${app.seat}`; }
function savePlaced() {
  try {
    localStorage.setItem(placedStoreKey(), JSON.stringify({ placed: [...app.placed], pan: app.pan }));
  } catch { /* ignore */ }
}
function loadPlaced() {
  try {
    const raw = localStorage.getItem(placedStoreKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    app.placed = new Map(data.placed || []);
    if (data.pan) app.pan = data.pan;
  } catch { app.placed = new Map(); }
}

// ---- Notifications toggle (lobby + game share the 🔔) ----------------------

async function onToggleNotify() {
  const res = await requestNotifications();
  if (res === 'granted') {
    subscribeToPush({ userId: app.userId || undefined }).catch(() => {});
    revealNotify();
  }
}
$('btn-notify-lobby').addEventListener('click', onToggleNotify);

// Show the lobby 🔔 when the device can do notifications and they aren't on yet.
function revealNotify() {
  const btn = $('btn-notify-lobby');
  const show = notificationsSupported() && notificationPermission() !== 'denied' && !notifyEnabled();
  btn.classList.toggle('hidden', !show);
}

// ---- Resume / boot --------------------------------------------------------

async function tryResume() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  try {
    const { code, name } = JSON.parse(raw);
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
    return true;
  } catch { sessionStorage.removeItem(SESSION_KEY); return false; }
}

async function boot() {
  registerServiceWorker();
  // Feed the game-specific challenge action into the shared friends dialog.
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  if (!configReady()) { landingError('Backend not configured.'); }
  // Cached session (sync, no network) decides the initial screen; the boot
  // veil stays up until the route — including a room resume — is settled.
  app.user = cachedUser();
  app.userId = app.user?.id ?? null;
  app.name = playerName();
  onAuthChange(onAuth);

  const resumed = await tryResume();
  if (!resumed) onAuth(app.user);
  window.LBBoot?.done();
}

boot();
