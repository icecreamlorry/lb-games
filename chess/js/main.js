import {
  newGameState, applyMove, replayMoves, legalMovesFrom, findLegalMove, isPromotion,
  previewMove, colorOf, sqName,
} from './engine.js';
import { createBoard } from './board.js';
import { initTutorial, openTutorial } from './tutorial.js';
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
const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// ---- App state ----------------------------------------------------------

const app = {
  user: null,
  userId: null,
  name: null,
  code: null,
  playerIndex: null,
  room: null,
  state: null,
  conn: null,
  selected: null,       // [r,c] currently selected piece, or null
  targets: [],          // [{to:[r,c], capture}] legal destinations for the selection
  promoPending: null,   // {from,to} awaiting a promotion choice
  staged: null,         // {from,to,promo,board,san} awaiting Confirm (confirm-moves on)
  confirmMoves: true,   // "confirm moves" preference (burger toggle)
  oppOnline: false,
  connMode: 'db',
  pendingMoves: new Map(),
  timeKey: 'unlimited', // per-move time control chosen by the host
  turnAnchorMs: 0,      // ms epoch when the side-to-move's clock started
  timeoutClaimed: false,
  finishPersisted: false,
};

let goboard = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}



// ---- Landing screen -----------------------------------------------------

function landingError(msg) { $('landing-error').textContent = msg || ''; }

function getName() {
  const name = $('landing-name-input').value.trim();
  if (!name) { landingError('Please enter your name first.'); return null; }
  setGuestName(name);
  return name;
}

// Time-control / training picker. Opening context is stashed so the modal
// buttons know who is creating and where to report errors. When `friend` is set
// the picker is for a friend challenge (Training is hidden).
let setupCtx = null;
function openSetup(name, userId, onError, friend = null) {
  setupCtx = { name, userId, onError, friend };
  $('setup-training').classList.toggle('hidden', !!friend);
  $('setup-subtitle').textContent = friend
    ? `Choose a per-move time for your challenge to ${friend.display_name || 'your friend'}.`
    : 'How long does each player get per move?';
  $('modal-setup').classList.remove('hidden');
}
function closeSetup() { $('modal-setup').classList.add('hidden'); setupCtx = null; }

document.querySelectorAll('#setup-times .setup-time').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.time;
    const ctx = setupCtx;
    closeSetup();
    if (!ctx) return;
    if (ctx.friend) createChallengeWithTime(ctx.friend, key);
    else createAndEnter(ctx.name, ctx.userId, key, ctx.onError);
  });
});
$('setup-training').addEventListener('click', () => {
  closeSetup();
  showScreen('tutorial');
  openTutorial();
});
$('setup-cancel').addEventListener('click', closeSetup);
$('modal-setup').addEventListener('click', (e) => { if (e.target.id === 'modal-setup') closeSetup(); });

// Stamp the chosen time control onto the host's player record so the guest (and
// the lobby) see it before the game starts, and it survives a reopen.
async function stampTime(room, key) {
  try {
    const players = (room.players || []).map((p, i) => (i === 0 ? { ...p, time: key } : p));
    const data = await updateRoom(room.code, { players });
    return data || { ...room, players };
  } catch {
    return { ...room, players: (room.players || []).map((p, i) => (i === 0 ? { ...p, time: key } : p)) };
  }
}

function roomTimeKey(room) {
  return room?.players?.[0]?.time || app.timeKey || 'unlimited';
}

async function createAndEnter(name, userId, timeKey, onError) {
  requestNotifications().then(onNotifyPermissionResolved);
  try {
    app.timeKey = timeKey;
    let room = await createRoom(name, userId);
    room = await stampTime(room, timeKey);
    await enterRoom(room.code, 0, name, room);
  } catch (e) {
    onError(e.message);
  }
}

async function joinAndEnter(code, name, userId, onError) {
  if (code.length < 4) { onError('Enter the room code you were given.'); return; }
  requestNotifications().then(onNotifyPermissionResolved);
  try {
    const { room, playerIndex } = await joinRoom(code, name, userId);
    await enterRoom(code, playerIndex, name, room);
  } catch (e) {
    onError(e.message);
  }
}

$('btn-create').addEventListener('click', () => {
  const name = getName();
  if (!name) return;
  landingError('');
  openSetup(name, null, landingError);
});

$('btn-join').addEventListener('click', () => {
  if (!getName()) return;
  landingError('');
  $('join-box').classList.toggle('hidden');
  $('code-input').focus();
});

function doJoin() {
  const name = getName();
  if (!name) return;
  landingError('');
  joinAndEnter($('code-input').value.trim().toUpperCase(), name, null, landingError);
}
$('btn-join-go').addEventListener('click', doJoin);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

// ---- Screen navigation & accounts --------------------------------------

function showScreen(which) {
  for (const id of ['screen-landing', 'screen-lobby', 'screen-game', 'screen-tutorial']) {
    $(id).classList.toggle('hidden', id !== `screen-${which}`);
  }
  document.body.dataset.screen = which;
  if (which !== 'lobby') stopLobbyPolling();
  postRoomVisibility();
}

async function postRoomVisibility() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const inGame = !$('screen-game').classList.contains('hidden');
    reg.active?.postMessage({
      type: 'room-visible',
      code: inGame ? app.code : null,
      visible: inGame && !document.hidden,
    });
  } catch { /* graceful fallback */ }
}

function pushRoute() {
  if (app.userId) return { userId: app.userId };
  if (app.code !== null && app.playerIndex !== null) return { roomCode: app.code, player: app.playerIndex };
  return null;
}

function refreshPushSub() {
  const route = pushRoute();
  if (route && notifyEnabled()) subscribeToPush(route).catch(() => {});
}

function applyAuthToUI() {
  const user = app.user;
  $('btn-go-lobby')?.classList.toggle('hidden', !user);
  if (user) $('lobby-name').textContent = app.name;
  renderNotifyBtns();
}

function handleAuthChange(user) {
  app.user = user;
  app.userId = user?.id ?? null;
  if (user) app.name = displayName(user);
  applyAuthToUI();
  if (user && notifyEnabled()) refreshPushSub();
  if ($('screen-game').classList.contains('hidden') && $('screen-tutorial').classList.contains('hidden')) {
    if (user) { showScreen('lobby'); renderLobby(); }
    else showScreen('landing');
  }
}

$('btn-go-lobby')?.addEventListener('click', () => { showScreen('lobby'); renderLobby(); });
$('btn-logout-lobby').addEventListener('click', doLogout);

async function doLogout() {
  try { await signOut(); } catch { /* clear local state regardless */ }
}

// ---- Lobby (My Games) ---------------------------------------------------

$('btn-lobby-new').addEventListener('click', () => {
  lobbyError('');
  openSetup(app.name, app.userId, lobbyError);
});

$('btn-lobby-join').addEventListener('click', () => {
  lobbyError('');
  $('lobby-join-box').classList.toggle('hidden');
  $('lobby-code-input').focus();
});

function doLobbyJoin() {
  lobbyError('');
  joinAndEnter($('lobby-code-input').value.trim().toUpperCase(), app.name, app.userId, lobbyError);
}
$('btn-lobby-join-go').addEventListener('click', doLobbyJoin);
$('lobby-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLobbyJoin(); });
$('btn-lobby-refresh').addEventListener('click', () => renderLobby());
$('btn-lobby-challenge').addEventListener('click', () => window.LBAccount?.openProfile());
$('btn-lobby-history').addEventListener('click', () => openHistory({ userId: app.userId, gameSlug: GAME_SLUG }));

function lobbyError(msg) { $('lobby-error').textContent = msg || ''; }

let lobbyPollTimer = null;
function startLobbyPolling() {
  stopLobbyPolling();
  lobbyPollTimer = setInterval(() => {
    if (!$('screen-lobby').classList.contains('hidden') && !document.hidden) renderLobby();
  }, 5000);
}
function stopLobbyPolling() {
  if (lobbyPollTimer) { clearInterval(lobbyPollTimer); lobbyPollTimer = null; }
}

async function renderLobby() {
  if (!app.userId) return;
  startLobbyPolling();
  const list = $('lobby-list');
  let rooms;
  try {
    rooms = await fetchMyRooms(app.userId);
  } catch (e) {
    lobbyError(`Could not load your games (${e.message}).`);
    return;
  }
  rooms = filterDismissed(app.userId, rooms);
  if (!rooms.length) {
    list.innerHTML = '<p class="lobby-empty muted">No games yet. Start one with <strong>New game</strong>, or join a friend\'s with their code.</p>';
    return;
  }
  const summaries = await Promise.all(rooms.map(summarizeRoom));
  list.innerHTML = '';
  for (const s of summaries) list.appendChild(buildLobbyCard(s));
}

async function summarizeRoom(room) {
  const myIndex = userSeat(room, app.userId);
  const oppIndex = myIndex === 0 ? 1 : 0;
  const oppName = seatName(room, oppIndex);
  if (room.status === 'finished' && room.result) {
    return { room, myIndex, oppIndex, oppName, state: stateFromResult(room.result) };
  }
  let state = null;
  try {
    state = replayMoves(room.seed, await fetchMoves(room.code));
  } catch { /* show what we can */ }
  return { room, myIndex, oppIndex, oppName, state };
}

function stateFromResult(result) {
  return { started: true, gameOver: true, winner: result.winner };
}

function buildLobbyCard({ room, myIndex, oppIndex, oppName, state }) {
  const card = document.createElement('button');
  card.className = 'lobby-game';
  const timeKey = room?.players?.[0]?.time || 'unlimited';
  const timeTag = `<span class="lobby-size">${esc(TIME_SHORT[timeKey] || 'Chess')}</span>`;

  const challengedMe = room.invited_user_id === app.userId
    && room.player_count < room.max_players
    && userSeat(room, app.userId) === -1;

  let status, mine = false, label;
  if (challengedMe) {
    label = `${seatName(room, 0)} challenged you`;
    status = 'Tap to accept';
    mine = true;
  } else if (!oppName) {
    label = room.invited_name ? `Challenge: ${room.invited_name}` : 'New game';
    status = room.invited_name
      ? `Waiting for ${room.invited_name} to accept`
      : `Waiting for an opponent — share code ${room.code}`;
  } else if (!state || !state.started) {
    label = `vs ${oppName}`;
    status = 'Ready to start';
    mine = myIndex === 0;
  } else if (state.gameOver) {
    label = `vs ${oppName}`;
    if (state.winner === 'tie') status = 'Finished — draw';
    else status = state.winner === myIndex ? 'Finished — you won 🎉' : `Finished — ${oppName} won`;
  } else if (state.turn === myIndex) {
    label = `vs ${oppName}`;
    status = 'Your turn';
    mine = true;
  } else {
    label = `vs ${oppName}`;
    status = `${oppName}'s turn`;
  }

  if (oppName && seatLeft(room, oppIndex) && !(state && state.gameOver)) {
    label = `vs ${oppName} (offline)`;
  }

  card.classList.toggle('your-turn', mine);
  card.innerHTML = `
    <span class="lobby-opp">${esc(label)}</span>
    <span class="lobby-status">${esc(status)}</span>
    ${timeTag}
  `;
  card.addEventListener('click', () => (
    challengedMe ? acceptInvite(room) : openRoomFromLobby(room, myIndex)
  ));
  card.appendChild(makeDismissControl({
    userId: app.userId, code: room.code, card,
    onRemoved: () => { if (!$('lobby-list').children.length) renderLobby(); },
  }));
  return card;
}

async function acceptInvite(room) {
  try {
    const { room: updated, playerIndex } = await joinRoom(room.code, app.name, app.userId);
    await enterRoom(room.code, playerIndex, app.name, updated);
  } catch (e) {
    lobbyError(`Could not accept the challenge (${e.message}).`);
  }
}

async function openRoomFromLobby(room, myIndex) {
  try {
    await enterRoom(room.code, myIndex, app.name, room);
  } catch (e) {
    lobbyError(`Could not open that game (${e.message}).`);
  }
}

// ---- Challenge a friend -------------------------------------------------

function challengeFriend(friend) {
  openSetup(app.name, app.userId, lobbyError, friend);
}

async function createChallengeWithTime(friend, timeKey) {
  try {
    app.timeKey = timeKey;
    let room = await createRoom(app.name, app.userId, {
      userId: friend.id,
      name: friend.display_name || 'Friend',
    });
    room = await stampTime(room, timeKey);
    triggerPush({
      user_id: friend.id,
      title: 'Chess — you have been challenged',
      body: `${app.name} challenged you to a game.`,
      url: location.href.split('#')[0],
    }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) {
    showScreen('lobby');
    lobbyError(`Could not start the game (${e.message}).`);
  }
}

// ---- Entering / leaving a room ------------------------------------------

async function enterRoom(code, playerIndex, name, room) {
  app.code = code;
  app.playerIndex = playerIndex;
  // The room is the authority on who occupies this seat. A stored session can
  // carry a stale name (or one from a different identity), and showing that
  // instead would label you as someone else.
  app.name = seatName(room, playerIndex) || name;
  app.room = room;
  app.rematching = false;
  app.selected = null;
  app.targets = [];
  app.promoPending = null;
  app.staged = null;
  const rb = $('btn-rematch'); if (rb) rb.disabled = false;
  saveSession(GAME_SLUG, { code, playerIndex, name: app.name }, app.userId);

  app.finishPersisted = room.status === 'finished';
  app.state = newGameState(room.seed);
  const moves = await fetchMoves(code);
  app.state = replayMoves(room.seed, moves);
  if (room.status === 'finished' && room.result && !app.state.gameOver) {
    applyStoredResult(app.state, room.result);
  }
  app.timeKey = roomTimeKey(room);
  // Anchor the current move clock to the last move's server time when we can, so
  // a reload mid-turn shows the right remaining time.
  app.turnAnchorMs = room.last_move_at ? Date.parse(room.last_move_at) : Date.now();

  if (app.conn) { try { app.conn.close(); } catch { /* stale room */ } }
  app.conn = new RoomConnection(code, playerIndex, name, {
    onMove: handleIncomingMove,
    onPresence: handlePresence,
    onMode: (mode) => { app.connMode = mode; renderMyOnline(); },
    onRoomUpdate: handleRoomUpdate,
  });
  app.conn.setNextIndex(app.state.moveCount);
  app.conn.connect();
  app.connMode = 'db';

  stopLobbyPolling();
  showScreen('game');
  ensureBoard();
  $('room-code-text').textContent = code;
  renderNotifyBtns();
  refreshPushSub();
  renderAll();
  announceLastMove();
  startClockTicker();
}

function ensureBoard() {
  if (goboard) return;
  goboard = createBoard($('board'), {
    onSquare: onBoardSquare,
    draggable: (r, c) => isMyTurn() && !!app.state.board[r][c] && app.state.board[r][c][0] === myColor(),
    dragTargets: (r, c) => legalMovesFrom(app.state, r, c).map((m) => ({
      to: m.to, capture: !!app.state.board[m.to[0]][m.to[1]] || m.flag === 'ep',
    })),
    onDrop: onBoardDrop,
  });
}

// ---- Turn notifications --------------------------------------------------

function onNotifyPermissionResolved() {
  renderNotifyBtns();
  if (notifyEnabled()) refreshPushSub();
}

function renderNotifyBtns() {
  const item = $('menu-notify');
  if (!item) return;
  if (!notificationsSupported()) { item.classList.add('hidden'); return; }
  item.classList.remove('hidden');
  const on = notifyEnabled();
  item.classList.toggle('on', on);
  const label = $('menu-notify-label');
  if (notificationPermission() === 'denied') label.textContent = 'Turn alerts: blocked';
  else label.textContent = on ? 'Turn alerts: on' : 'Turn alerts: off';
}

async function onToggleNotify() {
  if (!notificationsSupported()) return;
  const perm = notificationPermission();
  if (perm === 'default') {
    const res = await requestNotifications();
    if (res === 'granted') { setMuted(false); setStatus("You'll be notified when it's your turn."); }
    else setStatus('Notifications were not enabled.');
  } else if (perm === 'denied') {
    setStatus('Notifications are blocked — enable them in your browser settings.');
  } else {
    setMuted(!isMuted());
    setStatus(isMuted() ? 'Turn notifications muted.' : "You'll be notified when it's your turn.");
  }
  renderNotifyBtns();
  if (notifyEnabled()) refreshPushSub();
  else if (!app.userId) unsubscribeFromPush().catch(() => {});
}

(function injectNotifyMenuItem() {
  const menu = $('app-menu');
  if (!menu || $('menu-notify')) return;
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.id = 'menu-notify';
  item.title = 'Turn notifications';
  item.innerHTML = `
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.2 6.8a3.8 3.8 0 0 1 7.6 0c0 3 1.3 3.8 1.6 4.4H2.6c.3-.6 1.6-1.4 1.6-4.4Z"/>
      <path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0"/>
    </svg>
    <span id="menu-notify-label">Turn alerts</span>`;
  const anchor = menu.querySelector('.theme-picker-section') || menu.querySelector('a.menu-sep');
  menu.insertBefore(item, anchor || null);
  item.addEventListener('click', (e) => { e.stopPropagation(); onToggleNotify(); });
})();

function pushOpponentIfTheirTurn() {
  if (!app.state.started || app.state.gameOver) return;
  const recipient = app.state.turn;
  if (recipient === app.playerIndex) return;
  const lm = app.state.lastMove;
  triggerPush({
    room_code: app.code,
    player: recipient,
    title: "Chess — it's your turn",
    body: moveSummary(lm, lm ? playerName(lm.player) : 'Your opponent'),
    url: location.href.split('#')[0],
  }).catch(() => {});
}

function moveSummary(lm, mover) {
  if (!lm) return 'Your move!';
  if (lm.type === 'move') return `${mover} played ${lm.san}. Your move!`;
  if (lm.type === 'start') return 'The game has started. Your move!';
  if (lm.type === 'resign') return `${mover} resigned. You win!`;
  if (lm.type === 'draw-offer') return `${mover} offers a draw.`;
  return 'Your move!';
}

function turnNoticeBody() {
  return moveSummary(app.state.lastMove, playerName(1 - app.playerIndex));
}

function maybeNotifyTurn() {
  if (document.hidden && isMyTurn() && notifyEnabled()) showTurnNotification(turnNoticeBody());
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) clearTurnNotification();
  postRoomVisibility();
});

$('btn-leave').addEventListener('click', async () => {
  clearSession(GAME_SLUG);
  clearTurnNotification();
  if (app.code != null && app.playerIndex != null
      && (app.room?.player_count ?? 0) >= 2 && app.state && !app.state.gameOver) {
    try {
      const room = await markPlayerLeft(app.code, app.playerIndex);
      if (room) app.conn?.broadcastRoom(room);
    } catch { /* best effort */ }
  }
  stopClockTicker();
  if (app.user) {
    if (app.conn) app.conn.close();
    app.conn = null;
    app.code = null; app.playerIndex = null; app.room = null; app.state = null;
    app.selected = null; app.targets = []; app.pendingMoves = new Map();
    showScreen('lobby');
    renderLobby();
  } else {
    try { await unsubscribeFromPush(); } catch { /* best effort */ }
    location.reload();
  }
});

$('room-code-chip').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomShareUrl(app.code));
    setStatus('Invite link copied.');
  } catch { /* clipboard unavailable */ }
});

$('btn-resign').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  const ok = await confirmDialog({
    title: 'Resign this game?',
    message: "You'll forfeit — your opponent wins and the game ends. This can't be undone.",
    confirmText: 'Resign',
    danger: true,
  });
  if (!ok) return;
  clearSelection();
  await submitMove('resign', {});
  triggerPush({
    room_code: app.code,
    player: 1 - app.playerIndex,
    title: 'Chess — game over',
    body: `${app.name} resigned — you win!`,
    url: location.href.split('#')[0],
  }).catch(() => {});
  if (app.userId) dismissGame(app.userId, app.code);
});

// ---- Draw offers ---------------------------------------------------------

$('btn-draw').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  if (app.state.drawOffer === app.playerIndex) return; // already offered
  await submitMove('draw-offer', {});
  triggerPush({
    room_code: app.code,
    player: 1 - app.playerIndex,
    title: 'Chess — draw offered',
    body: `${app.name} offers a draw.`,
    url: location.href.split('#')[0],
  }).catch(() => {});
  setStatus('Draw offered. Your opponent can accept or decline.');
});

$('btn-draw-accept').addEventListener('click', async () => {
  if (app.state?.drawOffer == null || app.state.drawOffer === app.playerIndex) return;
  await submitMove('draw-accept', {});
});
$('btn-draw-decline').addEventListener('click', async () => {
  if (app.state?.drawOffer == null || app.state.drawOffer === app.playerIndex) return;
  await submitMove('draw-decline', {});
  setStatus('Draw declined.');
});

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
  const session = readSession(GAME_SLUG);
  if (!session) return false;
  try {
    const { code, name } = typeof session === 'string' ? JSON.parse(session) : session;
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
    return true;
  } catch {
    clearSession(GAME_SLUG);
    return false;
  }
}

// ---- Incoming events -----------------------------------------------------

function handleIncomingMove(move) {
  if (move.type === 'rematch') { rematch.follow(move.payload?.code); return; }
  if (move.move_index < app.state.moveCount) return;
  app.pendingMoves.set(move.move_index, move);
  let applied = false;
  while (app.pendingMoves.has(app.state.moveCount)) {
    const m = app.pendingMoves.get(app.state.moveCount);
    app.pendingMoves.delete(m.move_index);
    try { applyMove(app.state, m); applied = true; }
    catch (e) { console.error('Failed to apply move', m, e); return; }
  }
  if (applied) {
    app.conn.setNextIndex(app.state.moveCount);
    app.selected = null; app.targets = []; app.staged = null;
    app.turnAnchorMs = Date.now();
    moveTimer?.resetClaim();
    renderAll();
    announceLastMove();
    maybeNotifyTurn();
    maybeFinish();
  } else if (move.move_index > app.state.moveCount) {
    app.conn.pollOnce().catch(() => {});
  }
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
  state: app,
  seatKey: 'playerIndex',
  createRoom: async (name, userId) => {
    let room = await createRoom(name, userId, null, 2, carriedTally(app.playerIndex));
    room = await stampTime(room, roomTimeKey(app.room));
    return room;
  },
  joinRoom: async (code, name, userId) => joinRoom(code, name, userId, carriedTally(app.playerIndex)),
  enterRoom,
  onError: (msg) => setStatus(msg),
});
$('btn-rematch').addEventListener('click', rematch.start);

async function handlePresence(present) {
  const oppKey = String(1 - app.playerIndex);
  app.oppOnline = present.has(oppKey);
  renderOppPanel();
  if (app.oppOnline && !seatName(app.room, 1 - app.playerIndex)) {
    try { app.room = await fetchRoom(app.code); renderAll(); }
    catch { /* retry on next event */ }
  }
}

function handleRoomUpdate(room) {
  const hadSecondPlayer = (app.room?.player_count ?? 0) >= 2;
  app.room = room;
  if (room.status === 'finished' && room.result && app.state && !app.state.gameOver) {
    applyStoredResult(app.state, room.result);
    app.finishPersisted = true;
    renderAll();
    return;
  }
  // A fresher server timestamp keeps the move clock honest.
  if (room.last_move_at) {
    const t = Date.parse(room.last_move_at);
    if (!Number.isNaN(t)) app.turnAnchorMs = t;
  }
  if (!hadSecondPlayer && room.player_count >= 2) renderAll();
  else { if (app.state) renderOppPanel(); renderOverlays(); }
}

function announceLastMove() {
  const lm = app.state.lastMove;
  if (!lm) { setStatus(''); return; }
  const who = lm.player === app.playerIndex ? 'You' : playerName(lm.player);
  if (lm.type === 'move') {
    let s = `${who} played ${lm.san}.`;
    if (lm.mate) s = `${who} played ${lm.san} — checkmate!`;
    else if (lm.check) s += ' Check!';
    setStatus(s);
  } else if (lm.type === 'start') {
    setStatus(`Game on! ${playerName(lm.first)} plays White and moves first.`);
  } else if (lm.type === 'resign') {
    setStatus(`${who} resigned — game over.`);
  } else if (lm.type === 'timeout') {
    setStatus(`${playerName(lm.player)} ran out of time.`);
  } else if (lm.type === 'draw-offer') {
    setStatus(lm.player === app.playerIndex ? 'You offered a draw.' : `${who} offers a draw.`);
  } else if (lm.type === 'draw-decline') {
    setStatus('Draw declined.');
  } else if (lm.type === 'draw-accept') {
    setStatus('Draw agreed.');
  }
}

// ---- Helpers --------------------------------------------------------------

function playerName(idx) {
  if (!app.room) return '?';
  return seatName(app.room, idx) ?? 'Opponent';
}

function isMyTurn() {
  return app.state.started && !app.state.gameOver && app.state.turn === app.playerIndex;
}

function myColor() { return colorOf(app.state, app.playerIndex); }
function boardFlipped() { return myColor() === 'b'; }

function setStatus(msg) { $('status-line').textContent = msg; }

function findKing(board, color) {
  const k = color + 'k';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === k) return [r, c];
  return null;
}

// ---- Local moves -----------------------------------------------------------

function clearSelection() { app.selected = null; app.targets = []; }

function onBoardSquare(r, c) {
  if (!isMyTurn()) return;
  // With a move staged, tapping its destination confirms it; anything else
  // cancels the stage and is handled as a fresh interaction.
  if (app.staged) {
    if (app.staged.to[0] === r && app.staged.to[1] === c) { confirmStaged(); return; }
    cancelStaged();
  }
  const piece = app.state.board[r][c];
  const mine = piece && piece[0] === myColor();

  // A selection is live and this square is a legal destination → choose the move.
  if (app.selected) {
    const tgt = app.targets.find((t) => t.to[0] === r && t.to[1] === c);
    if (tgt) {
      const from = app.selected;
      clearSelection();
      chooseMove(from, [r, c]);
      return;
    }
  }
  // Select (or reselect) one of my pieces.
  if (mine) {
    app.selected = [r, c];
    app.targets = legalMovesFrom(app.state, r, c).map((m) => ({
      to: m.to, capture: !!app.state.board[m.to[0]][m.to[1]] || m.flag === 'ep',
    }));
    renderBoard();
    return;
  }
  // Otherwise deselect.
  clearSelection();
  renderBoard();
}

// A piece was dragged from `from` and dropped on `to` (which may be illegal).
// A legal target chooses the move; anything else leaves the piece selected with
// its dots showing, so the player can still tap a destination.
function onBoardDrop(from, to) {
  if (!isMyTurn()) return;
  if (app.staged) cancelStaged();
  const legal = legalMovesFrom(app.state, from[0], from[1]);
  app.selected = from;
  app.targets = legal.map((m) => ({
    to: m.to, capture: !!app.state.board[m.to[0]][m.to[1]] || m.flag === 'ep',
  }));
  if (to && legal.some((m) => m.to[0] === to[0] && m.to[1] === to[1])) {
    clearSelection();
    chooseMove(from, to);
    return;
  }
  renderBoard();
}

// The single funnel for a chosen (from,to): pick a promotion piece if needed,
// then either stage it for confirmation or play it instantly.
function chooseMove(from, to, promo) {
  if (!promo && isPromotion(app.state, from, to)) { openPromo(from, to); return; }
  if (app.confirmMoves) stageMove(from, to, promo);
  else doMove(from, to, promo);
}

function stageMove(from, to, promo) {
  const pv = previewMove(app.state, { from, to, promo });
  if (!pv) { setStatus('That move isn\'t legal.'); return; }
  app.staged = { from, to, promo, board: pv.board, san: pv.san };
  clearSelection();
  renderAll();
  setStatus(`Play ${pv.san}? Press Confirm, or tap ${sqName(to)} again.`);
}
function confirmStaged() {
  const s = app.staged;
  if (!s) return;
  app.staged = null;
  doMove(s.from, s.to, s.promo);
}
function cancelStaged() {
  if (!app.staged) return;
  app.staged = null;
  clearSelection();
  renderAll();
  setStatus('');
}
$('btn-confirm').addEventListener('click', confirmStaged);
$('btn-cancel').addEventListener('click', cancelStaged);

function openPromo(from, to) {
  app.promoPending = { from, to };
  $('promo-overlay').classList.remove('hidden');
}
function closePromo() { app.promoPending = null; $('promo-overlay').classList.add('hidden'); }

document.querySelectorAll('.promo-choice').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!app.promoPending) return;
    const { from, to } = app.promoPending;
    const promo = btn.dataset.promo;
    closePromo();
    clearSelection();
    chooseMove(from, to, promo);
  });
});
$('promo-cancel').addEventListener('click', () => { closePromo(); renderBoard(); });

async function doMove(from, to, promo) {
  const mv = findLegalMove(app.state, from, to, promo);
  if (!mv) { setStatus('That move isn\'t legal.'); return; }
  await submitMove('move', { from, to, ...(promo ? { promo } : {}) });
}

async function submitMove(type, payload) {
  const move = { move_index: app.state.moveCount, player: app.playerIndex, type, payload };
  applyMove(app.state, move);
  app.conn.setNextIndex(app.state.moveCount);
  app.turnAnchorMs = Date.now();
  moveTimer?.resetClaim();
  app.staged = null;
  clearSelection();
  renderAll();
  announceLastMove();
  try {
    await app.conn.sendMove(move);
    pushOpponentIfTheirTurn();
    maybeFinish();
  } catch (e) {
    setStatus(`Could not save your move (${e.message}). Re-syncing…`);
    const moves = await fetchMoves(app.code);
    app.state = replayMoves(app.room.seed, moves);
    app.conn.setNextIndex(app.state.moveCount);
    clearSelection();
    renderAll();
  }
}

async function maybeFinish() {
  if (!app.state?.gameOver || app.finishPersisted) return;
  app.finishPersisted = true;
  const s = app.state;
  const result = {
    winner: s.winner,
    // Standard match-point convention (Game History has no richer score for
    // chess): win 1, loss 0, draw 0.5 each.
    scores: s.winner === 'tie' ? [0.5, 0.5] : [s.winner === 0 ? 1 : 0, s.winner === 1 ? 1 : 0],
    reason: s.endDetail?.reason ?? null,
    endDetail: s.endDetail ?? null,
    whiteSeat: s.whiteSeat,
  };
  try {
    await finishRoom(app.code, result, true);
    if (app.room) { app.room.status = 'finished'; app.room.result = result; }
    app.conn?.broadcastRoom(app.room);
  } catch {
    app.finishPersisted = false;
  }
}

function applyStoredResult(stateObj, result) {
  stateObj.started = true;
  stateObj.gameOver = true;
  stateObj.winner = result.winner;
  if (result.whiteSeat != null) stateObj.whiteSeat = result.whiteSeat;
  stateObj.endDetail = result.endDetail || (result.reason ? { reason: result.reason } : null);
}

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    await submitMove('start', { tpm: TIME_CONTROLS[roomTimeKey(app.room)] || 0 });
    await updateRoomStatus(app.code, 'playing');
    app.room.status = 'playing';
    app.conn.broadcastRoom(app.room);
    renderOverlays();
  } finally {
    $('btn-start').disabled = false;
  }
});

// ---- Per-move clock (shared/time-control.js) -------------------------------

let moveTimer = null;
function ensureTimer() {
  if (moveTimer) return;
  moveTimer = createMoveTimer({
    elMy: $('my-clock'), elOpp: $('opp-clock'),
    mySeat: () => app.playerIndex,
    context: () => ({
      // Before the start move lands, s.tpm is 0 — preview the room's control.
      tpm: app.state?.started ? (app.state.tpm || 0) : (TIME_CONTROLS[roomTimeKey(app.room)] || 0),
      live: !!(app.state?.started && !app.state.gameOver && (app.room?.player_count ?? 0) >= 2),
      turn: app.state?.turn,
      anchorMs: app.turnAnchorMs,
    }),
    onFlag: (seat) => claimTimeout(seat),
  });
}
function startClockTicker() { ensureTimer(); moveTimer.resetClaim(); moveTimer.start(); }
function stopClockTicker() { moveTimer?.stop(); }

async function claimTimeout(flaggedSeat) {
  if (!app.state || app.state.gameOver) return;
  clearSelection();
  app.staged = null;
  await submitMove('timeout', { player: flaggedSeat });
  if (flaggedSeat !== app.playerIndex) {
    triggerPush({
      room_code: app.code,
      player: 1 - app.playerIndex,
      title: 'Chess — game over',
      body: `You ran out of time — ${app.name} wins.`,
      url: location.href.split('#')[0],
    }).catch(() => {});
  }
  if (app.userId && app.state.gameOver && app.state.winner !== app.playerIndex) {
    dismissGame(app.userId, app.code);
  }
}

// ---- Rendering --------------------------------------------------------------

function renderAll() {
  renderBoard();
  renderOppPanel();
  renderMyPanel();
  renderControls();
  renderOverlays();
  renderClocks();
  renderMatchChip();
}

function renderMyOnline() {
  const dot = $('my-online');
  if (!dot) return;
  const live = app.connMode === 'live';
  dot.className = `online-dot ${live ? 'online' : 'syncing'}`;
  dot.title = live ? 'Connected — moves arrive instantly' : 'Syncing through the database';
}

function renderBoard() {
  if (!goboard) return;
  const s = app.state;
  goboard.setInteractive(isMyTurn());
  const lm = s.lastMove;
  // While a move is staged (confirm-moves on), show the resulting position with
  // an amber highlight on the move, so you see exactly what you're confirming.
  if (app.staged) {
    goboard.render({
      board: app.staged.board, flipped: boardFlipped(),
      staged: { from: app.staged.from, to: app.staged.to },
    });
    return;
  }
  goboard.render({
    board: s.board,
    flipped: boardFlipped(),
    lastMove: (lm && lm.type === 'move') ? { from: lm.from, to: lm.to } : null,
    check: (s.started && !s.gameOver && s.check) ? findKing(s.board, s.toMove) : null,
    selected: app.selected,
    targets: app.targets,
  });
}

function sideGlyph(seat) {
  return `<span class="side-glyph ${colorOf(app.state, seat)}"></span>`;
}

// Pieces `seat`'s side has captured (i.e. the opponent's missing pieces), as
// small glyphs, plus a material-advantage badge for whoever is ahead.
function capturedInfo() {
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const live = { w: { ...start }, b: { ...start } };
  for (const c of ['w', 'b']) for (const t of Object.keys(start)) live[c][t] = 0;
  let advW = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = app.state.board[r][c];
      if (!p || p[1] === 'k') continue;
      live[p[0]][p[1]] = (live[p[0]][p[1]] || 0) + 1;
      advW += (p[0] === 'w' ? 1 : -1) * VALUE[p[1]];
    }
  }
  const glyphsTakenBy = (color) => {
    const foe = color === 'w' ? 'b' : 'w';
    let out = '';
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const gone = start[t] - live[foe][t];
      for (let i = 0; i < gone; i++) out += GLYPH[t];
    }
    return out;
  };
  return { glyphsTakenBy, advW };
}

function renderCapturedFor(el, seat) {
  const info = capturedInfo();
  const color = colorOf(app.state, seat);
  const glyphs = app.state.started ? info.glyphsTakenBy(color) : '';
  const adv = color === 'w' ? info.advW : -info.advW;
  el.innerHTML = esc(glyphs) + (adv > 0 ? `<span class="adv">+${adv}</span>` : '');
}

function renderOppPanel() {
  const oppIdx = 1 - app.playerIndex;
  const hasOpp = !!seatName(app.room, oppIdx);
  const nameEl = $('opp-name');
  const nm = hasOpp ? `${sideGlyph(oppIdx)}<span class="nm">${esc(playerName(oppIdx))}</span>` : '<span class="nm">Waiting for opponent…</span>';
  if (hasOpp && seatLeft(app.room, oppIdx) && !app.state.gameOver) {
    nameEl.innerHTML = `${nm} <span class="left-tag">offline</span>`;
  } else {
    nameEl.innerHTML = nm;
  }
  renderCapturedFor($('opp-material'), oppIdx);
  $('opp-turn').classList.toggle('hidden', !(app.state.started && !app.state.gameOver && app.state.turn === oppIdx));
  const dot = $('opp-online');
  dot.className = `online-dot ${app.oppOnline ? 'online' : 'offline'}`;
  dot.title = app.oppOnline ? 'online' : 'offline';
}

function renderMyPanel() {
  const nameEl = $('my-name');
  nameEl.innerHTML = `${sideGlyph(app.playerIndex)}<span class="nm">${esc(app.name)} (you)</span>`;
  renderCapturedFor($('my-material'), app.playerIndex);
  $('my-turn').classList.toggle('hidden', !isMyTurn());
  renderMyOnline();
}

function renderControls() {
  const canAct = (app.room?.player_count ?? 0) >= 2 && app.state.started && !app.state.gameOver;
  $('btn-resign').classList.toggle('hidden', !canAct);
  const drawBtn = $('btn-draw');
  drawBtn.classList.toggle('hidden', !canAct);
  const iOffered = app.state.drawOffer === app.playerIndex;
  drawBtn.disabled = iOffered;
  drawBtn.textContent = iOffered ? '½ Offered' : '½ Draw';

  // Confirm / Cancel appear only while a move is staged.
  $('btn-confirm').classList.toggle('hidden', !app.staged);
  $('btn-cancel').classList.toggle('hidden', !app.staged);

  // Incoming draw offer banner.
  const oppOffered = canAct && app.state.drawOffer != null && app.state.drawOffer !== app.playerIndex;
  const banner = $('draw-banner');
  banner.classList.toggle('hidden', !oppOffered);
  if (oppOffered) $('draw-banner-text').textContent = `${playerName(1 - app.playerIndex)} offers a draw.`;
}

// The shared move timer owns clock rendering; refresh it on demand.
function renderClocks() { moveTimer?.refresh(); }

function renderOverlays() {
  const startOv = $('start-overlay');
  const goOv = $('gameover-overlay');

  if (app.state.gameOver) {
    startOv.classList.add('hidden');
    goOv.classList.remove('hidden');
    renderGameOver();
    return;
  }
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
    $('start-title').textContent = app.room?.invited_name
      ? `Waiting for ${app.room.invited_name} to accept…`
      : 'Waiting for a second player…';
    $('start-versus').textContent = '';
    $('btn-start').classList.add('hidden');
    $('start-waiting').classList.add('hidden');
  }
}

const REASON_TEXT = {
  checkmate: 'Checkmate.',
  resign: 'by resignation.',
  timeout: 'on time.',
  'timeout-insufficient': 'Time out, but too little material to mate — a draw.',
  stalemate: 'Stalemate — no legal move.',
  insufficient: 'Insufficient material to checkmate.',
  fifty: 'Fifty-move rule.',
  repetition: 'Threefold repetition.',
  agreement: 'Draw agreed.',
};

function renderGameOver() {
  const s = app.state;
  const me = app.playerIndex;
  let title;
  if (s.winner === 'tie') title = "It's a draw";
  else if (s.winner === me) title = 'You win! 🎉';
  else title = `${playerName(s.winner)} wins`;
  $('gameover-title').textContent = title;

  const reason = s.endDetail?.reason;
  let detail = REASON_TEXT[reason] || '';
  if (s.winner !== 'tie' && (reason === 'checkmate' || reason === 'resign' || reason === 'timeout')) {
    const winnerName = s.winner === me ? 'You' : playerName(s.winner);
    detail = reason === 'checkmate'
      ? `Checkmate — ${winnerName === 'You' ? 'you' : winnerName} won.`
      : `${winnerName} won ${REASON_TEXT[reason]}`;
  }
  let html = `<p class="gameover-reason">${esc(detail)}</p>`;
  const mp = matchPreview();
  if (mp) {
    const lead = mp.my > mp.their ? 'you lead' : mp.my < mp.their ? `${playerName(1 - me)} leads` : 'tied';
    html += `<p class="gameover-match">Match: ${mp.my}–${mp.their} · ${esc(lead)}</p>`;
  }
  $('gameover-detail').innerHTML = html;
}

// ---- Confirmation dialog --------------------------------------------------------

let confirmResolver = null;

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  $('ch-confirm-title').textContent = title;
  $('ch-confirm-message').textContent = message;
  const okBtn = $('ch-confirm-ok');
  okBtn.textContent = confirmText;
  okBtn.classList.toggle('btn-danger', danger);
  okBtn.classList.toggle('btn-primary', !danger);
  $('modal-confirm').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function settleConfirm(value) {
  if (!confirmResolver) return;
  $('modal-confirm').classList.add('hidden');
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve(value);
}

$('ch-confirm-ok').addEventListener('click', () => settleConfirm(true));
$('ch-confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('modal-confirm').addEventListener('click', (e) => { if (e.target.id === 'modal-confirm') settleConfirm(false); });

// ---- Tutorial exit ---------------------------------------------------------

function exitTutorial() {
  if (app.user) { showScreen('lobby'); renderLobby(); }
  else showScreen('landing');
}

// ---- Boot ------------------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  renderNotifyBtns();
  initTutorial(exitTutorial);

  // "Confirm moves" preference (default on) + its burger-menu toggle.
  app.confirmMoves = confirmEnabled(GAME_SLUG, true);
  injectConfirmToggle(GAME_SLUG, true, (on) => {
    app.confirmMoves = on;
    if (!on && app.staged) cancelStaged();
  });


  if (!configReady()) {
    landingError('Setup needed: set the API endpoint in shared/api-config.js (see README).');
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    window.LBBoot?.done();
    return;
  }

  app.user = cachedUser();
  app.userId = app.user?.id ?? null;
  if (app.user) app.name = displayName(app.user);
  applyAuthToUI();
  if (app.user && notifyEnabled()) refreshPushSub();

  const resumed = await tryResume();
  if (!resumed && app.user) { showScreen('lobby'); renderLobby(); }

  onAuthChange(handleAuthChange);
  window.LBBoot?.done();
}

boot();
