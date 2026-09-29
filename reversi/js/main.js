import {
  newGameState, applyMove, replayMoves, legalMoves, isLegal,
  colorOf, countDiscs, applyPlacement, flipsFor,
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
import { setGuestName } from '../../shared/guest-name.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';
import { TIME_CONTROLS, TIME_LABELS, TIME_SHORT, createMoveTimer } from '../../shared/time-control.js';
import { confirmEnabled, injectConfirmToggle } from '../../shared/move-confirm.js';
import { saveSession, readSession, clearSession } from '../../shared/game-session.js';

const $ = (id) => document.getElementById(id);

const app = {
  user: null, userId: null, name: null, code: null, playerIndex: null,
  room: null, state: null, conn: null,
  staged: null,          // { r, c, board, flips } awaiting Confirm
  confirmMoves: true,
  oppOnline: false, connMode: 'db', pendingMoves: new Map(),
  timeKey: 'unlimited', turnAnchorMs: 0, finishPersisted: false,
};

let board = null;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Landing + setup --------------------------------------------------------

function landingError(msg) { $('landing-error').textContent = msg || ''; }
function getName() {
  const n = $('landing-name-input').value.trim();
  if (!n) { landingError('Please enter your name first.'); return null; }
  setGuestName(n);
  return n;
}

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
  const timeTag = `<span class="lobby-size">${esc(TIME_SHORT[room?.players?.[0]?.time || 'unlimited'] || 'Reversi')}</span>`;
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
    triggerPush({ user_id: friend.id, title: 'Reversi — you have been challenged', body: `${app.name} challenged you to a game.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { showScreen('lobby'); lobbyError(`Could not start the game (${e.message}).`); }
}

// ---- Entering / leaving -----------------------------------------------------

async function enterRoom(code, playerIndex, name, room) {
  // The room is the authority on who occupies this seat. A stored session can
  // carry a stale name (or one from a different identity), and showing that
  // instead would label you as someone else.
  app.code = code; app.playerIndex = playerIndex; app.room = room;
  app.name = seatName(room, playerIndex) || name;
  app.rematching = false; app.staged = null;
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
  if (board) return;
  board = createBoard($('board'), { onSquare: onBoardSquare });
}

// ---- Notifications ----------------------------------------------------------

function onNotifyPermissionResolved() { renderNotifyBtns(); if (notifyEnabled()) refreshPushSub(); }
function renderNotifyBtns() {
  const item = $('menu-notify'); if (!item) return;
  if (!notificationsSupported()) { item.classList.add('hidden'); return; }
  item.classList.remove('hidden');
  const on = notifyEnabled(); item.classList.toggle('on', on);
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
})();

function pushOpponentIfTheirTurn() {
  if (!app.state.started || app.state.gameOver) return;
  const recipient = app.state.turn;
  if (recipient === app.playerIndex) return;
  triggerPush({ room_code: app.code, player: recipient, title: "Reversi — it's your turn", body: moveSummary(app.state.lastMove, playerName(app.state.lastMove?.player)), url: location.href.split('#')[0] }).catch(() => {});
}
function moveSummary(lm, mover) {
  if (!lm) return 'Your move!';
  if (lm.type === 'move') {
    const flips = lm.flips ? ` (flipped ${lm.flips})` : '';
    return `${mover} played${flips}. Your move!`;
  }
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
  if (app.user) { app.conn?.close(); app.conn = null; app.code = null; app.playerIndex = null; app.room = null; app.state = null; app.pendingMoves = new Map(); showScreen('lobby'); renderLobby(); }
  else { try { await unsubscribeFromPush(); } catch { /* ignore */ } location.reload(); }
});
$('room-code-chip').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomShareUrl(app.code)); setStatus('Invite link copied.'); } catch { /* ignore */ } });

$('btn-resign').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  if (!(await confirmDialog({ title: 'Resign this game?', message: "You'll forfeit — your opponent wins and the game ends. This can't be undone.", confirmText: 'Resign', danger: true }))) return;
  cancelStaged();
  await submitMove('resign', {});
  triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Reversi — game over', body: `${app.name} resigned — you win!`, url: location.href.split('#')[0] }).catch(() => {});
  if (app.userId) dismissGame(app.userId, app.code);
});

// ---- Draw offers ------------------------------------------------------------

$('btn-draw').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  if (app.state.drawOffer === app.playerIndex) return;
  await submitMove('draw-offer', {});
  triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Reversi — draw offered', body: `${app.name} offers a draw.`, url: location.href.split('#')[0] }).catch(() => {});
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
    app.staged = null;
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
    let msg = `${who} played ${SQ(lm.r, lm.c)} — ${lm.flips} flipped.`;
    // A forced pass is the rule most players don't expect; always say it happened.
    if (lm.passed != null) {
      msg += lm.passed === app.playerIndex
        ? ' You have no legal move — your turn is skipped.'
        : ` ${playerName(lm.passed)} has no legal move — skipped.`;
    }
    setStatus(msg);
  } else if (lm.type === 'start') setStatus(`Game on! ${playerName(lm.first)} plays first (dark ●).`);
  else if (lm.type === 'resign') setStatus(`${who} resigned — game over.`);
  else if (lm.type === 'timeout') setStatus(`${playerName(lm.player)} ran out of time — game over.`);
  else if (lm.type === 'draw-offer') setStatus(lm.player === app.playerIndex ? 'You offered a draw.' : `${who} offers a draw.`);
  else if (lm.type === 'draw-decline') setStatus('Draw declined.');
  else if (lm.type === 'draw-accept') setStatus('Draw agreed.');
}

// ---- Helpers ----------------------------------------------------------------

const FILES = 'abcdefgh';
function SQ(r, c) { return `${FILES[c]}${8 - r}`; }
function playerName(idx) { if (!app.room) return '?'; return seatName(app.room, idx) ?? 'Opponent'; }
function isMyTurn() { return app.state.started && !app.state.gameOver && app.state.turn === app.playerIndex; }
function myColor() { return colorOf(app.state, app.playerIndex); }
function boardFlipped() { return myColor() === 'l'; }
function setStatus(msg) { $('status-line').textContent = msg; }

// ---- Move input -------------------------------------------------------------

function onBoardSquare(r, c) {
  if (!isMyTurn()) return;
  if (app.staged) {
    if (app.staged.r === r && app.staged.c === c) { confirmStaged(); return; }
    cancelStaged();
  }
  if (!isLegal(app.state, r, c)) {
    setStatus('That square would not flip anything — pick one of the marked squares.');
    return;
  }
  const colour = myColor();
  const flips = flipsFor(app.state.board, r, c, colour);
  if (app.confirmMoves) {
    app.staged = { r, c, flips, board: applyPlacement(app.state.board, r, c, colour, flips) };
    renderAll();
    setStatus(`${SQ(r, c)} flips ${flips.length}. Confirm your move, or Cancel.`);
  } else {
    submitMove('move', { r, c });
  }
}

$('btn-confirm').addEventListener('click', confirmStaged);
$('btn-cancel').addEventListener('click', () => { cancelStaged(); setStatus(''); });
function confirmStaged() { const s = app.staged; if (!s) return; app.staged = null; submitMove('move', { r: s.r, c: s.c }); }
function cancelStaged() { if (!app.staged) return; app.staged = null; renderAll(); }

async function submitMove(type, payload) {
  const move = { move_index: app.state.moveCount, player: app.playerIndex, type, payload };
  applyMove(app.state, move);
  app.conn.setNextIndex(app.state.moveCount);
  app.turnAnchorMs = Date.now(); moveTimer?.resetClaim();
  app.staged = null;
  renderAll(); announceLastMove();
  try { await app.conn.sendMove(move); pushOpponentIfTheirTurn(); maybeFinish(); }
  catch (e) {
    setStatus(`Could not save your move (${e.message}). Re-syncing…`);
    const moves = await fetchMoves(app.code); app.state = replayMoves(app.room.seed, moves);
    app.conn.setNextIndex(app.state.moveCount); renderAll();
  }
}

async function maybeFinish() {
  if (!app.state?.gameOver || app.finishPersisted) return;
  app.finishPersisted = true;
  const s = app.state;
  // Final disc count by seat — the natural score for Reversi (mirrors Weiqi's
  // territory score), stands regardless of end reason (resign/timeout still
  // leave a real board position).
  const counts = countDiscs(s.board);
  const scores = s.darkSeat === 0 ? [counts.dark, counts.light] : [counts.light, counts.dark];
  const result = { winner: s.winner, scores, reason: s.endDetail?.reason ?? null, endDetail: s.endDetail ?? null, darkSeat: s.darkSeat };
  try { await finishRoom(app.code, result, true); if (app.room) { app.room.status = 'finished'; app.room.result = result; } app.conn?.broadcastRoom(app.room); }
  catch { app.finishPersisted = false; }
}
function applyStoredResult(stateObj, result) {
  stateObj.started = true; stateObj.gameOver = true; stateObj.winner = result.winner;
  if (result.darkSeat != null) stateObj.darkSeat = result.darkSeat;
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
  app.staged = null;
  await submitMove('timeout', { player: flaggedSeat });
  if (flaggedSeat !== app.playerIndex) triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Reversi — game over', body: `You ran out of time — ${app.name} wins.`, url: location.href.split('#')[0] }).catch(() => {});
  if (app.userId && app.state.gameOver && app.state.winner !== app.playerIndex) dismissGame(app.userId, app.code);
}

// ---- Rendering --------------------------------------------------------------

function renderAll() { renderBoard(); renderOppPanel(); renderMyPanel(); renderControls(); renderOverlays(); renderClocks(); renderMatchChip(); }
function renderMyOnline() { const dot = $('my-online'); if (!dot) return; const live = app.connMode === 'live'; dot.className = `online-dot ${live ? 'online' : 'syncing'}`; dot.title = live ? 'Connected — moves arrive instantly' : 'Syncing through the database'; }

function renderBoard() {
  if (!board) return;
  const s = app.state;
  board.setInteractive(isMyTurn());
  if (app.staged) {
    board.render({
      board: app.staged.board, flipped: boardFlipped(), counts: countDiscs(app.staged.board),
      lastMove: [app.staged.r, app.staged.c], flips: app.staged.flips, targets: [],
    });
    return;
  }
  const lm = s.lastMove;
  const targets = isMyTurn()
    ? [...legalMoves(s).keys()].map((k) => k.split(',').map(Number))
    : [];
  board.render({
    board: s.board, flipped: boardFlipped(), counts: countDiscs(s.board),
    lastMove: (lm && lm.type === 'move') ? [lm.r, lm.c] : null,
    targets,
  });
}

// The player↔colour mapping must be stated in words, not implied by the discs
// alone (CLAUDE.md §3) — the glyph is repeated here beside each name.
function sideGlyph(seat) {
  const col = colorOf(app.state, seat);
  return `<span class="side-glyph ${col === 'd' ? 'dark' : 'light'}" aria-hidden="true"></span>`;
}
function sideLabel(seat) { return colorOf(app.state, seat) === 'd' ? 'Dark ●' : 'Light ○'; }
function renderDiscs(el, seat) {
  const counts = countDiscs(app.staged ? app.staged.board : app.state.board);
  const n = colorOf(app.state, seat) === 'd' ? counts.dark : counts.light;
  el.innerHTML = app.state.started ? `<span>${n} disc${n === 1 ? '' : 's'}</span>` : '';
}
function renderOppPanel() {
  const oppIdx = 1 - app.playerIndex, hasOpp = !!seatName(app.room, oppIdx), nameEl = $('opp-name');
  const nm = hasOpp
    ? `${sideGlyph(oppIdx)}<span class="nm">${esc(playerName(oppIdx))} (${sideLabel(oppIdx)})</span>`
    : '<span class="nm">Waiting for opponent…</span>';
  nameEl.innerHTML = (hasOpp && seatLeft(app.room, oppIdx) && !app.state.gameOver) ? `${nm} <span class="left-tag">offline</span>` : nm;
  renderDiscs($('opp-discs'), oppIdx);
  $('opp-turn').classList.toggle('hidden', !(app.state.started && !app.state.gameOver && app.state.turn === oppIdx));
  const dot = $('opp-online'); dot.className = `online-dot ${app.oppOnline ? 'online' : 'offline'}`; dot.title = app.oppOnline ? 'online' : 'offline';
}
function renderMyPanel() {
  $('my-name').innerHTML = `${sideGlyph(app.playerIndex)}<span class="nm">${esc(app.name)} (you, ${sideLabel(app.playerIndex)})</span>`;
  renderDiscs($('my-discs'), app.playerIndex);
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
  $('btn-cancel').classList.toggle('hidden', !app.staged);
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
function renderGameOver() {
  const s = app.state, me = app.playerIndex;
  $('gameover-title').textContent = s.winner === 'tie' ? "It's a draw" : (s.winner === me ? 'You win! 🎉' : `${playerName(s.winner)} wins`);
  const counts = countDiscs(s.board);
  const mine = colorOf(s, me) === 'd' ? counts.dark : counts.light;
  const theirs = colorOf(s, me) === 'd' ? counts.light : counts.dark;
  const reason = s.endDetail?.reason;
  let detail;
  if (reason === 'resign') detail = s.winner === me ? `${playerName(1 - me)} resigned.` : 'You resigned.';
  else if (reason === 'timeout') detail = s.winner === me ? `${playerName(1 - me)} ran out of time.` : 'You ran out of time.';
  else if (reason === 'agreement') detail = 'Draw agreed.';
  else detail = `${mine}–${theirs} on discs.`;
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
  $('rv-confirm-title').textContent = title; $('rv-confirm-message').textContent = message;
  const okBtn = $('rv-confirm-ok'); okBtn.textContent = confirmText; okBtn.classList.toggle('btn-danger', danger); okBtn.classList.toggle('btn-primary', !danger);
  $('modal-confirm').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function settleConfirm(v) { if (!confirmResolver) return; $('modal-confirm').classList.add('hidden'); const r = confirmResolver; confirmResolver = null; r(v); }
$('rv-confirm-ok').addEventListener('click', () => settleConfirm(true));
$('rv-confirm-cancel').addEventListener('click', () => settleConfirm(false));
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
