import {
  newGameState, applyMove, replayMoves, validatePlay, classifySet, arrangeSet,
  tileColor, tileNum, isJoker, tileValue, RACK_SIZE, MELD_MIN, MAX_PLAYERS, COLORS,
} from './engine.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMoves, fetchMyRooms, updateRoomStatus,
  finishRoom, RoomConnection, triggerPush, seatName, userSeat, seatLeft, markPlayerLeft, updateRoom,
} from './net.js';
import { createRematch } from '../../shared/rematch.js';
import { takeRoomParam, roomShareUrl } from '../../shared/deep-link.js';
import { openHistory } from '../../shared/history.js';
import { cachedUser, onAuthChange, displayName, signOut } from '../../shared/auth.js';
import {
  notificationsSupported, notificationPermission, requestNotifications,
  registerServiceWorker, showTurnNotification, clearTurnNotification,
  isEnabled as notifyEnabled, isMuted, setMuted, subscribeToPush, unsubscribeFromPush,
} from './notify.js';
import { configReady, GAME_SLUG } from './config.js';
import { getGuestName, setGuestName } from '../../shared/guest-name.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';
import { TIME_CONTROLS, TIME_LABELS, TIME_SHORT, fmtClock } from '../../shared/time-control.js';

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Multiset of tile kinds → Map(tile → count), and helpers over it.
function tally(tiles) { const m = new Map(); for (const t of tiles) m.set(t, (m.get(t) || 0) + 1); return m; }

const app = {
  user: null, userId: null, name: null, code: null, playerIndex: null,
  room: null, state: null, conn: null,
  work: null,            // { sets: [[tile]], rack: [tile] } — this turn's working arrangement
  held: null,            // { tile, returnable } — a tile currently picked up
  sortMode: 'run',       // rack sort: 'run' (colour→number) or 'group' (number→colour)
  lastDrawn: null,       // tile I most recently drew, highlighted until my next turn
  drag: null,            // in-progress tile drag, or null
  present: new Set(),    // seats currently online (strings)
  connMode: 'db', pendingMoves: new Map(), flagClaimed: false,
  timeKey: 'unlimited', turnAnchorMs: 0, finishPersisted: false,
};

const SESSION_KEY = 'rummikub_session';
function saveSession(data) {
  const raw = JSON.stringify(data);
  try {
    if (app.userId) { sessionStorage.setItem(SESSION_KEY, raw); localStorage.removeItem(SESSION_KEY); }
    else { localStorage.setItem(SESSION_KEY, raw); sessionStorage.removeItem(SESSION_KEY); }
  } catch { /* storage blocked */ }
}
function readSession() { try { return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

// ---- Landing + setup --------------------------------------------------------

function landingError(msg) { $('landing-error').textContent = msg || ''; }
function getName() { const n = $('landing-name-input').value.trim(); if (!n) { landingError('Please enter your name first.'); return null; } setGuestName(n); return n; }

let setupCtx = null;
function openSetup(name, userId, onError, friend = null) {
  setupCtx = { name, userId, onError, friend };
  $('setup-subtitle').textContent = friend
    ? `Choose a per-move time for your challenge to ${friend.display_name || 'your friend'}.`
    : 'How long does each player get per move? (2–4 can join.)';
  $('modal-setup').classList.remove('hidden');
}
function closeSetup() { $('modal-setup').classList.add('hidden'); setupCtx = null; }
document.querySelectorAll('#setup-times .setup-time').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.time; const ctx = setupCtx; closeSetup();
    if (!ctx) return;
    if (ctx.friend) createChallengeWithTime(ctx.friend, key);
    else createAndEnter(ctx.name, ctx.userId, key, ctx.onError);
  });
});
$('setup-cancel').addEventListener('click', closeSetup);
$('modal-setup').addEventListener('click', (e) => { if (e.target.id === 'modal-setup') closeSetup(); });

async function stampTime(room, key) {
  try {
    const players = (room.players || []).map((p, i) => (i === 0 ? { ...p, time: key } : p));
    const data = await updateRoom(room.code, { players });
    return data || { ...room, players };
  } catch { return { ...room, players: (room.players || []).map((p, i) => (i === 0 ? { ...p, time: key } : p)) }; }
}
function roomTimeKey(room) { return room?.players?.[0]?.time || app.timeKey || 'unlimited'; }

async function createAndEnter(name, userId, timeKey, onError) {
  requestNotifications().then(onNotifyPermissionResolved);
  try {
    app.timeKey = timeKey;
    let room = await createRoom(name, userId, null, MAX_PLAYERS);
    room = await stampTime(room, timeKey);
    await enterRoom(room.code, 0, name, room);
  } catch (e) { onError(e.message); }
}
async function joinAndEnter(code, name, userId, onError) {
  if (code.length < 4) { onError('Enter the room code you were given.'); return; }
  requestNotifications().then(onNotifyPermissionResolved);
  try { const { room, playerIndex } = await joinRoom(code, name, userId); await enterRoom(code, playerIndex, name, room); }
  catch (e) { onError(e.message); }
}
$('btn-create').addEventListener('click', () => { const name = getName(); if (!name) return; landingError(''); openSetup(name, null, landingError); });
$('btn-join').addEventListener('click', () => { if (!getName()) return; landingError(''); $('join-box').classList.toggle('hidden'); $('code-input').focus(); });
function doJoin() { const name = getName(); if (!name) return; landingError(''); joinAndEnter($('code-input').value.trim().toUpperCase(), name, null, landingError); }
$('btn-join-go').addEventListener('click', doJoin);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

// ---- Screens & accounts -----------------------------------------------------

function showScreen(which) {
  for (const id of ['screen-landing', 'screen-lobby', 'screen-game']) $(id).classList.toggle('hidden', id !== `screen-${which}`);
  document.body.dataset.screen = which;
  if (which !== 'lobby') stopLobbyPolling();
  postRoomVisibility();
}
async function postRoomVisibility() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const inGame = !$('screen-game').classList.contains('hidden');
    reg.active?.postMessage({ type: 'room-visible', code: inGame ? app.code : null, visible: inGame && !document.hidden });
  } catch { /* ignore */ }
}
function pushRoute() {
  if (app.userId) return { userId: app.userId };
  if (app.code !== null && app.playerIndex !== null) return { roomCode: app.code, player: app.playerIndex };
  return null;
}
function refreshPushSub() { const r = pushRoute(); if (r && notifyEnabled()) subscribeToPush(r).catch(() => {}); }
function applyAuthToUI() { $('btn-go-lobby')?.classList.toggle('hidden', !app.user); if (app.user) $('lobby-name').textContent = app.name; renderNotifyBtns(); }
function handleAuthChange(user) {
  app.user = user; app.userId = user?.id ?? null; if (user) app.name = displayName(user);
  applyAuthToUI();
  if (user && notifyEnabled()) refreshPushSub();
  if ($('screen-game').classList.contains('hidden')) { if (user) { showScreen('lobby'); renderLobby(); } else showScreen('landing'); }
}
$('btn-go-lobby')?.addEventListener('click', () => { showScreen('lobby'); renderLobby(); });
$('btn-logout-lobby').addEventListener('click', async () => { try { await signOut(); } catch { /* ignore */ } });

// ---- Lobby ------------------------------------------------------------------

$('btn-lobby-new').addEventListener('click', () => { lobbyError(''); openSetup(app.name, app.userId, lobbyError); });
$('btn-lobby-join').addEventListener('click', () => { lobbyError(''); $('lobby-join-box').classList.toggle('hidden'); $('lobby-code-input').focus(); });
function doLobbyJoin() { lobbyError(''); joinAndEnter($('lobby-code-input').value.trim().toUpperCase(), app.name, app.userId, lobbyError); }
$('btn-lobby-join-go').addEventListener('click', doLobbyJoin);
$('lobby-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLobbyJoin(); });
$('btn-lobby-refresh').addEventListener('click', () => renderLobby());
$('btn-lobby-challenge').addEventListener('click', () => window.LBAccount?.openProfile());
$('btn-lobby-history').addEventListener('click', () => openHistory({ userId: app.userId, gameSlug: GAME_SLUG }));
function lobbyError(msg) { $('lobby-error').textContent = msg || ''; }

let lobbyPollTimer = null;
function startLobbyPolling() { stopLobbyPolling(); lobbyPollTimer = setInterval(() => { if (!$('screen-lobby').classList.contains('hidden') && !document.hidden) renderLobby(); }, 5000); }
function stopLobbyPolling() { if (lobbyPollTimer) { clearInterval(lobbyPollTimer); lobbyPollTimer = null; } }

async function renderLobby() {
  if (!app.userId) return;
  startLobbyPolling();
  const list = $('lobby-list');
  let rooms;
  try { rooms = await fetchMyRooms(app.userId); } catch (e) { lobbyError(`Could not load your games (${e.message}).`); return; }
  rooms = filterDismissed(app.userId, rooms);
  if (!rooms.length) { list.innerHTML = '<p class="lobby-empty muted">No games yet. Start one with <strong>New game</strong>, or join a friend\'s with their code.</p>'; return; }
  const summaries = await Promise.all(rooms.map(summarizeRoom));
  list.innerHTML = '';
  for (const s of summaries) list.appendChild(buildLobbyCard(s));
}
async function summarizeRoom(room) {
  const myIndex = userSeat(room, app.userId);
  if (room.status === 'finished' && room.result) return { room, myIndex, state: { started: true, gameOver: true, winner: room.result.winner } };
  let state = null;
  try { state = replayMoves(room.seed, await fetchMoves(room.code)); } catch { /* best effort */ }
  return { room, myIndex, state };
}
function othersLabel(room, myIndex) {
  const names = [];
  for (let s = 0; s < (room.player_count || 0); s++) if (s !== myIndex) { const n = seatName(room, s); if (n) names.push(n); }
  return names.length ? names.join(', ') : null;
}
function buildLobbyCard({ room, myIndex, state }) {
  const card = document.createElement('button');
  card.className = 'lobby-game';
  const timeTag = `<span class="lobby-size">${esc(TIME_SHORT[room?.players?.[0]?.time || 'unlimited'] || 'Rummikub')}</span>`;
  const challengedMe = room.invited_user_id === app.userId && room.player_count < room.max_players && userSeat(room, app.userId) === -1;
  const others = othersLabel(room, myIndex);
  let status, mine = false, label;
  if (challengedMe) { label = `${seatName(room, 0)} invited you`; status = 'Tap to accept'; mine = true; }
  else if (!others) { label = 'New game'; status = `Waiting for players — share code ${room.code}`; }
  else if (!state || !state.started) { label = `with ${others}`; status = 'Ready to start'; mine = myIndex === 0; }
  else if (state.gameOver) { label = `with ${others}`; status = state.winner === myIndex ? 'Finished — you won 🎉' : 'Finished'; }
  else if (state.turn === myIndex) { label = `with ${others}`; status = 'Your turn'; mine = true; }
  else { const t = seatName(room, state.turn); label = `with ${others}`; status = `${t || 'Someone'}'s turn`; }
  card.classList.toggle('your-turn', mine);
  card.innerHTML = `<span class="lobby-opp">${esc(label)}</span><span class="lobby-status">${esc(status)}</span>${timeTag}`;
  card.addEventListener('click', () => (challengedMe ? acceptInvite(room) : openRoomFromLobby(room, myIndex)));
  card.appendChild(makeDismissControl({ userId: app.userId, code: room.code, card, onRemoved: () => { if (!$('lobby-list').children.length) renderLobby(); } }));
  return card;
}
async function acceptInvite(room) { try { const { room: u, playerIndex } = await joinRoom(room.code, app.name, app.userId); await enterRoom(room.code, playerIndex, app.name, u); } catch (e) { lobbyError(`Could not accept the invite (${e.message}).`); } }
async function openRoomFromLobby(room, myIndex) { try { await enterRoom(room.code, myIndex, app.name, room); } catch (e) { lobbyError(`Could not open that game (${e.message}).`); } }

function challengeFriend(friend) { openSetup(app.name, app.userId, lobbyError, friend); }
async function createChallengeWithTime(friend, timeKey) {
  try {
    app.timeKey = timeKey;
    let room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name || 'Friend' }, MAX_PLAYERS);
    room = await stampTime(room, timeKey);
    triggerPush({ user_id: friend.id, title: 'Rummikub — you have been invited', body: `${app.name} invited you to a game.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { showScreen('lobby'); lobbyError(`Could not start the game (${e.message}).`); }
}

// ---- Entering / leaving -----------------------------------------------------

async function enterRoom(code, playerIndex, name, room) {
  // The room is the authority on who occupies this seat. A stored session can
  // carry a stale name (or one from a different identity), and showing that
  // instead would label you as someone else.
  app.code = code; app.playerIndex = playerIndex; app.name = seatName(room, playerIndex) || name; app.room = room;
  app.rematching = false; app.work = null; app.held = null; app.present = new Set(); app.lastDrawn = null; app.drag = null;
  const rb = $('btn-rematch'); if (rb) rb.disabled = false;
  saveSession({ code, playerIndex, name: app.name });

  app.finishPersisted = room.status === 'finished';
  app.state = newGameState(room.seed);
  const moves = await fetchMoves(code);
  app.state = replayMoves(room.seed, moves);
  if (room.status === 'finished' && room.result && !app.state.gameOver) applyStoredResult(app.state, room.result);
  app.timeKey = roomTimeKey(room);
  app.turnAnchorMs = room.last_move_at ? Date.parse(room.last_move_at) : Date.now();
  app.flagClaimed = false;

  if (app.conn) { try { app.conn.close(); } catch { /* stale room */ } }
  app.conn = new RoomConnection(code, playerIndex, name, {
    onMove: handleIncomingMove, onPresence: handlePresence,
    onMode: (mode) => { app.connMode = mode; renderPlayers(); }, onRoomUpdate: handleRoomUpdate,
  });
  app.conn.setNextIndex(app.state.moveCount); app.conn.connect(); app.connMode = 'db';

  stopLobbyPolling(); showScreen('game'); ensureListeners();
  $('room-code-text').textContent = code;
  renderNotifyBtns(); refreshPushSub(); renderAll(); announceLastMove(); startClockTicker();
}

// ---- Notifications ----------------------------------------------------------

function onNotifyPermissionResolved() { renderNotifyBtns(); if (notifyEnabled()) refreshPushSub(); }
function renderNotifyBtns() {
  const item = $('menu-notify'); if (!item) return;
  if (!notificationsSupported()) { item.classList.add('hidden'); return; }
  item.classList.remove('hidden');
  const on = notifyEnabled();
  item.classList.toggle('on', on);
  const label = $('menu-notify-label');
  if (label) label.textContent = notificationPermission() === 'denied' ? 'Turn alerts: blocked' : (on ? 'Turn alerts: on' : 'Turn alerts: off');
}
async function onToggleNotify() {
  if (!notificationsSupported()) return;
  const perm = notificationPermission();
  if (perm === 'default') { const res = await requestNotifications(); if (res === 'granted') { setMuted(false); setStatus("You'll be notified when it's your turn."); } else setStatus('Notifications were not enabled.'); }
  else if (perm === 'denied') setStatus('Notifications are blocked — enable them in your browser settings.');
  else { setMuted(!isMuted()); setStatus(isMuted() ? 'Turn notifications muted.' : "You'll be notified when it's your turn."); }
  renderNotifyBtns();
  if (notifyEnabled()) refreshPushSub(); else if (!app.userId) unsubscribeFromPush().catch(() => {});
}
(function injectNotifyMenuItem() {
  const menu = $('app-menu'); if (!menu || $('menu-notify')) return;
  const item = document.createElement('button'); item.className = 'menu-item'; item.id = 'menu-notify'; item.title = 'Turn notifications';
  item.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 6.8a3.8 3.8 0 0 1 7.6 0c0 3 1.3 3.8 1.6 4.4H2.6c.3-.6 1.6-1.4 1.6-4.4Z"/><path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0"/></svg><span id="menu-notify-label">Turn alerts</span>`;
  const anchor = menu.querySelector('.theme-picker-section') || menu.querySelector('a.menu-sep');
  menu.insertBefore(item, anchor || null);
  item.addEventListener('click', (e) => { e.stopPropagation(); onToggleNotify(); });
  // A "How to play" item alongside it.
  if (!$('menu-help')) {
    const help = document.createElement('button'); help.className = 'menu-item'; help.id = 'menu-help';
    help.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M6.3 6.2a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.8.6-.8 1.1v.3"/><circle cx="8" cy="11.4" r="0.5" fill="currentColor"/></svg><span>How to play</span>';
    menu.insertBefore(help, anchor || null);
    help.addEventListener('click', (e) => { e.stopPropagation(); $('help-modal').classList.remove('hidden'); });
  }
})();
$('help-close')?.addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-modal')?.addEventListener('click', (e) => { if (e.target.id === 'help-modal') $('help-modal').classList.add('hidden'); });

function pushOpponentIfTheirTurn() {
  if (!app.state.started || app.state.gameOver) return;
  const recipient = app.state.turn;
  if (recipient === app.playerIndex) return;
  triggerPush({ room_code: app.code, player: recipient, title: "Rummikub — it's your turn", body: moveSummary(app.state.lastMove), url: location.href.split('#')[0] }).catch(() => {});
}
function moveSummary(lm) {
  if (!lm) return 'Your move!';
  const who = playerName(lm.player);
  if (lm.type === 'play') return `${who} played ${lm.count} tile${lm.count === 1 ? '' : 's'}. Your move!`;
  if (lm.type === 'draw') return `${who} drew a tile. Your move!`;
  if (lm.type === 'pass') return `${who} passed. Your move!`;
  if (lm.type === 'start') return 'The game has started. Your move!';
  return 'Your move!';
}
function maybeNotifyTurn() { if (document.hidden && isMyTurn() && notifyEnabled()) showTurnNotification(moveSummary(app.state.lastMove)); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearTurnNotification(); postRoomVisibility(); });

$('btn-leave').addEventListener('click', async () => {
  clearSession(); clearTurnNotification();
  if (app.code != null && app.playerIndex != null && (app.room?.player_count ?? 0) >= 2 && app.state && !app.state.gameOver) {
    try { const room = await markPlayerLeft(app.code, app.playerIndex); if (room) app.conn?.broadcastRoom(room); } catch { /* ignore */ }
  }
  stopClockTicker();
  if (app.user) { app.conn?.close(); app.conn = null; app.code = null; app.playerIndex = null; app.room = null; app.state = null; app.work = null; app.held = null; app.pendingMoves = new Map(); showScreen('lobby'); renderLobby(); }
  else { try { await unsubscribeFromPush(); } catch { /* ignore */ } location.reload(); }
});
$('room-code-chip').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomShareUrl(app.code)); setStatus('Invite link copied.'); } catch { /* ignore */ } });

$('btn-resign').addEventListener('click', async () => {
  if (!app.state || !app.state.started || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  if (app.state.out?.[app.playerIndex]) return;
  const msg = app.state.numPlayers > 2
    ? "You'll leave the game — the others play on. This can't be undone."
    : "You'll forfeit — your opponent wins and the game ends. This can't be undone.";
  if (!(await confirmDialog({ title: 'Leave this game?', message: msg, confirmText: 'Resign', danger: true }))) return;
  resetWork();
  await submitMove('resign', {});
  if (app.userId) dismissGame(app.userId, app.code);
});

async function tryResume() {
  const urlCode = takeRoomParam();
  if (urlCode) {
    try {
      const { room, playerIndex } = await joinRoom(urlCode, app.name, app.userId);
      await enterRoom(urlCode, playerIndex, seatName(room, playerIndex) || 'Guest', room);
      return true;
    } catch { /* fall through to the stored session */ }
  }
  const raw = readSession(); if (!raw) return false;
  try { const { code, name } = JSON.parse(raw); const { room, playerIndex } = await joinRoom(code, name, app.userId); await enterRoom(code, playerIndex, name, room); return true; }
  catch { clearSession(); return false; }
}

// ---- Incoming events --------------------------------------------------------

function handleIncomingMove(move) {
  if (move.type === 'rematch') { rematch.follow(move.payload?.code); return; }
  if (move.move_index < app.state.moveCount) return;
  app.pendingMoves.set(move.move_index, move);
  let applied = false;
  while (app.pendingMoves.has(app.state.moveCount)) {
    const m = app.pendingMoves.get(app.state.moveCount); app.pendingMoves.delete(m.move_index);
    try { applyMove(app.state, m); applied = true; } catch (e) { console.error('Failed to apply move', m, e); return; }
  }
  if (applied) {
    app.conn.setNextIndex(app.state.moveCount);
    app.work = null; app.held = null;
    app.turnAnchorMs = Date.now(); app.flagClaimed = false;
    renderAll(); announceLastMove(); maybeNotifyTurn(); maybeFinish();
  } else if (move.move_index > app.state.moveCount) app.conn.pollOnce().catch(() => {});
}

const rematch = createRematch({
  state: app, seatKey: 'playerIndex',
  createRoom: async (name, userId) => { let room = await createRoom(name, userId, null, MAX_PLAYERS); room = await stampTime(room, roomTimeKey(app.room)); return room; },
  joinRoom, enterRoom, onError: (msg) => setStatus(msg),
});
$('btn-rematch').addEventListener('click', rematch.start);

async function handlePresence(present) {
  app.present = present;
  renderPlayers();
  // A present seat with no name yet just claimed a seat — refresh the room once.
  let missing = false;
  for (const sid of present) if (!seatName(app.room, +sid)) missing = true;
  if (missing) { try { const r = await fetchRoom(app.code); if (r) { app.room = r; renderAll(); } } catch { /* ignore */ } }
}
function handleRoomUpdate(room) {
  const hadEnough = (app.room?.player_count ?? 0) >= 2;
  app.room = room;
  if (room.status === 'finished' && room.result && app.state && !app.state.gameOver) { applyStoredResult(app.state, room.result); app.finishPersisted = true; renderAll(); return; }
  app.timeKey = roomTimeKey(room);
  if (room.last_move_at) { const t = Date.parse(room.last_move_at); if (!Number.isNaN(t)) app.turnAnchorMs = t; }
  if (!hadEnough && room.player_count >= 2) renderAll(); else { renderPlayers(); renderOverlays(); }
}

function announceLastMove() {
  const lm = app.state.lastMove;
  if (!lm) { setStatus(''); return; }
  const who = lm.player === app.playerIndex ? 'You' : playerName(lm.player);
  if (lm.type === 'play') setStatus(`${who} played ${lm.count} tile${lm.count === 1 ? '' : 's'}.`);
  else if (lm.type === 'draw') setStatus(lm.player === app.playerIndex ? `You drew ${tileName(lm.tile)}.` : `${who} drew a tile.`);
  else if (lm.type === 'pass') setStatus(`${who} passed.`);
  else if (lm.type === 'start') setStatus(`Game on! ${playerName(lm.first)} goes first.`);
  else if (lm.type === 'resign') setStatus(`${who} left the game.`);
  else if (lm.type === 'timeout') setStatus(`${playerName(lm.player)} ran out of time.`);
  if (isMyTurn()) promptForTurn();
}
function promptForTurn() {
  if (!app.state.melded[app.playerIndex]) setStatus(`Your turn — make an opening meld worth ${MELD_MIN}+ from your rack, or draw.`);
  else setStatus('Your turn — build runs and groups, then Play. Or draw a tile.');
}

// ---- Helpers ----------------------------------------------------------------

function playerName(idx) { if (!app.room) return '?'; return seatName(app.room, idx) ?? `Player ${idx + 1}`; }
function isMyTurn() { const s = app.state; return !!(s.started && !s.gameOver && s.turn === app.playerIndex && !s.out?.[app.playerIndex]); }
function setStatus(msg) { $('status-line').textContent = msg; }
function poolLeft() { return app.state?.pool?.length ?? 0; }

// ---- Turn building (tap to pick up a tile, tap a destination to place) -------

function sortRack(rack) {
  const jokers = rack.filter(isJoker);
  const rest = rack.filter((t) => !isJoker(t)).sort((a, b) => (app.sortMode === 'group'
    ? (tileNum(a) - tileNum(b)) || (COLORS.indexOf(tileColor(a)) - COLORS.indexOf(tileColor(b)))
    : (COLORS.indexOf(tileColor(a)) - COLORS.indexOf(tileColor(b))) || (tileNum(a) - tileNum(b))));
  return [...rest, ...jokers];
}
function initWork() {
  app.work = { sets: app.state.table.map((s) => s.slice()), rack: sortRack(app.state.racks[app.playerIndex].slice()) };
  app.held = null;
  app.lastDrawn = null; // a fresh turn — the "just drawn" highlight has served its purpose
}
function syncWork() {
  if (!app.state) return;
  if (isMyTurn()) { if (!app.work) initWork(); }
  else { app.work = null; app.held = null; }
}
function resetWork() { app.work = null; app.held = null; if (isMyTurn()) initWork(); }

const committedTally = () => tally(app.state.table.flat());
const workTally = () => tally(app.work.sets.flat());
// Tiles the working table holds beyond the committed table — i.e. played from rack.
function playedTiles() {
  const c = committedTally(), w = workTally(); const out = [];
  for (const [k, n] of w) { const extra = n - (c.get(k) || 0); for (let i = 0; i < extra; i++) out.push(k); }
  return out;
}
function workSets() { return app.work.sets.map(arrangeSet).filter((s) => s.length); }
function planValid() {
  if (!app.work || app.held) return false;
  const played = playedTiles();
  if (!played.length) return false;
  return validatePlay(app.state, app.playerIndex, workSets(), played).ok;
}
function workChanged() {
  if (!app.work) return false;
  return playedTiles().length > 0 || JSON.stringify(app.work.sets) !== JSON.stringify(app.state.table);
}

function pickFromRack(idx) {
  if (app.held || !app.work) return;
  const tile = app.work.rack[idx]; if (tile == null) return;
  app.work.rack.splice(idx, 1);
  app.held = { tile, returnable: true };
  renderAll();
}
function pickFromTable(setIdx, tileIdx) {
  if (app.held || !app.work) return;
  const set = app.work.sets[setIdx]; if (!set) return;
  const tile = set[tileIdx]; if (tile == null) return;
  set.splice(tileIdx, 1);
  if (!set.length) app.work.sets.splice(setIdx, 1);
  // A table tile can go back to the rack only if the copies still on the table
  // already cover what the committed table needs (i.e. this one came from a rack).
  const returnable = (workTally().get(tile) || 0) >= (committedTally().get(tile) || 0);
  app.held = { tile, returnable };
  renderAll();
}
function dropIntoSet(setIdx) {
  if (!app.held || !app.work) return;
  app.work.sets[setIdx].push(app.held.tile);
  app.work.sets[setIdx] = arrangeSet(app.work.sets[setIdx]);
  app.held = null;
  renderAll();
}
function dropNewSet() {
  if (!app.held || !app.work) return;
  app.work.sets.push([app.held.tile]);
  app.held = null;
  renderAll();
}
function dropToRack() {
  if (!app.held || !app.work) return;
  if (!app.held.returnable) { setStatus('That tile is already on the table — it has to stay there.'); return; }
  app.work.rack.push(app.held.tile);
  app.work.rack = sortRack(app.work.rack);
  app.held = null;
  renderAll();
}

// ---- Drag and drop (pointer-based; the picked tile floats above the finger) --
// A drag reuses the same pick/drop model as tapping: crossing the move
// threshold picks the tile up (into app.held) and floats a ghost above the
// finger; releasing over a set / “New set” / the rack drops it there.

const DRAG_LIFT = (pt) => (pt === 'touch' ? 46 : 6); // px the tile rides above the finger
let suppressClick = false;

function dragSourceAt(e, area) {
  if (!isMyTurn() || !app.work || app.held) return null;
  if (e.pointerType === 'mouse' && e.button !== 0) return null;
  const tileEl = e.target.closest('.rk-tile'); if (!tileEl) return null;
  if (area === 'rack') {
    const i = +tileEl.dataset.idx; const tile = app.work.rack[i];
    return tile == null ? null : { srcType: 'rack', rackIdx: i, tile };
  }
  const setEl = tileEl.closest('.rk-set'); if (!setEl) return null;
  const si = +setEl.dataset.set, ti = +tileEl.dataset.idx; const tile = app.work.sets[si]?.[ti];
  return tile == null ? null : { srcType: 'table', setIdx: si, tileIdx: ti, tile };
}
function onTilePointerDown(e, area) {
  const src = dragSourceAt(e, area); if (!src) return;
  app.drag = { ...src, startX: e.clientX, startY: e.clientY, pt: e.pointerType, pointerId: e.pointerId, active: false, ghost: null };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}
function onDragMove(e) {
  const d = app.drag; if (!d || e.pointerId !== d.pointerId) return;
  if (!d.active) {
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 8) return;
    d.active = true;
    if (d.srcType === 'rack') pickFromRack(d.rackIdx); else pickFromTable(d.setIdx, d.tileIdx);
    if (!app.held) { endDrag(); return; }
    d.ghost = makeGhost(d.tile); document.body.appendChild(d.ghost);
  }
  positionGhost(d.ghost, e.clientX, e.clientY, d.pt);
  highlightDropTarget(e.clientX, e.clientY);
  e.preventDefault();
}
function onDragEnd(e) {
  const d = app.drag; if (!d || e.pointerId !== d.pointerId) return;
  const wasActive = d.active, x = e.clientX, y = e.clientY, pt = d.pt;
  endDrag();
  if (!wasActive) return; // it was a tap → let the click handler pick it up
  const target = dropElAt(x, y, pt);
  if (target && target.classList.contains('rk-newset')) dropNewSet();
  else if (target && target.classList.contains('rk-set')) dropIntoSet(+target.dataset.set);
  else if (target && target.id === 'rack') dropToRack();
  else renderAll();                       // dropped in the void — keep holding it
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 350);
}
function endDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  clearDropHighlight();
  if (app.drag && app.drag.ghost) app.drag.ghost.remove();
  app.drag = null;
}
function makeGhost(tile) {
  const wrap = document.createElement('div'); wrap.innerHTML = tileHtml(tile);
  const el = wrap.firstElementChild; el.classList.add('rk-ghost'); el.removeAttribute('data-idx');
  return el;
}
function positionGhost(g, x, y, pt) { if (g) { g.style.left = `${x}px`; g.style.top = `${y - DRAG_LIFT(pt)}px`; } }
// The drop target under the FLOATING tile (finger − lift), so it lands where seen.
function dropElAt(x, y, pt) {
  const el = document.elementFromPoint(x, y - DRAG_LIFT(pt)); if (!el) return null;
  const ns = el.closest('.rk-newset'); if (ns) return ns;
  const se = el.closest('.rk-set'); if (se) return se;
  const rk = el.closest('#rack'); if (rk && app.held && app.held.returnable) return rk;
  return null;
}
function highlightDropTarget(x, y) { clearDropHighlight(); const t = dropElAt(x, y, app.drag.pt); if (t) t.classList.add('drag-over'); }
function clearDropHighlight() { document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over')); }

let listenersReady = false;
function ensureListeners() {
  if (listenersReady) return; listenersReady = true;
  // Tap to pick up / place (the drag path below suppresses the click it fires).
  $('table-area').addEventListener('click', (e) => {
    if (suppressClick || !isMyTurn() || !app.work) return;
    const tileEl = e.target.closest('.rk-tile');
    const newSet = e.target.closest('.rk-newset');
    const setEl = e.target.closest('.rk-set');
    if (app.held) {
      if (newSet) return dropNewSet();
      if (setEl) return dropIntoSet(+setEl.dataset.set);
      return;
    }
    if (tileEl && setEl) pickFromTable(+setEl.dataset.set, +tileEl.dataset.idx);
  });
  $('rack').addEventListener('click', (e) => {
    if (suppressClick || !isMyTurn() || !app.work) return;
    if (app.held) return dropToRack();
    const tileEl = e.target.closest('.rk-tile');
    if (tileEl) pickFromRack(+tileEl.dataset.idx);
  });
  // Drag to pick up + place in one gesture (tile floats above the finger).
  $('table-area').addEventListener('pointerdown', (e) => onTilePointerDown(e, 'table'));
  $('rack').addEventListener('pointerdown', (e) => onTilePointerDown(e, 'rack'));
  $('held-area').addEventListener('click', () => { /* tapping the held chip does nothing; place it somewhere */ });
  $('btn-play').addEventListener('click', doPlay);
  $('btn-reset').addEventListener('click', () => { resetWork(); renderAll(); promptForTurn(); });
  $('btn-draw').addEventListener('click', doDraw);
  $('btn-sort').addEventListener('click', () => {
    app.sortMode = app.sortMode === 'run' ? 'group' : 'run';
    if (app.work) app.work.rack = sortRack(app.work.rack);
    renderAll();
  });
}

async function doPlay() {
  if (!isMyTurn() || !app.work) return;
  if (app.held) { setStatus('Place the tile you’re holding first.'); return; }
  const sets = workSets(); const played = playedTiles();
  const res = validatePlay(app.state, app.playerIndex, sets, played);
  if (!res.ok) { setStatus(res.error); return; }
  await submitMove('play', { table: sets, played });
}
async function doDraw() {
  if (!isMyTurn()) return;
  if (app.held) { setStatus('Place the tile you’re holding first.'); return; }
  resetWork();
  if (poolLeft() > 0) { app.lastDrawn = app.state.pool[0]; await submitMove('draw', {}); }
  else { app.lastDrawn = null; await submitMove('pass', {}); }
}

async function submitMove(type, payload) {
  const move = { move_index: app.state.moveCount, player: app.playerIndex, type, payload };
  applyMove(app.state, move);
  app.conn.setNextIndex(app.state.moveCount);
  app.turnAnchorMs = Date.now(); app.flagClaimed = false;
  app.work = null; app.held = null;
  renderAll(); announceLastMove();
  try { await app.conn.sendMove(move); pushOpponentIfTheirTurn(); maybeFinish(); }
  catch (e) {
    setStatus(`Could not save your move (${e.message}). Re-syncing…`);
    const moves = await fetchMoves(app.code); app.state = replayMoves(app.room.seed, moves);
    app.conn.setNextIndex(app.state.moveCount); app.work = null; app.held = null; renderAll();
  }
}

async function maybeFinish() {
  if (!app.state?.gameOver || app.finishPersisted) return;
  app.finishPersisted = true;
  const s = app.state;
  // Real Rummikub scoring: the player who ended the round scores the sum of
  // every other active seat's remaining rack value; everyone else scores the
  // NEGATIVE of their own remaining value. `standings` (already computed by
  // the engine's finishOut) is only the ACTIVE seats, so a resigned player
  // simply has no entry. A tie (stalemate, level racks) has no round winner —
  // nobody gets the bonus, everyone just scores -value.
  const rows = s.endDetail?.standings || [];
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const scores = [];
  for (const { seat, value } of rows) scores[seat] = (s.winner !== 'tie' && s.winner === seat) ? (total - value) : -value;
  const result = { winner: s.winner, scores, reason: s.endDetail?.reason ?? null, endDetail: s.endDetail ?? null };
  try { await finishRoom(app.code, result, true); if (app.room) { app.room.status = 'finished'; app.room.result = result; } app.conn?.broadcastRoom(app.room); }
  catch { app.finishPersisted = false; }
}
function applyStoredResult(stateObj, result) {
  stateObj.started = true; stateObj.gameOver = true; stateObj.winner = result.winner;
  stateObj.endDetail = result.endDetail || (result.reason ? { reason: result.reason } : null);
}

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    const players = app.room.player_count;
    await submitMove('start', { players, tpm: TIME_CONTROLS[roomTimeKey(app.room)] || 0 });
    // Lock the table to the players present so nobody can grab a seat mid-game.
    try {
      await updateRoom(app.code, { status: 'playing', max_players: players });
      app.room.status = 'playing'; app.room.max_players = players;
    } catch { await updateRoomStatus(app.code, 'playing').catch(() => {}); }
    app.conn.broadcastRoom(app.room); renderOverlays();
  } finally { $('btn-start').disabled = false; }
});

// ---- Per-move clock (N-player: reuses time-control's data + fmtClock) --------

let clockTimer = null;
function startClockTicker() { stopClockTicker(); clockTimer = setInterval(tickClocks, 1000); tickClocks(); }
function stopClockTicker() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }
function tickClocks() {
  renderPlayers();
  const s = app.state; if (!s?.started || s.gameOver || (app.room?.player_count ?? 0) < 2) return;
  const tpm = s.tpm || 0; if (!tpm) return;
  const mover = s.turn; if (s.out?.[mover]) return;
  const deadline = app.turnAnchorMs + tpm * 1000;
  const threshold = mover === app.playerIndex ? 0 : -2500; // small grace before claiming another seat
  if (!app.flagClaimed && deadline - Date.now() <= threshold) { app.flagClaimed = true; claimTimeout(mover); }
}
async function claimTimeout(flaggedSeat) {
  if (!app.state || app.state.gameOver) return;
  if (flaggedSeat === app.playerIndex) { resetWork(); }
  await submitMove('timeout', { player: flaggedSeat });
  if (app.userId && app.state.gameOver && app.state.winner !== app.playerIndex) dismissGame(app.userId, app.code);
}
function clockFor(seat) {
  const s = app.state;
  const tpm = s.started ? (s.tpm || 0) : (TIME_CONTROLS[roomTimeKey(app.room)] || 0);
  if (!tpm) return { text: '∞', cls: 'clock' };
  const live = s.started && !s.gameOver && (app.room?.player_count ?? 0) >= 2;
  const active = live && s.turn === seat && !s.out?.[seat];
  const secs = active ? Math.max(0, (app.turnAnchorMs + tpm * 1000 - Date.now()) / 1000) : tpm;
  return { text: fmtClock(secs), cls: 'clock' + (active ? ' active' : '') + (active && secs < 20 ? ' low' : '') };
}

// ---- Rendering --------------------------------------------------------------

function renderAll() { syncWork(); renderPlayers(); renderTable(); renderRack(); renderHeld(); renderControls(); renderOverlays(); }

const RACK_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="4" width="12" height="8" rx="1.5"/><path d="M5 4v8M8 4v8M11 4v8"/></svg>';
function renderPlayers() {
  const el = $('players'); if (!el) return;
  const s = app.state; const count = s?.started ? s.numPlayers : (app.room?.player_count ?? 0);
  let html = '';
  for (let seat = 0; seat < count; seat++) {
    const me = seat === app.playerIndex;
    const online = me || app.present.has(String(seat));
    const isTurn = s?.started && !s.gameOver && s.turn === seat && !s.out?.[seat];
    const out = !!s?.out?.[seat];
    const clk = clockFor(seat);
    const dot = `<span class="online-dot ${online ? 'online' : 'offline'}" title="${online ? 'online' : 'offline'}"></span>`;
    let meta;
    if (out) meta = '<span class="rk-p-out-tag">out</span>';
    else if (s?.started) meta = `<span class="rk-p-tiles">${RACK_ICON}${s.racks[seat]?.length ?? 0}</span>`;
    else meta = '';
    // Whose turn is shown by a ▶ marker (+ label), not just the coloured border.
    const turnMark = isTurn ? '<span class="rk-p-turn" aria-label="to play">▶</span>' : '';
    html += `<div class="rk-player${me ? ' is-me' : ''}${isTurn ? ' is-turn' : ''}${out ? ' is-out' : ''}">`
      + turnMark
      + `<span class="rk-p-name">${dot}<span class="nm">${esc(playerName(seat))}${me ? ' (you)' : ''}</span></span>`
      + meta
      + (s?.started && s.tpm ? `<span class="${clk.cls}">${clk.text}</span>` : '')
      + '</div>';
  }
  el.innerHTML = html;
}

// Suit shapes + names are a colour-independent cue (the tile's colour also
// carries meaning, so it must never be the ONLY signal — see CLAUDE.md).
const SUIT_SHAPE = { k: '●', r: '◆', b: '▲', o: '■' };
const SUIT_NAME = { k: 'black', r: 'red', b: 'blue', o: 'orange' };
function tileName(t) { return isJoker(t) ? 'a joker' : `a ${SUIT_NAME[tileColor(t)]} ${tileNum(t)}`; }
function tileHtml(t, attrs = '') {
  if (isJoker(t)) return `<div class="rk-tile c-j" role="img" aria-label="joker" ${attrs}>🃏</div>`;
  const c = tileColor(t), n = tileNum(t);
  return `<div class="rk-tile c-${c}" role="img" aria-label="${n} ${SUIT_NAME[c]}" ${attrs}>`
    + `<span class="rk-suit" aria-hidden="true">${SUIT_SHAPE[c]}</span>${n}</div>`;
}
function renderTable() {
  const el = $('table-area'); if (!el) return;
  const mine = isMyTurn() && app.work;
  const sets = mine ? app.work.sets : app.state.table;
  if (!sets.length && !mine) { el.classList.add('is-empty'); el.innerHTML = '<span class="rk-empty-hint">No tiles on the table yet.</span>'; return; }
  el.classList.remove('is-empty');
  let html = '';
  sets.forEach((set, si) => {
    let cls = 'rk-set', aria = '';
    if (mine) {
      const valid = classifySet(set).valid;
      cls += valid ? ' valid' : ' invalid';
      if (app.held) cls += ' drop-ok';
      aria = ` role="group" aria-label="${valid ? 'valid set' : 'invalid set'}"`;
    }
    html += `<div class="${cls}" data-set="${si}"${aria}>`;
    set.forEach((t, ti) => { html += tileHtml(t, mine ? `data-idx="${ti}"` : 'data-static="1"'); });
    html += '</div>';
  });
  if (mine) html += `<div class="rk-newset${app.held ? ' drop-ok' : ''}">＋ New set</div>`;
  el.innerHTML = html;
}
function renderRack() {
  const el = $('rack'); if (!el) return;
  const mine = isMyTurn() && app.work;
  const rack = mine ? app.work.rack : sortRack((app.state.started ? app.state.racks[app.playerIndex] : []).slice());
  el.classList.toggle('drop-ok', !!(mine && app.held && app.held.returnable));
  let markedDrawn = false;
  el.innerHTML = rack.map((t, i) => {
    let attrs = mine ? `data-idx="${i}"` : 'data-static="1"';
    // Flag the tile just drawn (once) so it's obvious what landed in the rack.
    if (!mine && !markedDrawn && app.lastDrawn && t === app.lastDrawn) { attrs += ' data-drawn="1"'; markedDrawn = true; }
    return tileHtml(t, attrs);
  }).join('');
}
function renderHeld() {
  const el = $('held-area'); if (!el) return;
  if (app.held) { el.classList.remove('hidden'); el.innerHTML = tileHtml(app.held.tile, 'data-static="1"') + '<span class="rk-held-text">Tap a set, “＋ New set”, or your rack to place it.</span>'; }
  else { el.classList.add('hidden'); el.innerHTML = ''; }
}
function renderControls() {
  const s = app.state;
  const live = (app.room?.player_count ?? 0) >= 2 && s.started && !s.gameOver;
  const iAmActive = live && !s.out?.[app.playerIndex];
  $('btn-resign').classList.toggle('hidden', !iAmActive);
  const my = isMyTurn();
  $('btn-play').classList.toggle('hidden', !my);
  $('btn-play').disabled = !planValid();
  $('btn-reset').classList.toggle('hidden', !my);
  $('btn-reset').disabled = !workChanged() && !app.held;
  const draw = $('btn-draw');
  draw.classList.toggle('hidden', !my);
  draw.textContent = poolLeft() > 0 ? 'Draw a tile' : 'Pass';
  draw.disabled = !!app.held;
  const sortBtn = $('btn-sort');
  sortBtn.classList.toggle('hidden', !(s.started && !s.gameOver));
  // Label shows what the next press does (the opposite of the current sort).
  sortBtn.textContent = (app.sortMode === 'run' ? 'Sort by value' : 'Sort by colour') + ' ⇄';
}

function renderOverlays() {
  const startOv = $('start-overlay'), goOv = $('gameover-overlay');
  if (app.state.gameOver) { startOv.classList.add('hidden'); goOv.classList.remove('hidden'); renderGameOver(); return; }
  goOv.classList.add('hidden');
  if (app.state.started) { startOv.classList.add('hidden'); return; }
  startOv.classList.remove('hidden');
  const count = app.room?.player_count ?? 0;
  $('start-time').textContent = TIME_LABELS[roomTimeKey(app.room)] || '';
  const names = [];
  for (let s = 0; s < count; s++) names.push(esc(seatName(app.room, s) || `Player ${s + 1}`));
  $('start-players').innerHTML = names.map((n, i) => `<span class="rk-start-player${i === app.playerIndex ? ' me' : ''}">${n}</span>`).join('');
  $('start-share').classList.toggle('hidden', count >= MAX_PLAYERS);
  $('start-code').textContent = app.code;
  const enough = count >= 2;
  if (app.playerIndex === 0) {
    $('start-title').textContent = enough ? 'Ready when you are' : 'Waiting for players…';
    const btn = $('btn-start'); btn.classList.toggle('hidden', !enough); btn.textContent = `Start Game (${count})`;
    $('start-waiting').classList.add('hidden');
  } else {
    $('start-title').textContent = enough ? 'Waiting for the host to start…' : 'Waiting for players…';
    $('btn-start').classList.add('hidden');
    $('start-waiting').classList.toggle('hidden', !enough);
  }
}
function renderGameOver() {
  const s = app.state, me = app.playerIndex;
  $('gameover-title').textContent = s.winner === 'tie' ? "It's a draw" : (s.winner === me ? 'You win! 🎉' : `${playerName(s.winner)} wins`);
  let detail = 'Game over.';
  const r = s.endDetail?.reason;
  if (r === 'out') detail = `${s.winner === me ? 'You' : playerName(s.winner)} emptied their rack.`;
  else if (r === 'last-standing') detail = 'Everyone else left.';
  else if (r === 'stalemate') detail = 'Pool exhausted — fewest points in hand wins.';
  $('gameover-detail').innerHTML = `<p class="gameover-reason">${esc(detail)}</p>`;
}

// ---- Confirmation dialog ----------------------------------------------------

let confirmResolver = null;
function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  $('rk-confirm-title').textContent = title; $('rk-confirm-message').textContent = message;
  const okBtn = $('rk-confirm-ok'); okBtn.textContent = confirmText; okBtn.classList.toggle('btn-danger', danger); okBtn.classList.toggle('btn-primary', !danger);
  $('modal-confirm').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function settleConfirm(v) { if (!confirmResolver) return; $('modal-confirm').classList.add('hidden'); const r = confirmResolver; confirmResolver = null; r(v); }
$('rk-confirm-ok').addEventListener('click', () => settleConfirm(true));
$('rk-confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('modal-confirm').addEventListener('click', (e) => { if (e.target.id === 'modal-confirm') settleConfirm(false); });

// ---- Boot -------------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  renderNotifyBtns();

  if (!configReady()) {
    landingError('Setup needed: set the API endpoint in shared/api-config.js (see README).');
    $('btn-create').disabled = true; $('btn-join').disabled = true; window.LBBoot?.done(); return;
  }

  app.user = cachedUser(); app.userId = app.user?.id ?? null; if (app.user) app.name = displayName(app.user);
  applyAuthToUI();
  if (app.user && notifyEnabled()) refreshPushSub();

  const resumed = await tryResume();
  if (!resumed && app.user) { showScreen('lobby'); renderLobby(); }
  onAuthChange(handleAuthChange);
  window.LBBoot?.done();
}
boot();
