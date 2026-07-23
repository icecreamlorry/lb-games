import {
  SIZES, SIZE_LABELS, KOMI, newGameState, applyMove, replayMoves, tryPlay, computeScore, colorOf,
} from './engine.js';
import { createBoard } from './board.js';
import { initTutorial, openTutorial } from './tutorial.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMoves, fetchMyRooms, updateRoomStatus,
  finishRoom, RoomConnection, triggerPush, seatName, userSeat, seatLeft, markPlayerLeft, supabase,
} from './net.js';
import { createRematch } from '../../shared/rematch.js';
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

const $ = (id) => document.getElementById(id);

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
  pending: null,        // [r,c] staged this turn but not yet confirmed
  oppOnline: false,
  connMode: 'db',
  pendingMoves: new Map(),
  sizeKey: 'full',      // board size chosen by the host at creation
  finishPersisted: false,
};

let goboard = null;     // the SVG board renderer for the live game

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

const SESSION_KEY = 'weiqi_session';

// ---- Landing screen -----------------------------------------------------

function landingError(msg) { $('landing-error').textContent = msg || ''; }

function getName() {
  const name = $('landing-name-input').value.trim();
  if (!name) { landingError('Please enter your name first.'); return null; }
  setGuestName(name);
  return name;
}

// Board-size / training picker. Opening context is stashed so the modal buttons
// know who is creating and where to report errors.
let setupCtx = null;
function openSetup(name, userId, onError) {
  setupCtx = { name, userId, onError };
  $('modal-setup').classList.remove('hidden');
}
function closeSetup() { $('modal-setup').classList.add('hidden'); setupCtx = null; }

document.querySelectorAll('#setup-sizes .setup-size').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.size;
    const ctx = setupCtx;
    closeSetup();
    if (!ctx) return;
    createAndEnter(ctx.name, ctx.userId, key, ctx.onError);
  });
});
$('setup-training').addEventListener('click', () => {
  closeSetup();
  showScreen('tutorial');
  openTutorial();
});
$('setup-cancel').addEventListener('click', closeSetup);
$('modal-setup').addEventListener('click', (e) => { if (e.target.id === 'modal-setup') closeSetup(); });

// Stamp the chosen board size onto the host's player record so the guest (and
// the lobby) can see it before the game starts, and it survives a reopen.
async function stampSize(room, key) {
  try {
    const players = (room.players || []).map((p, i) => (i === 0 ? { ...p, size: key } : p));
    const { data } = await supabase().from('rooms').update({ players }).eq('code', room.code).select().maybeSingle();
    return data || { ...room, players };
  } catch {
    return { ...room, players: (room.players || []).map((p, i) => (i === 0 ? { ...p, size: key } : p)) };
  }
}

function roomSizeKey(room) {
  return room?.players?.[0]?.size || app.sizeKey || 'full';
}

async function createAndEnter(name, userId, sizeKey, onError) {
  requestNotifications().then(onNotifyPermissionResolved);
  try {
    app.sizeKey = sizeKey;
    let room = await createRoom(name, userId);
    room = await stampSize(room, sizeKey);
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
  return {
    started: true, gameOver: true,
    winner: result.winner,
    scores: Array.isArray(result.scores) ? result.scores : [0, 0],
  };
}

function buildLobbyCard({ room, myIndex, oppIndex, oppName, state }) {
  const card = document.createElement('button');
  card.className = 'lobby-game';
  const sizeKey = room?.players?.[0]?.size || 'full';
  const sizeTag = `<span class="lobby-size">${esc(SIZE_LABELS[sizeKey] || 'Weiqi')}</span>`;

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
    if (state.winner === 'tie') status = 'Finished — tie';
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
    ${sizeTag}
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

async function challengeFriend(friend) {
  try {
    let room = await createRoom(app.name, app.userId, {
      userId: friend.id,
      name: friend.display_name || 'Friend',
    });
    room = await stampSize(room, app.sizeKey);
    triggerPush({
      user_id: friend.id,
      title: 'Weiqi — you have been challenged',
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
  app.name = name;
  app.room = room;
  app.rematching = false;
  app.pending = null;
  const rb = $('btn-rematch'); if (rb) rb.disabled = false;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, playerIndex, name }));

  app.finishPersisted = room.status === 'finished';
  app.state = newGameState(room.seed);
  const moves = await fetchMoves(code);
  app.state = replayMoves(room.seed, moves);
  if (room.status === 'finished' && room.result && !app.state.gameOver) {
    applyStoredResult(app.state, room.result);
  }
  // Size the board even before the game starts, from the host's stamped choice.
  if (!app.state.started) app.state.size = SIZES[roomSizeKey(room)] || app.state.size;

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
  goboard.setSize(app.state.size);
  $('room-code-text').textContent = code;
  renderNotifyBtns();
  refreshPushSub();
  renderAll();
  announceLastMove();
}

function ensureBoard() {
  if (goboard) return;
  goboard = createBoard($('board'), { onPoint: onBoardPoint });
  goboard.onHover((p) => {
    if (!isMyTurn()) { goboard.setHover(null, null); return; }
    if (!p) { goboard.setHover(null, null); return; }
    const [r, c] = p;
    if (app.state.board[r][c] !== null) { goboard.setHover(null, null); return; }
    goboard.setHover(p, app.playerIndex);
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
    title: "Weiqi — it's your turn",
    body: moveSummary(lm, lm ? playerName(lm.player) : 'Your opponent'),
    url: location.href.split('#')[0],
  }).catch(() => {});
}

function moveSummary(lm, mover) {
  if (!lm) return 'Your move!';
  if (lm.type === 'place') {
    const cap = lm.captured?.length ? ` (captured ${lm.captured.length})` : '';
    return `${mover} played a stone${cap}. Your move!`;
  }
  if (lm.type === 'pass') return `${mover} passed. Pass too to end and score, or play on.`;
  if (lm.type === 'start') return 'The game has started. Your move!';
  if (lm.type === 'forfeit') return `${mover} resigned. You win!`;
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
  sessionStorage.removeItem(SESSION_KEY);
  clearTurnNotification();
  if (app.code != null && app.playerIndex != null
      && (app.room?.player_count ?? 0) >= 2 && app.state && !app.state.gameOver) {
    try {
      const room = await markPlayerLeft(app.code, app.playerIndex);
      if (room) app.conn?.broadcastRoom(room);
    } catch { /* best effort */ }
  }
  if (app.user) {
    if (app.conn) app.conn.close();
    app.conn = null;
    app.code = null; app.playerIndex = null; app.room = null; app.state = null;
    app.pending = null; app.pendingMoves = new Map();
    showScreen('lobby');
    renderLobby();
  } else {
    try { await unsubscribeFromPush(); } catch { /* best effort */ }
    location.reload();
  }
});

$('room-code-chip').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(app.code);
    setStatus('Room code copied to clipboard.');
  } catch { /* clipboard unavailable */ }
});

$('btn-resign').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  const ok = await confirmDialog({
    title: 'Resign this game?',
    message: "You'll forfeit — your opponent wins and the game is removed from your games list. This can't be undone.",
    confirmText: 'Resign',
    danger: true,
  });
  if (!ok) return;
  app.pending = null;
  await submitMove('forfeit', {});
  triggerPush({
    room_code: app.code,
    player: 1 - app.playerIndex,
    title: 'Weiqi — game over',
    body: `${app.name} resigned — you win!`,
    url: location.href.split('#')[0],
  }).catch(() => {});
  if (app.userId) dismissGame(app.userId, app.code);
});

async function tryResume() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  try {
    const { code, name } = JSON.parse(raw);
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
    return true;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
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
    app.pending = null;
    if (app.state.started && goboard) goboard.setSize(app.state.size);
    renderAll();
    announceLastMove();
    maybeNotifyTurn();
    maybeFinish();
  } else if (move.move_index > app.state.moveCount) {
    app.conn.pollOnce().catch(() => {});
  }
}

const rematch = createRematch({
  state: app,
  seatKey: 'playerIndex',
  createRoom: async (name, userId) => {
    let room = await createRoom(name, userId);
    room = await stampSize(room, roomSizeKey(app.room));
    return room;
  },
  joinRoom, enterRoom,
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
  if (!app.state.started) app.state.size = SIZES[roomSizeKey(room)] || app.state.size;
  if (!hadSecondPlayer && room.player_count >= 2) renderAll();
  else { if (app.state) renderOppPanel(); renderOverlays(); }
}

function announceLastMove() {
  const lm = app.state.lastMove;
  if (!lm) { setStatus(''); return; }
  const who = lm.player === app.playerIndex ? 'You' : playerName(lm.player);
  if (lm.type === 'place') {
    const cap = lm.captured?.length ? ` — captured ${lm.captured.length} stone${lm.captured.length === 1 ? '' : 's'}` : '';
    setStatus(`${who} played ${coord(lm.r, lm.c)}${cap}.`);
  } else if (lm.type === 'pass') {
    const near = app.state.consecutivePasses >= 1 && !app.state.gameOver;
    setStatus(`${who} passed.${near ? ' Pass again to end and score the game.' : ''}`);
  } else if (lm.type === 'start') {
    setStatus(`Game on! ${playerName(lm.first)} plays Black and goes first.`);
  } else if (lm.type === 'forfeit') {
    setStatus(`${who} resigned — game over.`);
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

function setStatus(msg) { $('status-line').textContent = msg; }

// Human-readable coordinate (A1-style, skipping I as Go boards do).
function coord(r, c) {
  const letters = 'ABCDEFGHJKLMNOPQRST';
  return `${letters[c] || '?'}${app.state.size - r}`;
}

// ---- Local moves -----------------------------------------------------------

async function submitMove(type, payload) {
  const move = { move_index: app.state.moveCount, player: app.playerIndex, type, payload };
  applyMove(app.state, move);
  app.conn.setNextIndex(app.state.moveCount);
  app.pending = null;
  if (app.state.started && goboard) goboard.setSize(app.state.size);
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
    app.pending = null;
    renderAll();
  }
}

async function maybeFinish() {
  if (!app.state?.gameOver || app.finishPersisted) return;
  app.finishPersisted = true;
  const s = app.state;
  const result = {
    scores: s.score ? s.score.final.slice() : [0, 0],
    winner: s.winner,
    reason: s.endDetail?.reason ?? 'passed',
    endDetail: s.endDetail ?? null,
    blackSeat: s.blackSeat,
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
  if (Array.isArray(result.scores)) stateObj.scores = result.scores.slice();
  if (result.blackSeat != null) stateObj.blackSeat = result.blackSeat;
  stateObj.endDetail = result.endDetail || { reason: result.reason || 'passed' };
}

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    const key = roomSizeKey(app.room);
    await submitMove('start', { size: SIZES[key], komi: KOMI });
    await updateRoomStatus(app.code, 'playing');
    app.room.status = 'playing';
    app.conn.broadcastRoom(app.room);
    renderOverlays();
  } finally {
    $('btn-start').disabled = false;
  }
});

// Tap an intersection: stage it (first tap) or confirm it (tap the staged
// point again). Play button also confirms.
function onBoardPoint(r, c) {
  if (!isMyTurn()) return;
  if (app.state.board[r][c] !== null) return;
  const res = tryPlay(app.state.board, app.state.size, r, c, app.playerIndex, app.state.koPoint);
  if (!res.ok) { setStatus(res.error); return; }
  if (app.pending && app.pending[0] === r && app.pending[1] === c) {
    confirmPending();
    return;
  }
  app.pending = [r, c];
  const cap = res.captured.length ? ` — captures ${res.captured.length}` : '';
  setStatus(`Play ${coord(r, c)}${cap}? Tap again or press Play to confirm.`);
  renderBoard();
  renderControls();
}

async function confirmPending() {
  if (!app.pending || !isMyTurn()) return;
  const [r, c] = app.pending;
  const res = tryPlay(app.state.board, app.state.size, r, c, app.playerIndex, app.state.koPoint);
  if (!res.ok) { setStatus(res.error); app.pending = null; renderBoard(); renderControls(); return; }
  app.pending = null;
  await submitMove('place', { r, c });
}

$('btn-play').addEventListener('click', confirmPending);

$('btn-pass').addEventListener('click', async () => {
  if (!isMyTurn()) return;
  const willEnd = app.state.consecutivePasses >= 1;
  const opts = willEnd ? {
    title: 'Pass and end the game?',
    message: 'Your opponent already passed. Passing now ENDS the game and the board is counted. Make sure your groups are settled first. Pass and score?',
    confirmText: 'Pass & score',
    danger: true,
  } : {
    title: 'Pass your turn?',
    message: 'You\'ll give up this move. If your opponent then passes too, the game ends and the board is scored.',
    confirmText: 'Pass',
  };
  if (!(await confirmDialog(opts))) return;
  app.pending = null;
  await submitMove('pass', {});
});

// ---- Rendering --------------------------------------------------------------

function renderAll() {
  renderBoard();
  renderOppPanel();
  renderMyPanel();
  renderControls();
  renderOverlays();
}

function renderMyOnline() {
  const dot = $('my-online');
  if (!dot) return;
  const live = app.connMode === 'live';
  dot.className = `online-dot ${live ? 'online' : 'syncing'}`;
  dot.title = live ? 'Connected — moves arrive instantly' : 'Syncing through the database';
}

function boardAnnotations() {
  const ann = { marks: [], ghosts: [] };
  if (app.pending) ann.ghosts.push({ r: app.pending[0], c: app.pending[1], color: colorOf(app.state, app.playerIndex) });
  if (app.state.koPoint) ann.marks.push({ r: app.state.koPoint[0], c: app.state.koPoint[1], shape: 'square', color: '#e8604c' });
  return ann;
}

function renderBoard() {
  if (!goboard) return;
  goboard.setInteractive(isMyTurn());
  goboard.render({
    board: app.state.board, size: app.state.size,
    blackSeat: app.state.blackSeat, lastMove: app.state.lastMove,
  }, boardAnnotations());
}

function stoneGlyph(seat) {
  const isBlack = seat === app.state.blackSeat;
  return `<span class="stone-glyph ${isBlack ? 'black' : 'white'}"></span>`;
}

function renderOppPanel() {
  const oppIdx = 1 - app.playerIndex;
  const hasOpp = !!seatName(app.room, oppIdx);
  const nameEl = $('opp-name');
  if (hasOpp && seatLeft(app.room, oppIdx) && !app.state.gameOver) {
    nameEl.innerHTML = `${stoneGlyph(oppIdx)}${esc(playerName(oppIdx))} <span class="left-tag">offline</span>`;
  } else {
    nameEl.innerHTML = hasOpp ? `${stoneGlyph(oppIdx)}${esc(playerName(oppIdx))}` : 'Waiting for opponent…';
  }
  $('opp-captures').textContent = app.state.started ? `${app.state.captures[oppIdx]} captured` : '';
  $('opp-turn').classList.toggle('hidden', !(app.state.started && !app.state.gameOver && app.state.turn === oppIdx));
  const dot = $('opp-online');
  dot.className = `online-dot ${app.oppOnline ? 'online' : 'offline'}`;
  dot.title = app.oppOnline ? 'online' : 'offline';
}

function renderMyPanel() {
  const nameEl = $('my-name');
  nameEl.innerHTML = app.state.started
    ? `${stoneGlyph(app.playerIndex)}${esc(app.name)} (you)`
    : `${esc(app.name)} (you)`;
  $('my-captures').textContent = app.state.started ? `${app.state.captures[app.playerIndex]} captured` : '';
  $('my-turn').classList.toggle('hidden', !isMyTurn());
  renderMyOnline();
}

function renderControls() {
  const my = isMyTurn();
  $('btn-pass').disabled = !my;
  $('btn-pass').classList.toggle('btn-pass-warn', my && app.state.consecutivePasses >= 1);
  $('btn-play').disabled = !(my && app.pending);
  $('btn-resign').classList.toggle('hidden', !((app.room?.player_count ?? 0) >= 2 && !app.state.gameOver));
}

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
  const sizeKey = roomSizeKey(app.room);
  $('start-size').textContent = SIZE_LABELS[sizeKey] || '';
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

function renderGameOver() {
  const s = app.state;
  const me = app.playerIndex;
  let title;
  if (s.winner === 'tie') title = "It's a tie!";
  else if (s.winner === me) title = 'You win! 🎉';
  else title = `${playerName(s.winner)} wins!`;
  $('gameover-title').textContent = title;

  let html = '';
  if (s.endDetail?.reason === 'forfeit') {
    html = `<p>${esc(playerName(s.endDetail.resignedPlayer))} resigned.</p>`;
  } else if (s.score) {
    const sc = s.score;
    const bl = sc.blackSeat, wh = sc.whiteSeat;
    const margin = Math.abs(sc.final[0] - sc.final[1]);
    html = `
      <table class="score-table">
        <tr><th></th><th>Black</th><th>White</th></tr>
        <tr><td>Stones</td><td>${sc.stones[bl]}</td><td>${sc.stones[wh]}</td></tr>
        <tr><td>Territory</td><td>${sc.territory[bl]}</td><td>${sc.territory[wh]}</td></tr>
        <tr><td>Komi</td><td>0</td><td>${sc.komi}</td></tr>
        <tr class="score-total"><td>Total</td><td>${sc.final[bl]}</td><td>${sc.final[wh]}</td></tr>
      </table>
      <p class="muted">${s.winner === 'tie' ? 'Dead even.' : `Won by ${margin} point${margin === 1 ? '' : 's'}.`}</p>`;
  } else {
    // Finished result opened without a fresh score breakdown.
    html = `<p class="final-scores">${playerName(0)}: <strong>${s.scores?.[0] ?? 0}</strong><br>${playerName(1)}: <strong>${s.scores?.[1] ?? 0}</strong></p>`;
  }
  $('gameover-detail').innerHTML = html;
}

// ---- Confirmation dialog --------------------------------------------------------

let confirmResolver = null;

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  $('wq-confirm-title').textContent = title;
  $('wq-confirm-message').textContent = message;
  const okBtn = $('wq-confirm-ok');
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

$('wq-confirm-ok').addEventListener('click', () => settleConfirm(true));
$('wq-confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('modal-confirm').addEventListener('click', (e) => { if (e.target.id === 'modal-confirm') settleConfirm(false); });

document.querySelectorAll('.modal-close[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
});

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

  $('landing-name-input').value = getGuestName();
  $('landing-name-input').addEventListener('input', () => setGuestName($('landing-name-input').value));

  if (!configReady()) {
    landingError('Setup needed: paste your Supabase anon key into shared/supabase-config.js (see README).');
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
