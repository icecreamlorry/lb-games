import {
  newGameState, applyMove, replayMoves, legalMoves, movesFrom, findMove, applyPath,
  colorOf, material,
} from './engine.js';
import { createBoard } from './board.js';
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
import { TIME_CONTROLS, TIME_LABELS, TIME_SHORT, createMoveTimer } from '../../shared/time-control.js';
import { confirmEnabled, injectConfirmToggle } from '../../shared/move-confirm.js';
import { saveSession, readSession, clearSession } from '../../shared/game-session.js';

const $ = (id) => document.getElementById(id);
const eqp = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
const samePath = (a, b) => a.length === b.length && a.every((p, i) => eqp(p, b[i]));
const isPrefix = (path, pre) => pre.length <= path.length && pre.every((p, i) => eqp(p, path[i]));

const app = {
  user: null, userId: null, name: null, code: null, playerIndex: null,
  room: null, state: null, conn: null,
  path: [],             // squares of the move being built (multi-jump aware)
  targets: [],          // [{to,capture}] legal next squares for the current path
  staged: null,         // { path, board } awaiting Confirm (confirm-moves on)
  confirmMoves: true,
  oppOnline: false, connMode: 'db', pendingMoves: new Map(),
  timeKey: 'unlimited', turnAnchorMs: 0, finishPersisted: false,
};

let goboard = null;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }



// ---- Landing + setup --------------------------------------------------------

function landingError(msg) { $('landing-error').textContent = msg || ''; }
function getName() { const n = $('landing-name-input').value.trim(); if (!n) { landingError('Please enter your name first.'); return null; } setGuestName(n); return n; }

let setupCtx = null;
function openSetup(name, userId, onError, friend = null) {
  setupCtx = { name, userId, onError, friend };
  $('setup-subtitle').textContent = friend
    ? `Choose a per-move time for your challenge to ${friend.display_name || 'your friend'}.`
    : 'How long does each player get per move?';
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
    let room = await createRoom(name, userId);
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
  const myIndex = userSeat(room, app.userId), oppIndex = myIndex === 0 ? 1 : 0, oppName = seatName(room, oppIndex);
  if (room.status === 'finished' && room.result) return { room, myIndex, oppIndex, oppName, state: { started: true, gameOver: true, winner: room.result.winner } };
  let state = null;
  try { state = replayMoves(room.seed, await fetchMoves(room.code)); } catch { /* best effort */ }
  return { room, myIndex, oppIndex, oppName, state };
}
function buildLobbyCard({ room, myIndex, oppIndex, oppName, state }) {
  const card = document.createElement('button');
  card.className = 'lobby-game';
  const timeTag = `<span class="lobby-size">${esc(TIME_SHORT[room?.players?.[0]?.time || 'unlimited'] || 'Draughts')}</span>`;
  const challengedMe = room.invited_user_id === app.userId && room.player_count < room.max_players && userSeat(room, app.userId) === -1;
  let status, mine = false, label;
  if (challengedMe) { label = `${seatName(room, 0)} challenged you`; status = 'Tap to accept'; mine = true; }
  else if (!oppName) { label = room.invited_name ? `Challenge: ${room.invited_name}` : 'New game'; status = room.invited_name ? `Waiting for ${room.invited_name} to accept` : `Waiting for an opponent — share code ${room.code}`; }
  else if (!state || !state.started) { label = `vs ${oppName}`; status = 'Ready to start'; mine = myIndex === 0; }
  else if (state.gameOver) { label = `vs ${oppName}`; status = state.winner === 'tie' ? 'Finished — draw' : (state.winner === myIndex ? 'Finished — you won 🎉' : `Finished — ${oppName} won`); }
  else if (state.turn === myIndex) { label = `vs ${oppName}`; status = 'Your turn'; mine = true; }
  else { label = `vs ${oppName}`; status = `${oppName}'s turn`; }
  if (oppName && seatLeft(room, oppIndex) && !(state && state.gameOver)) label = `vs ${oppName} (offline)`;
  card.classList.toggle('your-turn', mine);
  card.innerHTML = `<span class="lobby-opp">${esc(label)}</span><span class="lobby-status">${esc(status)}</span>${timeTag}`;
  card.addEventListener('click', () => (challengedMe ? acceptInvite(room) : openRoomFromLobby(room, myIndex)));
  card.appendChild(makeDismissControl({ userId: app.userId, code: room.code, card, onRemoved: () => { if (!$('lobby-list').children.length) renderLobby(); } }));
  return card;
}
async function acceptInvite(room) { try { const { room: u, playerIndex } = await joinRoom(room.code, app.name, app.userId); await enterRoom(room.code, playerIndex, app.name, u); } catch (e) { lobbyError(`Could not accept the challenge (${e.message}).`); } }
async function openRoomFromLobby(room, myIndex) { try { await enterRoom(room.code, myIndex, app.name, room); } catch (e) { lobbyError(`Could not open that game (${e.message}).`); } }

function challengeFriend(friend) { openSetup(app.name, app.userId, lobbyError, friend); }
async function createChallengeWithTime(friend, timeKey) {
  try {
    app.timeKey = timeKey;
    let room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name || 'Friend' });
    room = await stampTime(room, timeKey);
    triggerPush({ user_id: friend.id, title: 'Draughts — you have been challenged', body: `${app.name} challenged you to a game.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { showScreen('lobby'); lobbyError(`Could not start the game (${e.message}).`); }
}

// ---- Entering / leaving -----------------------------------------------------

async function enterRoom(code, playerIndex, name, room) {
  // The room is the authority on who occupies this seat. A stored session can
  // carry a stale name (or one from a different identity), and showing that
  // instead would label you as someone else.
  app.code = code; app.playerIndex = playerIndex; app.name = seatName(room, playerIndex) || name; app.room = room;
  app.rematching = false; app.path = []; app.targets = []; app.staged = null;
  const rb = $('btn-rematch'); if (rb) rb.disabled = false;
  saveSession(GAME_SLUG, { code, playerIndex, name: app.name }, app.userId);

  app.finishPersisted = room.status === 'finished';
  app.state = newGameState(room.seed);
  const moves = await fetchMoves(code);
  app.state = replayMoves(room.seed, moves);
  if (room.status === 'finished' && room.result && !app.state.gameOver) applyStoredResult(app.state, room.result);
  app.timeKey = roomTimeKey(room);
  app.turnAnchorMs = room.last_move_at ? Date.parse(room.last_move_at) : Date.now();

  if (app.conn) { try { app.conn.close(); } catch { /* stale room */ } }
  app.conn = new RoomConnection(code, playerIndex, name, {
    onMove: handleIncomingMove, onPresence: handlePresence,
    onMode: (mode) => { app.connMode = mode; renderMyOnline(); }, onRoomUpdate: handleRoomUpdate,
  });
  app.conn.setNextIndex(app.state.moveCount); app.conn.connect(); app.connMode = 'db';

  stopLobbyPolling(); showScreen('game'); ensureBoard();
  $('room-code-text').textContent = code;
  renderNotifyBtns(); refreshPushSub(); renderAll(); announceLastMove(); startClockTicker();
}

function ensureBoard() {
  if (goboard) return;
  goboard = createBoard($('board'), {
    onSquare: onBoardSquare,
    draggable: (r, c) => isMyTurn() && !app.staged && movesFrom(app.state, r, c).length > 0,
    dragTargets: (r, c) => movesFrom(app.state, r, c).map((m) => ({ to: m.path[1], capture: m.captures.length > 0 })),
    onDrop: onBoardDrop,
  });
}

// ---- Notifications ----------------------------------------------------------

function onNotifyPermissionResolved() { renderNotifyBtns(); if (notifyEnabled()) refreshPushSub(); }
function renderNotifyBtns() {
  const item = $('menu-notify'); if (!item) return;
  if (!notificationsSupported()) { item.classList.add('hidden'); return; }
  item.classList.remove('hidden');
  const on = notifyEnabled(); item.classList.toggle('on', on);
  const label = $('menu-notify-label');
  label.textContent = notificationPermission() === 'denied' ? 'Turn alerts: blocked' : (on ? 'Turn alerts: on' : 'Turn alerts: off');
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
})();

function pushOpponentIfTheirTurn() {
  if (!app.state.started || app.state.gameOver) return;
  const recipient = app.state.turn;
  if (recipient === app.playerIndex) return;
  triggerPush({ room_code: app.code, player: recipient, title: "Draughts — it's your turn", body: moveSummary(app.state.lastMove, playerName(app.state.lastMove?.player)), url: location.href.split('#')[0] }).catch(() => {});
}
function moveSummary(lm, mover) {
  if (!lm) return 'Your move!';
  if (lm.type === 'move') { const cap = lm.captured?.length ? ` (captured ${lm.captured.length})` : ''; return `${mover} moved${cap}. Your move!`; }
  if (lm.type === 'start') return 'The game has started. Your move!';
  if (lm.type === 'resign') return `${mover} resigned. You win!`;
  if (lm.type === 'draw-offer') return `${mover} offers a draw.`;
  return 'Your move!';
}
function maybeNotifyTurn() { if (document.hidden && isMyTurn() && notifyEnabled()) showTurnNotification(moveSummary(app.state.lastMove, playerName(1 - app.playerIndex))); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearTurnNotification(); postRoomVisibility(); });

$('btn-leave').addEventListener('click', async () => {
  clearSession(GAME_SLUG); clearTurnNotification();
  if (app.code != null && app.playerIndex != null && (app.room?.player_count ?? 0) >= 2 && app.state && !app.state.gameOver) {
    try { const room = await markPlayerLeft(app.code, app.playerIndex); if (room) app.conn?.broadcastRoom(room); } catch { /* ignore */ }
  }
  stopClockTicker();
  if (app.user) { app.conn?.close(); app.conn = null; app.code = null; app.playerIndex = null; app.room = null; app.state = null; app.path = []; app.pendingMoves = new Map(); showScreen('lobby'); renderLobby(); }
  else { try { await unsubscribeFromPush(); } catch { /* ignore */ } location.reload(); }
});
$('room-code-chip').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomShareUrl(app.code)); setStatus('Invite link copied.'); } catch { /* ignore */ } });

$('btn-resign').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  if (!(await confirmDialog({ title: 'Resign this game?', message: "You'll forfeit — your opponent wins and the game ends. This can't be undone.", confirmText: 'Resign', danger: true }))) return;
  resetPath();
  await submitMove('resign', {});
  triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Draughts — game over', body: `${app.name} resigned — you win!`, url: location.href.split('#')[0] }).catch(() => {});
  if (app.userId) dismissGame(app.userId, app.code);
});

// ---- Draw offers ------------------------------------------------------------

$('btn-draw').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  if (app.state.drawOffer === app.playerIndex) return;
  await submitMove('draw-offer', {});
  triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Draughts — draw offered', body: `${app.name} offers a draw.`, url: location.href.split('#')[0] }).catch(() => {});
  setStatus('Draw offered. Your opponent can accept or decline.');
});
$('btn-draw-accept').addEventListener('click', async () => { if (app.state?.drawOffer == null || app.state.drawOffer === app.playerIndex) return; await submitMove('draw-accept', {}); });
$('btn-draw-decline').addEventListener('click', async () => { if (app.state?.drawOffer == null || app.state.drawOffer === app.playerIndex) return; await submitMove('draw-decline', {}); setStatus('Draw declined.'); });

async function tryResume() {
  // Opened from the home page with ?room=CODE — join that room directly.
  const urlCode = takeRoomParam();
  if (urlCode) {
    try {
      const { room, playerIndex } = await joinRoom(urlCode, app.name, app.userId);
      await enterRoom(urlCode, playerIndex, seatName(room, playerIndex) || 'Guest', room);
      return true;
    } catch { /* fall through to the stored session */ }
  }
  const session = readSession(GAME_SLUG); if (!session) return false;
  try { const { code, name } = typeof session === 'string' ? JSON.parse(session) : session; const { room, playerIndex } = await joinRoom(code, name, app.userId); await enterRoom(code, playerIndex, name, room); return true; }
  catch { clearSession(GAME_SLUG); return false; }
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
    app.path = []; app.targets = []; app.staged = null;
    app.turnAnchorMs = Date.now(); moveTimer?.resetClaim();
    renderAll(); announceLastMove(); maybeNotifyTurn(); maybeFinish();
  } else if (move.move_index > app.state.moveCount) app.conn.pollOnce().catch(() => {});
}

// ---- Running match score (across a rematch chain) --------------------------
// Carried on room.players[seat].matchWins (shared/rooms.js's extra-field
// params on createRoom/joinRoom). Undefined until the 2nd+ game of an actual
// rematch chain, so a fresh one-off room never shows a meaningless "0–0".
function carriedTally(seat) {
  const old = app.room?.players?.[seat];
  const won = app.state.winner === seat;
  return { matchWins: (old?.matchWins || 0) + (won ? 1 : 0) };
}
function matchPreview() {
  if (app.room?.players?.[app.playerIndex]?.matchWins == null) return null;
  return { my: carriedTally(app.playerIndex).matchWins, their: carriedTally(1 - app.playerIndex).matchWins };
}
function renderMatchChip() {
  const chip = $('match-chip'); if (!chip) return;
  const has = app.room?.players?.[app.playerIndex]?.matchWins != null;
  chip.classList.toggle('hidden', !has);
  if (!has) return;
  const my = app.room.players[app.playerIndex].matchWins || 0;
  const their = app.room.players[1 - app.playerIndex]?.matchWins || 0;
  chip.textContent = `Match ${my}–${their}`;
  chip.title = my > their ? 'You lead the match' : my < their ? 'Opponent leads the match' : 'Match tied';
}

const rematch = createRematch({
  state: app, seatKey: 'playerIndex',
  createRoom: async (name, userId) => {
    let room = await createRoom(name, userId, null, 2, carriedTally(app.playerIndex));
    room = await stampTime(room, roomTimeKey(app.room));
    return room;
  },
  joinRoom: async (code, name, userId) => joinRoom(code, name, userId, carriedTally(app.playerIndex)),
  enterRoom, onError: (msg) => setStatus(msg),
});
$('btn-rematch').addEventListener('click', rematch.start);

async function handlePresence(present) {
  app.oppOnline = present.has(String(1 - app.playerIndex));
  renderOppPanel();
  if (app.oppOnline && !seatName(app.room, 1 - app.playerIndex)) { try { app.room = await fetchRoom(app.code); renderAll(); } catch { /* ignore */ } }
}
function handleRoomUpdate(room) {
  const hadSecond = (app.room?.player_count ?? 0) >= 2;
  app.room = room;
  if (room.status === 'finished' && room.result && app.state && !app.state.gameOver) { applyStoredResult(app.state, room.result); app.finishPersisted = true; renderAll(); return; }
  app.timeKey = roomTimeKey(room);
  if (room.last_move_at) { const t = Date.parse(room.last_move_at); if (!Number.isNaN(t)) app.turnAnchorMs = t; }
  if (!hadSecond && room.player_count >= 2) renderAll(); else { if (app.state) renderOppPanel(); renderOverlays(); }
}

function announceLastMove() {
  const lm = app.state.lastMove; if (!lm) { setStatus(''); return; }
  const who = lm.player === app.playerIndex ? 'You' : playerName(lm.player);
  if (lm.type === 'move') {
    const cap = lm.captured?.length ? ` — captured ${lm.captured.length}` : '';
    setStatus(`${who} moved${cap}${lm.crowned ? ' and crowned a king 👑' : ''}.`);
  } else if (lm.type === 'start') setStatus(`Game on! ${playerName(lm.first)} plays first (light pieces).`);
  else if (lm.type === 'resign') setStatus(`${who} resigned — game over.`);
  else if (lm.type === 'timeout') setStatus(`${playerName(lm.player)} ran out of time — game over.`);
  else if (lm.type === 'draw-offer') setStatus(lm.player === app.playerIndex ? 'You offered a draw.' : `${who} offers a draw.`);
  else if (lm.type === 'draw-decline') setStatus('Draw declined.');
  else if (lm.type === 'draw-accept') setStatus('Draw agreed.');
}

// ---- Helpers ----------------------------------------------------------------

function playerName(idx) { if (!app.room) return '?'; return seatName(app.room, idx) ?? 'Opponent'; }
function isMyTurn() { return app.state.started && !app.state.gameOver && app.state.turn === app.playerIndex; }
function myColor() { return colorOf(app.state, app.playerIndex); }
function boardFlipped() { return myColor() === 'b'; }
function setStatus(msg) { $('status-line').textContent = msg; }

// ---- Move building (multi-jump aware) ---------------------------------------

function resetPath() { app.path = []; app.targets = []; }

// Legal next squares given the current partial path.
function nextTargets() {
  const moves = legalMoves(app.state).filter((m) => isPrefix(m.path, app.path));
  const seen = new Set(); const out = [];
  for (const m of moves) {
    if (m.path.length <= app.path.length) continue;
    const nxt = m.path[app.path.length];
    const key = `${nxt[0]},${nxt[1]}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ to: nxt, capture: m.captures.length > 0 });
  }
  return out;
}

function startPath(r, c) {
  app.path = [[r, c]];
  app.targets = nextTargets();
  renderAll();
  setStatus(app.targets.some((t) => t.capture) ? 'Capture — pick where to land.' : 'Pick a square to move to.');
}

function extendPath(r, c) {
  app.path.push([r, c]);
  const exact = legalMoves(app.state).find((m) => samePath(m.path, app.path));
  const longer = legalMoves(app.state).some((m) => isPrefix(m.path, app.path) && m.path.length > app.path.length);
  if (longer) { app.targets = nextTargets(); renderAll(); setStatus('Keep jumping — the chain must be completed.'); return; }
  if (exact) { completeMove(exact.path); return; }
  resetPath(); renderAll();
}

function completeMove(path) {
  if (app.confirmMoves) {
    app.staged = { path, board: applyPath(app.state.board, path).board };
    app.path = []; app.targets = [];
    renderAll();
    setStatus('Confirm your move, or Cancel.');
  } else {
    resetPath();
    submitPath(path);
  }
}

async function submitPath(path) { await submitMove('move', { path }); }

function onBoardSquare(r, c) {
  if (!isMyTurn()) return;
  if (app.staged) {
    if (eqp(app.staged.path[app.staged.path.length - 1], [r, c])) { confirmStaged(); return; }
    cancelStaged();
  }
  if (app.path.length) {
    if (app.targets.some((t) => eqp(t.to, [r, c]))) { extendPath(r, c); return; }
    resetPath(); // tapped off the path
  }
  if (movesFrom(app.state, r, c).length) { startPath(r, c); return; }
  resetPath(); renderAll();
}

// Drag: from a piece to a square = the first step; continuations are tapped.
function onBoardDrop(from, to) {
  if (!isMyTurn() || app.staged) { if (app.staged) cancelStaged(); return; }
  if (!movesFrom(app.state, from[0], from[1]).length) { resetPath(); renderAll(); return; }
  app.path = [[from[0], from[1]]]; app.targets = nextTargets();
  if (to && app.targets.some((t) => eqp(t.to, to))) extendPath(to[0], to[1]);
  else renderAll();
}

$('btn-confirm').addEventListener('click', confirmStaged);
$('btn-cancel').addEventListener('click', () => { cancelStaged(); setStatus(''); });
function confirmStaged() { const s = app.staged; if (!s) return; app.staged = null; submitPath(s.path); }
function cancelStaged() { if (!app.staged) return; app.staged = null; resetPath(); renderAll(); setStatus(''); }

async function submitMove(type, payload) {
  const move = { move_index: app.state.moveCount, player: app.playerIndex, type, payload };
  applyMove(app.state, move);
  app.conn.setNextIndex(app.state.moveCount);
  app.turnAnchorMs = Date.now(); moveTimer?.resetClaim();
  app.staged = null; resetPath();
  renderAll(); announceLastMove();
  try { await app.conn.sendMove(move); pushOpponentIfTheirTurn(); maybeFinish(); }
  catch (e) {
    setStatus(`Could not save your move (${e.message}). Re-syncing…`);
    const moves = await fetchMoves(app.code); app.state = replayMoves(app.room.seed, moves);
    app.conn.setNextIndex(app.state.moveCount); resetPath(); renderAll();
  }
}

async function maybeFinish() {
  if (!app.state?.gameOver || app.finishPersisted) return;
  app.finishPersisted = true;
  const s = app.state;
  // Standard match-point convention (Game History has no richer score for
  // draughts): win 1, loss 0, draw 0.5 each.
  const scores = s.winner === 'tie' ? [0.5, 0.5] : [s.winner === 0 ? 1 : 0, s.winner === 1 ? 1 : 0];
  const result = { winner: s.winner, scores, reason: s.endDetail?.reason ?? null, endDetail: s.endDetail ?? null, whiteSeat: s.whiteSeat };
  try { await finishRoom(app.code, result, true); if (app.room) { app.room.status = 'finished'; app.room.result = result; } app.conn?.broadcastRoom(app.room); }
  catch { app.finishPersisted = false; }
}
function applyStoredResult(stateObj, result) {
  stateObj.started = true; stateObj.gameOver = true; stateObj.winner = result.winner;
  if (result.whiteSeat != null) stateObj.whiteSeat = result.whiteSeat;
  stateObj.endDetail = result.endDetail || (result.reason ? { reason: result.reason } : null);
}

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    await submitMove('start', { tpm: TIME_CONTROLS[roomTimeKey(app.room)] || 0 });
    await updateRoomStatus(app.code, 'playing'); app.room.status = 'playing'; app.conn.broadcastRoom(app.room); renderOverlays();
  } finally { $('btn-start').disabled = false; }
});

// ---- Per-move clock ---------------------------------------------------------

let moveTimer = null;
function ensureTimer() {
  if (moveTimer) return;
  moveTimer = createMoveTimer({
    elMy: $('my-clock'), elOpp: $('opp-clock'), mySeat: () => app.playerIndex,
    context: () => ({
      tpm: app.state?.started ? (app.state.tpm || 0) : (TIME_CONTROLS[roomTimeKey(app.room)] || 0),
      live: !!(app.state?.started && !app.state.gameOver && (app.room?.player_count ?? 0) >= 2),
      turn: app.state?.turn, anchorMs: app.turnAnchorMs,
    }),
    onFlag: (seat) => claimTimeout(seat),
  });
}
function startClockTicker() { ensureTimer(); moveTimer.resetClaim(); moveTimer.start(); }
function stopClockTicker() { moveTimer?.stop(); }

async function claimTimeout(flaggedSeat) {
  if (!app.state || app.state.gameOver) return;
  resetPath(); app.staged = null;
  await submitMove('timeout', { player: flaggedSeat });
  if (flaggedSeat !== app.playerIndex) triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Draughts — game over', body: `You ran out of time — ${app.name} wins.`, url: location.href.split('#')[0] }).catch(() => {});
  if (app.userId && app.state.gameOver && app.state.winner !== app.playerIndex) dismissGame(app.userId, app.code);
}

// ---- Rendering --------------------------------------------------------------

function renderAll() { renderBoard(); renderOppPanel(); renderMyPanel(); renderControls(); renderOverlays(); renderClocks(); renderMatchChip(); }
function renderMyOnline() { const dot = $('my-online'); if (!dot) return; const live = app.connMode === 'live'; dot.className = `online-dot ${live ? 'online' : 'syncing'}`; dot.title = live ? 'Connected — moves arrive instantly' : 'Syncing through the database'; }

function renderBoard() {
  if (!goboard) return;
  const s = app.state;
  goboard.setInteractive(isMyTurn());
  if (app.staged) {
    goboard.render({ board: app.staged.board, flipped: boardFlipped(), lastMove: [app.staged.path[0], app.staged.path[app.staged.path.length - 1]] });
    return;
  }
  // While building a multi-step move, show the partial position so the piece
  // visibly hops and captured pieces disappear.
  const building = app.path.length >= 2 ? applyPath(s.board, app.path).board : s.board;
  const lm = s.lastMove;
  goboard.render({
    board: building, flipped: boardFlipped(),
    lastMove: (!app.path.length && lm && lm.type === 'move') ? [lm.path[0], lm.path[lm.path.length - 1]] : null,
    selected: app.path.length ? app.path[app.path.length - 1] : null,
    targets: app.targets,
  });
}

function sideGlyph(seat) { return `<span class="side-glyph ${colorOf(app.state, seat)}"></span>`; }
function renderMaterial(el, seat) {
  const mat = material(app.state.board);
  const col = colorOf(app.state, seat), foe = col === 'w' ? 'b' : 'w';
  const captured = 12 - (mat[foe].men + mat[foe].kings);
  const kings = mat[col].kings;
  el.innerHTML = app.state.started ? `<span>${captured} captured</span>${kings ? `<span class="adv">${kings}👑</span>` : ''}` : '';
}
function renderOppPanel() {
  const oppIdx = 1 - app.playerIndex, hasOpp = !!seatName(app.room, oppIdx), nameEl = $('opp-name');
  const nm = hasOpp ? `${sideGlyph(oppIdx)}<span class="nm">${esc(playerName(oppIdx))}</span>` : '<span class="nm">Waiting for opponent…</span>';
  nameEl.innerHTML = (hasOpp && seatLeft(app.room, oppIdx) && !app.state.gameOver) ? `${nm} <span class="left-tag">offline</span>` : nm;
  renderMaterial($('opp-material'), oppIdx);
  $('opp-turn').classList.toggle('hidden', !(app.state.started && !app.state.gameOver && app.state.turn === oppIdx));
  const dot = $('opp-online'); dot.className = `online-dot ${app.oppOnline ? 'online' : 'offline'}`; dot.title = app.oppOnline ? 'online' : 'offline';
}
function renderMyPanel() {
  $('my-name').innerHTML = `${sideGlyph(app.playerIndex)}<span class="nm">${esc(app.name)} (you)</span>`;
  renderMaterial($('my-material'), app.playerIndex);
  $('my-turn').classList.toggle('hidden', !isMyTurn());
  renderMyOnline();
}
function renderControls() {
  const canAct = (app.room?.player_count ?? 0) >= 2 && app.state.started && !app.state.gameOver;
  $('btn-resign').classList.toggle('hidden', !canAct);
  const drawBtn = $('btn-draw'); drawBtn.classList.toggle('hidden', !canAct);
  const iOffered = app.state.drawOffer === app.playerIndex; drawBtn.disabled = iOffered; drawBtn.textContent = iOffered ? '½ Offered' : '½ Draw';
  const oppOffered = canAct && app.state.drawOffer != null && app.state.drawOffer !== app.playerIndex;
  const banner = $('draw-banner'); banner.classList.toggle('hidden', !oppOffered);
  if (oppOffered) $('draw-banner-text').textContent = `${playerName(1 - app.playerIndex)} offers a draw.`;
  $('btn-confirm').classList.toggle('hidden', !app.staged);
  $('btn-cancel').classList.toggle('hidden', !(app.staged || app.path.length));
}
function renderClocks() { moveTimer?.refresh(); }

function renderOverlays() {
  const startOv = $('start-overlay'), goOv = $('gameover-overlay');
  if (app.state.gameOver) { startOv.classList.add('hidden'); goOv.classList.remove('hidden'); renderGameOver(); return; }
  goOv.classList.add('hidden');
  if (app.state.started) { startOv.classList.add('hidden'); return; }
  startOv.classList.remove('hidden');
  const haveGuest = !!seatName(app.room, 1);
  $('start-time').textContent = TIME_LABELS[roomTimeKey(app.room)] || '';
  $('start-share').classList.toggle('hidden', haveGuest);
  $('start-code').textContent = app.code;
  if (haveGuest) {
    $('start-title').textContent = 'Both players are here!';
    $('start-versus').textContent = `${seatName(app.room, 0)} vs ${seatName(app.room, 1)}`;
    $('btn-start').classList.toggle('hidden', app.playerIndex !== 0);
    $('start-waiting').classList.toggle('hidden', app.playerIndex === 0);
  } else {
    $('start-title').textContent = app.room?.invited_name ? `Waiting for ${app.room.invited_name} to accept…` : 'Waiting for a second player…';
    $('start-versus').textContent = ''; $('btn-start').classList.add('hidden'); $('start-waiting').classList.add('hidden');
  }
}
const REASON = { 'no-moves': 'No pieces or moves left.', resign: 'by resignation.', timeout: 'on time.', 'no-progress': 'No progress — a draw.', agreement: 'Draw agreed.' };
function renderGameOver() {
  const s = app.state, me = app.playerIndex;
  $('gameover-title').textContent = s.winner === 'tie' ? "It's a draw" : (s.winner === me ? 'You win! 🎉' : `${playerName(s.winner)} wins`);
  const reason = s.endDetail?.reason;
  let detail = REASON[reason] || '';
  if (s.winner !== 'tie' && (reason === 'resign' || reason === 'timeout')) {
    const w = s.winner === me ? 'You' : playerName(s.winner);
    detail = `${w} won ${REASON[reason]}`;
  }
  let html = `<p class="gameover-reason">${esc(detail)}</p>`;
  const mp = matchPreview();
  if (mp) {
    const lead = mp.my > mp.their ? 'you lead' : mp.my < mp.their ? `${playerName(1 - me)} leads` : 'tied';
    html += `<p class="gameover-match">Match: ${mp.my}–${mp.their} · ${esc(lead)}</p>`;
  }
  $('gameover-detail').innerHTML = html;
}

// ---- Confirmation dialog ----------------------------------------------------

let confirmResolver = null;
function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  $('dr-confirm-title').textContent = title; $('dr-confirm-message').textContent = message;
  const okBtn = $('dr-confirm-ok'); okBtn.textContent = confirmText; okBtn.classList.toggle('btn-danger', danger); okBtn.classList.toggle('btn-primary', !danger);
  $('modal-confirm').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function settleConfirm(v) { if (!confirmResolver) return; $('modal-confirm').classList.add('hidden'); const r = confirmResolver; confirmResolver = null; r(v); }
$('dr-confirm-ok').addEventListener('click', () => settleConfirm(true));
$('dr-confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('modal-confirm').addEventListener('click', (e) => { if (e.target.id === 'modal-confirm') settleConfirm(false); });

// ---- Boot -------------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  renderNotifyBtns();

  app.confirmMoves = confirmEnabled(GAME_SLUG, true);
  injectConfirmToggle(GAME_SLUG, true, (on) => { app.confirmMoves = on; if (!on && app.staged) cancelStaged(); });


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
