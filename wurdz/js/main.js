import {
  BOARD_SIZE, CENTER, BLANK, TILE_POINTS, RACK_SIZE,
  MAX_SCORELESS_TURNS, MAX_CONSECUTIVE_PASSES,
  premiumAt, newGameState, applyMove, validatePlacement, replayMoves,
} from './engine.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMoves, fetchMyRooms, updateRoomStatus,
  finishRoom, RoomConnection, triggerPush, seatName, userSeat,
} from './net.js';
import { createRematch } from '../../shared/rematch.js';
import { openHistory } from '../../shared/history.js';
import {
  currentUser, onAuthChange, displayName, signOut,
} from '../../shared/auth.js';
import { TWO_LETTER_WORDS } from './words2.js';
import { loadDictionary, checkWords } from './dictionary.js';
import {
  notificationsSupported, notificationPermission, requestNotifications,
  registerServiceWorker, showTurnNotification, clearTurnNotification,
  isEnabled as notifyEnabled, isMuted, setMuted,
  subscribeToPush, unsubscribeFromPush,
} from './notify.js';
import { configReady, GAME_SLUG } from './config.js';
import { getGuestName, setGuestName } from '../../shared/guest-name.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';

const $ = (id) => document.getElementById(id);

// ---- App state ----------------------------------------------------------

const app = {
  user: null,        // Supabase auth user, or null when playing as a guest
  userId: null,
  name: null,
  code: null,
  playerIndex: null, // 0 host, 1 guest
  room: null,
  state: null,       // engine game state
  conn: null,
  pending: [],       // tiles placed this turn but not yet played: {r,c,letter,blank,rackIdx}
  selectedRackIdx: null,
  exchangeMode: false,
  exchangeSel: new Set(),
  oppOnline: false,
  connMode: 'db',          // 'live' (websocket) or 'db' (polling fallback)
  pendingMoves: new Map(), // out-of-order moves waiting for their turn
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

const SESSION_KEY = 'wurdz_session';

// ---- Landing screen -----------------------------------------------------

function landingError(msg) {
  $('landing-error').textContent = msg || '';
}

function getName() {
  const name = $('landing-name-input').value.trim();
  if (!name) {
    landingError('Please enter your name first.');
    return null;
  }
  setGuestName(name); // sync this guest name across every LB Games title
  return name;
}

// Shared create/join used by both the guest landing and the signed-in lobby.
// userId is null for guests, or the account id for signed-in players.
async function createAndEnter(name, userId, onError) {
  requestNotifications().then(onNotifyPermissionResolved); // ask while we have the click gesture
  try {
    const room = await createRoom(name, userId);
    await enterRoom(room.code, 0, name, room);
  } catch (e) {
    onError(e.message);
  }
}

async function joinAndEnter(code, name, userId, onError) {
  if (code.length < 4) {
    onError('Enter the room code you were given.');
    return;
  }
  requestNotifications().then(onNotifyPermissionResolved); // ask while we have the click gesture
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
  createAndEnter(name, null, landingError);
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
  for (const id of ['screen-landing', 'screen-lobby', 'screen-game']) {
    $(id).classList.toggle('hidden', id !== `screen-${which}`);
  }
  document.body.dataset.screen = which;
  if (which !== 'lobby') stopLobbyPolling();
  postRoomVisibility();
}

// Tell the service worker which room (if any) we're currently looking at, so
// a push for a different game isn't suppressed while this one is open.
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
  } catch { /* notifications just fall back to the simpler behaviour */ }
}

// The push routing for the current context: a signed-in account is notified
// across every game, a guest only for the seat they're in.
function pushRoute() {
  if (app.userId) return { userId: app.userId };
  if (app.code !== null && app.playerIndex !== null) return { roomCode: app.code, player: app.playerIndex };
  return null;
}

function refreshPushSub() {
  const route = pushRoute();
  if (route && notifyEnabled()) subscribeToPush(route).catch(() => {});
}

// Reflect the signed-in (or guest) state across the lobby chrome. The shared
// account-ui owns the landing account bar (name line, set-name/login/logout);
// here we only touch the Wurdz-owned bits and the shared "MY GAMES" button.
function applyAuthToUI() {
  const user = app.user;
  $('btn-go-lobby')?.classList.toggle('hidden', !user);
  if (user) $('lobby-name').textContent = app.name;
  $('btn-leave').textContent = user ? '← Games' : 'Leave';
  renderNotifyBtns();
}

function handleAuthChange(user) {
  app.user = user;
  app.userId = user?.id ?? null;
  if (user) app.name = displayName(user);
  applyAuthToUI();
  if (user && notifyEnabled()) refreshPushSub();

  // Only re-route when we're not mid-game, so an in-progress board is safe.
  if ($('screen-game').classList.contains('hidden')) {
    if (user) { showScreen('lobby'); renderLobby(); }
    else showScreen('landing');
  }
}

$('btn-go-lobby')?.addEventListener('click', () => { showScreen('lobby'); renderLobby(); });
$('btn-logout-lobby').addEventListener('click', doLogout);

async function doLogout() {
  try { await signOut(); } catch { /* clear local state regardless */ }
  // handleAuthChange will fire and return us to the landing screen.
}

// ---- Lobby (My Games) ---------------------------------------------------

$('btn-lobby-new').addEventListener('click', () => {
  lobbyError('');
  createAndEnter(app.name, app.userId, lobbyError);
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

function lobbyError(msg) {
  $('lobby-error').textContent = msg || '';
}

// Poll the lobby while it's the visible screen so turn changes show up.
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

  // Replay each room's moves so we can show whose turn it is and the score.
  const summaries = await Promise.all(rooms.map(summarizeRoom));
  list.innerHTML = '';
  for (const s of summaries) list.appendChild(buildLobbyCard(s));
}

async function summarizeRoom(room) {
  const myIndex = userSeat(room, app.userId);
  const oppIndex = myIndex === 0 ? 1 : 0;
  const oppName = seatName(room, oppIndex);
  // Finished games are read straight from the stored result — their move log
  // has been purged, so there's nothing to replay.
  if (room.status === 'finished' && room.result) {
    return { room, myIndex, oppIndex, oppName, state: stateFromResult(room.result) };
  }
  let state = null;
  try {
    state = replayMoves(room.seed, await fetchMoves(room.code));
  } catch { /* show what we can without a replay */ }
  return { room, myIndex, oppIndex, oppName, state };
}

// A minimal "game over" state built from a stored result — enough for the
// lobby card (it reads started / gameOver / winner / scores only).
function stateFromResult(result) {
  return {
    started: true,
    gameOver: true,
    winner: result.winner,
    scores: Array.isArray(result.scores) ? result.scores : [0, 0],
  };
}

function buildLobbyCard({ room, myIndex, oppIndex, oppName, state }) {
  const card = document.createElement('button');
  card.className = 'lobby-game';

  // A challenge addressed to me that I haven't accepted yet.
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
    mine = myIndex === 0; // host starts
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

  const score = state && state.started
    ? `<span class="lobby-score">${state.scores[myIndex]} – ${state.scores[oppIndex]}</span>`
    : '';
  card.classList.toggle('your-turn', mine);
  card.innerHTML = `
    <span class="lobby-opp">${esc(label)}</span>
    <span class="lobby-status">${esc(status)}</span>
    ${score}
  `;
  // Finished games re-open to show their final result; the lobby's History
  // button is the way to browse all past games.
  card.addEventListener('click', () => (
    challengedMe ? acceptInvite(room) : openRoomFromLobby(room, myIndex)
  ));

  // Any game can be cleared from this player's list (the other player keeps
  // their own copy until they remove it too).
  card.appendChild(makeDismissControl({
    userId: app.userId, code: room.code, card,
    onRemoved: () => { if (!$('lobby-list').children.length) renderLobby(); },
  }));
  return card;
}

// Accept a friend's challenge: claim the guest seat, then open the room.
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
// Auth, profile, friends and the hamburger menu are all owned by the shared
// account-ui.js now. Wurdz only supplies the game-specific challenge action,
// fed into the shared profile dialog via LB_CONFIG.onChallengeFriend (boot()).

// Create a room already addressed to this friend, notify them, and enter it.
async function challengeFriend(friend) {
  try {
    const room = await createRoom(app.name, app.userId, {
      userId: friend.id,
      name: friend.display_name || 'Friend',
    });
    triggerPush({
      user_id: friend.id,
      title: 'Wurdz — you have been challenged',
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
  const rb = $('btn-rematch'); if (rb) rb.disabled = false;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, playerIndex, name }));

  app.finishPersisted = room.status === 'finished';
  app.state = newGameState(room.seed);
  const moves = await fetchMoves(code);
  app.state = replayMoves(room.seed, moves);
  // A finished room's moves may have been purged after the result was stored;
  // rebuild the end state from the stored result so we can still show it.
  if (room.status === 'finished' && room.result && !app.state.gameOver) {
    applyStoredResult(app.state, room.result);
  }

  app.conn = new RoomConnection(code, playerIndex, name, {
    onMove: handleIncomingMove,
    onPresence: handlePresence,
    onMode: (mode) => { app.connMode = mode; renderMyOnline(); },
    onRoomUpdate: handleRoomUpdate,
  });
  app.conn.setNextIndex(app.state.moveCount);
  app.conn.connect();
  app.connMode = 'db'; // until the websocket subscribes

  stopLobbyPolling();
  showScreen('game');
  $('room-code-text').textContent = code;
  renderNotifyBtns();
  refreshPushSub();
  renderAll();
  // Show what last happened in THIS room (the status box is otherwise stale
  // from a previous room / game when re-entering).
  announceLastMove();
}

// ---- Turn notifications --------------------------------------------------

// Called once the permission prompt resolves (which may be after we've
// already entered the room): refresh the button and subscribe if able.
function onNotifyPermissionResolved() {
  renderNotifyBtns();
  if (notifyEnabled()) refreshPushSub();
}

// Turn-notification toggle now lives in the hamburger menu (saves header space).
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
  else if (!app.userId) unsubscribeFromPush().catch(() => {}); // guests drop their seat sub
}

// Inject Wurdz's turn-notification toggle into the shared hamburger menu (the
// menu markup is owned by account-ui.js; this is the one game-specific entry).
// stopPropagation keeps the menu open so the label updates in place rather than
// the dropdown closing on you.
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
  // Sit just above the theme picker / "More Games" separator.
  const anchor = menu.querySelector('.theme-picker-section') || menu.querySelector('a.menu-sep');
  menu.insertBefore(item, anchor || null);
  item.addEventListener('click', (e) => { e.stopPropagation(); onToggleNotify(); });
})();

// Push the opponent if our move handed them the turn (covers all move types,
// since app.state.turn already reflects the applied move). Fire-and-forget.
function pushOpponentIfTheirTurn() {
  if (!app.state.started || app.state.gameOver) return;
  const recipient = app.state.turn;
  if (recipient === app.playerIndex) return; // it's still our turn (e.g. upheld challenge)
  const lm = app.state.lastMove;
  triggerPush({
    room_code: app.code,
    player: recipient,
    title: "Wurdz — it's your turn",
    body: moveSummary(lm, lm ? playerName(lm.player) : 'Your opponent'),
    url: location.href.split('#')[0],
  }).catch(() => {});
}

// Describes the latest move, naming whoever made it (`mover`), from the
// perspective of the player about to move.
function moveSummary(lm, mover) {
  if (!lm) return 'Your move!';
  if (lm.type === 'place') return `${mover} played ${lm.words.join(', ')} for ${lm.score}. Your move!`;
  if (lm.type === 'pass') return `${mover} passed. Your move!`;
  if (lm.type === 'exchange') return `${mover} exchanged tiles. Your move!`;
  if (lm.type === 'challenge') return `${mover} challenged. Your move!`;
  if (lm.type === 'start') return 'The game has started. Your move!';
  if (lm.type === 'forfeit') return `${mover} resigned. You win!`;
  return 'Your move!';
}

// For the local notification, where we are the player about to move.
function turnNoticeBody() {
  return moveSummary(app.state.lastMove, playerName(1 - app.playerIndex));
}

function maybeNotifyTurn() {
  if (document.hidden && isMyTurn() && notifyEnabled()) {
    showTurnNotification(turnNoticeBody());
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) clearTurnNotification();
  postRoomVisibility();
});

$('btn-leave').addEventListener('click', async () => {
  sessionStorage.removeItem(SESSION_KEY);
  clearTurnNotification();
  // Signed-in players go back to their games list (keeping cross-game push);
  // guests fully leave and drop their seat's subscription.
  if (app.user) {
    if (app.conn) app.conn.close();
    app.conn = null;
    app.code = null; app.playerIndex = null; app.room = null; app.state = null;
    app.pending = []; app.pendingMoves = new Map();
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
  } catch { /* clipboard unavailable; code is visible anyway */ }
});

// Resign: forfeit the game (opponent wins) and clear it from your own list.
$('btn-resign').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  const ok = await confirmDialog({
    title: 'Resign this game?',
    message: "You'll forfeit — your opponent wins and the game is removed from your "
      + "games list. This can't be undone.",
    confirmText: 'Resign',
    danger: true,
  });
  if (!ok) return;
  recallTiles(false);
  await submitMove('forfeit', {});
  // Let the opponent know they won by forfeit, and drop the game from my list.
  triggerPush({
    room_code: app.code,
    player: 1 - app.playerIndex,
    title: 'Wurdz — game over',
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
  if (move.move_index < app.state.moveCount) return; // already applied
  app.pendingMoves.set(move.move_index, move);
  let applied = false;
  while (app.pendingMoves.has(app.state.moveCount)) {
    const m = app.pendingMoves.get(app.state.moveCount);
    app.pendingMoves.delete(m.move_index);
    try {
      applyMove(app.state, m);
      applied = true;
    } catch (e) {
      console.error('Failed to apply move', m, e);
      return;
    }
  }
  if (applied) {
    app.conn.setNextIndex(app.state.moveCount);
    recallTiles(false);
    renderAll();
    announceLastMove();
    maybeNotifyTurn();
    maybeFinish();
  } else if (move.move_index > app.state.moveCount) {
    // We have a gap — fetch the missing moves from the database.
    app.conn.pollOnce().catch(() => {});
  }
}

// Rematch: one tap spins up a fresh room and pulls the opponent into it (shared).
const rematch = createRematch({
  state: app,
  seatKey: 'playerIndex',
  createRoom: (name, userId) => createRoom(name, userId),
  joinRoom, enterRoom,
  onError: (msg) => setStatus(msg),
});
$('btn-rematch').addEventListener('click', rematch.start);

async function handlePresence(present) {
  const oppKey = String(1 - app.playerIndex);
  app.oppOnline = present.has(oppKey);
  renderOppPanel();
  // The guest joining updates the rooms row; if we're on the websocket we
  // won't see that via polling, so refresh when their presence appears.
  if (app.oppOnline && !seatName(app.room, 1 - app.playerIndex)) {
    try {
      app.room = await fetchRoom(app.code);
      renderAll();
    } catch { /* next poll or presence event will retry */ }
  }
}

function handleRoomUpdate(room) {
  const hadSecondPlayer = (app.room?.player_count ?? 0) >= 2;
  app.room = room;
  // The opponent finished (and may have purged the moves) while we were a move
  // behind: show the stored result rather than waiting for moves that are gone.
  if (room.status === 'finished' && room.result && app.state && !app.state.gameOver) {
    applyStoredResult(app.state, room.result);
    app.finishPersisted = true;
    renderAll();
    return;
  }
  if (!hadSecondPlayer && room.player_count >= 2) renderAll();
  else renderOverlays();
}

function announceLastMove() {
  const lm = app.state.lastMove;
  if (!lm) { setStatus(''); return; } // nothing has happened in this room yet
  const who = lm.player === app.playerIndex ? 'You' : playerName(lm.player);
  if (lm.type === 'place') {
    const words = lm.words.join(', ');
    setStatus(`${who} played ${words} for ${lm.score} points${lm.bingo ? ' — BINGO! (+50)' : ''}.`);
  } else if (lm.type === 'exchange') {
    setStatus(`${who} exchanged ${lm.count} tile${lm.count === 1 ? '' : 's'}.`);
  } else if (lm.type === 'pass') {
    setStatus(`${who} passed.`);
  } else if (lm.type === 'challenge') {
    if (lm.upheld) {
      const whose = lm.target === app.playerIndex ? 'Your' : `${playerName(lm.target)}'s`;
      setStatus(`${who} challenged — ${lm.invalid.join(', ')} not valid. ${whose} tiles return and that turn is lost.`);
    } else {
      const verb = lm.player === app.playerIndex ? 'lose' : 'loses';
      setStatus(`${who} challenged, but ${lm.words.join(', ')} ${lm.words.length > 1 ? 'are' : 'is'} valid — ${who} ${verb} the turn.`);
    }
  } else if (lm.type === 'start') {
    setStatus(`Game on! ${playerName(lm.firstPlayer)} goes first.`);
  } else if (lm.type === 'forfeit') {
    const who = lm.player === app.playerIndex ? 'You' : playerName(lm.player);
    setStatus(`${who} resigned — game over.`);
  }
}

// ---- Helpers --------------------------------------------------------------

function playerName(idx) {
  if (!app.room) return '?';
  return seatName(app.room, idx) ?? 'Opponent';
}

function myRack() {
  return app.state.racks[app.playerIndex];
}

function isMyTurn() {
  return app.state.started && !app.state.gameOver && app.state.turn === app.playerIndex;
}

function setStatus(msg) {
  $('status-line').textContent = msg;
}

// Rack indices currently sitting on the board as pending tiles.
function pendingRackIndices() {
  return new Set(app.pending.map((p) => p.rackIdx));
}

// ---- Local moves -----------------------------------------------------------

async function submitMove(type, payload) {
  const move = {
    move_index: app.state.moveCount,
    player: app.playerIndex,
    type,
    payload,
  };
  applyMove(app.state, move); // optimistic local apply (engine is deterministic)
  app.conn.setNextIndex(app.state.moveCount);
  renderAll();
  announceLastMove();
  try {
    await app.conn.sendMove(move);
    pushOpponentIfTheirTurn();
    maybeFinish();
  } catch (e) {
    // The database write failed (e.g. brief offline blip). Re-sync from the
    // database so we never diverge from the source of truth.
    setStatus(`Could not save your move (${e.message}). Re-syncing…`);
    const moves = await fetchMoves(app.code);
    app.state = replayMoves(app.room.seed, moves);
    app.conn.setNextIndex(app.state.moveCount);
    recallTiles(false);
    renderAll();
  }
}

// Once the game is over, store the final result on the room (so the lobby and
// Game History can show it without replaying) and purge the now-redundant move
// log. Both players reach game-over independently and call this; the write is
// idempotent and the move purge is a no-op the second time.
async function maybeFinish() {
  if (!app.state?.gameOver || app.finishPersisted) return;
  app.finishPersisted = true;
  const result = {
    scores: app.state.scores.slice(),
    winner: app.state.winner,
    reason: app.state.endDetail?.reason ?? 'out',
    endDetail: app.state.endDetail ?? null,
  };
  try {
    await finishRoom(app.code, result, true); // true = purge the move log
    if (app.room) { app.room.status = 'finished'; app.room.result = result; }
    app.conn?.broadcastRoom(app.room);
  } catch {
    app.finishPersisted = false; // let a later attempt retry
  }
}

// Force a state object into the stored finished result (used when the moves are
// already purged, e.g. opening a finished game or a late room update).
function applyStoredResult(stateObj, result) {
  stateObj.started = true;
  stateObj.gameOver = true;
  stateObj.winner = result.winner;
  if (Array.isArray(result.scores)) stateObj.scores = result.scores.slice();
  stateObj.endDetail = result.endDetail || { reason: result.reason || 'out', outPlayer: result.winner };
}

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try {
    await submitMove('start', {});
    await updateRoomStatus(app.code, 'playing');
    app.room.status = 'playing';
    app.conn.broadcastRoom(app.room);
    renderOverlays();
  } finally {
    $('btn-start').disabled = false;
  }
});

$('btn-play').addEventListener('click', async () => {
  if (!isMyTurn() || !app.pending.length) return;
  const cells = app.pending.map(({ r, c, letter, blank }) => ({ r, c, letter, blank }));
  const result = validatePlacement(app.state, cells);
  if (!result.ok) {
    setStatus(result.error);
    return;
  }
  app.pending = [];
  app.selectedRackIdx = null;
  await submitMove('place', { cells });
});

$('btn-pass').addEventListener('click', async () => {
  if (!isMyTurn()) return;
  // Counters as they'll stand *after* this pass.
  const scoreless = app.state.scorelessTurns + 1;
  const passes = app.state.consecutivePasses + 1;
  const willEnd = scoreless >= MAX_SCORELESS_TURNS || passes >= MAX_CONSECUTIVE_PASSES;
  const nearEnd = !willEnd
    && (passes >= MAX_CONSECUTIVE_PASSES - 1 || scoreless >= MAX_SCORELESS_TURNS - 1);
  let opts;
  if (willEnd) {
    opts = {
      title: 'Pass and end the game?',
      message: 'Passing now ENDS THE GAME — each player\'s remaining tiles are deducted '
        + 'from their score. Pass and finish?',
      confirmText: 'Pass & end game',
      danger: true,
    };
  } else if (nearEnd) {
    opts = {
      title: 'Pass your turn?',
      message: 'Heads up: after this pass, one more scoreless turn from your opponent will '
        + 'end the game. Pass your turn?',
      confirmText: 'Pass',
      danger: true,
    };
  } else {
    opts = {
      title: 'Pass your turn?',
      message: 'You\'ll forfeit your move and draw no tiles. The game ends if both players '
        + 'pass twice in a row, or after six scoreless turns. Pass your turn?',
      confirmText: 'Pass',
    };
  }
  if (!(await confirmDialog(opts))) return;
  recallTiles(false);
  await submitMove('pass', {});
});

$('btn-exchange').addEventListener('click', () => {
  if (!isMyTurn()) return;
  if (app.state.bag.length < RACK_SIZE) {
    setStatus('You can only exchange while at least 7 tiles remain in the bag.');
    return;
  }
  recallTiles(false);
  app.exchangeMode = true;
  app.exchangeSel.clear();
  renderRack();
  renderControls();
});

$('btn-exchange-cancel').addEventListener('click', () => {
  app.exchangeMode = false;
  app.exchangeSel.clear();
  renderRack();
  renderControls();
});

$('btn-exchange-go').addEventListener('click', async () => {
  if (!app.exchangeSel.size) return;
  const rack = myRack();
  const tiles = [...app.exchangeSel].map((i) => rack[i]);
  app.exchangeMode = false;
  app.exchangeSel.clear();
  await submitMove('exchange', { tiles });
});

$('btn-shuffle').addEventListener('click', () => {
  if (app.pending.length) return; // keep rack indices stable while placing
  const rack = myRack();
  for (let i = rack.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rack[i], rack[j]] = [rack[j], rack[i]];
  }
  renderRack();
});

$('btn-recall').addEventListener('click', () => recallTiles(true));

function canChallenge() {
  const lm = app.state.lastMove;
  return isMyTurn() && lm && lm.type === 'place' && lm.player === (1 - app.playerIndex);
}

$('btn-challenge').addEventListener('click', async () => {
  if (!canChallenge()) return;
  const words = app.state.lastMove.words;
  const list = words.join(', ');
  const confirmed = await confirmDialog({
    title: 'Challenge this play?',
    message: `Challenge ${list}? If ${words.length > 1 ? 'they are all' : "it's"} valid, the `
      + 'challenge fails and you forfeit your turn.',
    confirmText: 'Challenge',
  });
  if (!confirmed) return;

  $('btn-challenge').disabled = true;
  setStatus('Checking the dictionary…');
  try {
    await loadDictionary();
  } catch {
    setStatus('Could not load the dictionary — check your connection and try again.');
    renderControls();
    return;
  }
  const { ok, invalid } = checkWords(words);
  recallTiles(false);
  await submitMove('challenge', { upheld: !ok, words, invalid });
});

function recallTiles(render = true) {
  app.pending = [];
  app.selectedRackIdx = null;
  if (render) {
    renderBoard();
    renderRack();
    renderControls();
  }
}

// ---- Tile placement interaction --------------------------------------------

function onRackTileClick(idx) {
  if (suppressNextClick) { suppressNextClick = false; return; } // came from a drag
  if (app.exchangeMode) {
    if (app.exchangeSel.has(idx)) app.exchangeSel.delete(idx);
    else app.exchangeSel.add(idx);
    renderRack();
    renderControls();
    return;
  }
  if (!isMyTurn()) return;
  if (pendingRackIndices().has(idx)) return;
  app.selectedRackIdx = app.selectedRackIdx === idx ? null : idx;
  renderRack();
}

function onBoardCellClick(r, c) {
  if (!isMyTurn() || app.exchangeMode) return;

  // Clicking a pending tile returns it to the rack.
  const pi = app.pending.findIndex((p) => p.r === r && p.c === c);
  if (pi !== -1) {
    app.pending.splice(pi, 1);
    renderBoard();
    renderRack();
    renderControls();
    return;
  }

  if (app.selectedRackIdx === null) return;
  placeTileFromRack(app.selectedRackIdx, r, c);
}

// Shared by tap-to-place and drag-to-place.
function placeTileFromRack(rackIdx, r, c) {
  if (!isMyTurn() || app.exchangeMode) return;
  if (app.state.board[r][c]) return;
  if (app.pending.some((p) => p.r === r && p.c === c)) return;
  if (pendingRackIndices().has(rackIdx)) return;

  const letter = myRack()[rackIdx];
  if (letter === BLANK) {
    openBlankPicker((chosen) => {
      app.pending.push({ r, c, letter: chosen, blank: true, rackIdx });
      app.selectedRackIdx = null;
      renderBoard();
      renderRack();
      renderControls();
    });
    return;
  }
  app.pending.push({ r, c, letter, blank: false, rackIdx });
  app.selectedRackIdx = null;
  renderBoard();
  renderRack();
  renderControls();
}

// ---- Drag and drop (pointer-based, works with mouse and touch) ------------
//
// Dragging a rack tile onto the board places it (only on your turn).
// Dragging within the rack reorders your letters (allowed any time, even
// when it isn't your turn) — the other tiles slide aside to open a gap
// where the dragged tile will land.

let suppressNextClick = false;
let rackDragCleanup = null; // tears down an in-progress drag if the rack re-renders

function createGhost(letter) {
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.innerHTML = letter === BLANK
    ? '<span class="t-letter">&nbsp;</span>'
    : `<span class="t-letter">${letter}</span><span class="t-pts">${TILE_POINTS[letter]}</span>`;
  return g;
}

function startRackDrag(e, idx) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (app.exchangeMode) return;              // exchange selection uses tap
  if (pendingRackIndices().has(idx)) return; // tile is already on the board

  const tileEl = e.currentTarget;
  const startX = e.clientX, startY = e.clientY;
  const letter = myRack()[idx];
  // Reordering would shift the indices that pending tiles point at, so only
  // allow it when nothing is staged on the board.
  const canReorder = app.pending.length === 0;
  let active = false;
  let ghost = null;

  // Rack-gap animation state, populated when the drag activates. We move the
  // other tiles with transforms (never hiding the dragged element, so its
  // pointer capture stays intact) to open a gap where the tile will land.
  let allTiles = [];   // every rack tile, in order (DOM index == rack index)
  let slotsX = [];     // base center-x of each slot, captured before shifting
  let gapIdx = null;   // current insertion index, or null when no gap shown

  const showGap = (ins) => {
    if (ins === gapIdx) return;
    gapIdx = ins;
    let k = 0; // running index among the non-dragged tiles
    allTiles.forEach((t, fi) => {
      if (t === tileEl) return;
      const targetSlot = k < ins ? k : k + 1;
      t.style.transform = `translateX(${slotsX[targetSlot] - slotsX[fi]}px)`;
      k++;
    });
  };
  const hideGap = () => {
    if (gapIdx === null) return;
    gapIdx = null;
    allTiles.forEach((t) => { if (t !== tileEl) t.style.transform = 'translateX(0)'; });
  };
  const insAt = (x) => {
    let n = 0;
    for (const cx of slotsX) if (x > cx) n++;
    return Math.max(0, Math.min(n, slotsX.length - 1));
  };

  const clearCellHighlight = () => {
    document.querySelectorAll('.cell.drop-target').forEach((c) => c.classList.remove('drop-target'));
  };

  const updateFeedback = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const cell = el && el.closest('.cell');
    clearCellHighlight();
    if (cell && cell.dataset.r !== undefined && isMyTurn()) {
      const r = +cell.dataset.r, c = +cell.dataset.c;
      if (!app.state.board[r][c] && !app.pending.some((p) => p.r === r && p.c === c)) {
        cell.classList.add('drop-target');
      }
      hideGap();
      return;
    }
    if (canReorder && el && el.closest('#rack')) showGap(insAt(x));
    else hideGap();
  };

  const onMove = (ev) => {
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
      active = true;
      tileEl.classList.add('drag-src');
      ghost = createGhost(letter);
      document.body.appendChild(ghost);
      if (canReorder) {
        allTiles = [...$('rack').querySelectorAll('.rack-tile')];
        slotsX = allTiles.map((t) => { const r = t.getBoundingClientRect(); return r.left + r.width / 2; });
        allTiles.forEach((t) => { if (t !== tileEl) t.style.transition = 'transform 0.15s ease'; });
      }
      rackDragCleanup = teardown;
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    updateFeedback(ev.clientX, ev.clientY);
  };

  // Removes all drag DOM/listeners without committing a reorder.
  const teardown = () => {
    if (rackDragCleanup === teardown) rackDragCleanup = null;
    tileEl.removeEventListener('pointermove', onMove);
    tileEl.removeEventListener('pointerup', onUp);
    tileEl.removeEventListener('pointercancel', onCancel);
    if (ghost) { ghost.remove(); ghost = null; }
    clearCellHighlight();
    allTiles.forEach((t) => { t.style.transition = ''; t.style.transform = ''; });
    tileEl.classList.remove('drag-src');
  };

  const onUp = (ev) => {
    const wasActive = active;
    const x = ev.clientX, y = ev.clientY;
    const dropIdx = gapIdx;
    const el = wasActive ? document.elementFromPoint(x, y) : null;
    teardown();
    if (!wasActive) return; // it was a tap → let the click handler run

    ev.preventDefault();
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 350);

    const cell = el && el.closest('.cell');
    if (cell && cell.dataset.r !== undefined && isMyTurn()) {
      placeTileFromRack(idx, +cell.dataset.r, +cell.dataset.c);
      return;
    }
    if (canReorder && dropIdx !== null && el && el.closest('#rack')) {
      const rack = myRack();
      const [tile] = rack.splice(idx, 1); // `others` indexing equals rack-without-dragged
      rack.splice(Math.max(0, Math.min(dropIdx, rack.length)), 0, tile);
      app.selectedRackIdx = null;
      renderRack();
    }
  };

  const onCancel = () => teardown();

  tileEl.setPointerCapture(e.pointerId);
  tileEl.addEventListener('pointermove', onMove);
  tileEl.addEventListener('pointerup', onUp);
  tileEl.addEventListener('pointercancel', onCancel);
}

// ---- Rendering --------------------------------------------------------------

function renderAll() {
  renderBoard();
  renderRack();
  renderOppPanel();
  renderMyPanel();
  renderControls();
  renderOverlays();
}

// My connection health shows as a dot beside my name (mirrors the opponent's
// online dot): green when moves arrive live over the websocket, amber while
// they sync through the database. No separate badge or alert — the fallback is
// graceful, so it isn't worth a message of its own.
function renderMyOnline() {
  const dot = $('my-online');
  if (!dot) return;
  const live = app.connMode === 'live';
  dot.className = `online-dot ${live ? 'online' : 'syncing'}`;
  dot.title = live ? 'Connected — moves arrive instantly' : 'Syncing through the database';
}

function renderBoard() {
  const boardEl = $('board');
  boardEl.innerHTML = '';
  // Tiles placed by the most recent play, so the last turn is visible at a
  // glance. Only 'place' moves put tiles on the board.
  const lm = app.state.lastMove;
  const lastCells = (lm && lm.type === 'place' && Array.isArray(lm.cells))
    ? new Set(lm.cells.map((p) => `${p.r},${p.c}`))
    : null;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      const prem = premiumAt(r, c);
      const tile = app.state.board[r][c];
      const pend = app.pending.find((p) => p.r === r && p.c === c);
      if (tile || pend) {
        const t = tile || pend;
        cell.classList.add('has-tile');
        if (pend) cell.classList.add('pending');
        else if (lastCells && lastCells.has(`${r},${c}`)) cell.classList.add('last-move');
        cell.innerHTML = `<span class="t-letter">${t.letter}</span><span class="t-pts">${t.blank ? '' : TILE_POINTS[t.letter]}</span>`;
        if (t.blank) cell.classList.add('blank-tile');
      } else if (prem) {
        cell.classList.add(`prem-${prem.toLowerCase()}`);
        cell.textContent = (r === CENTER && c === CENTER) ? '★' : prem;
      }
      cell.addEventListener('click', () => onBoardCellClick(r, c));
      boardEl.appendChild(cell);
    }
  }
}

function renderRack() {
  if (rackDragCleanup) rackDragCleanup();
  const rackEl = $('rack');
  rackEl.innerHTML = '';
  const used = pendingRackIndices();
  myRack().forEach((letter, idx) => {
    const tile = document.createElement('button');
    tile.className = 'rack-tile';
    if (used.has(idx)) tile.classList.add('placed');
    if (app.selectedRackIdx === idx) tile.classList.add('selected');
    if (app.exchangeMode && app.exchangeSel.has(idx)) tile.classList.add('exchange-sel');
    tile.innerHTML = letter === BLANK
      ? '<span class="t-letter">&nbsp;</span>'
      : `<span class="t-letter">${letter}</span><span class="t-pts">${TILE_POINTS[letter]}</span>`;
    tile.addEventListener('pointerdown', (e) => startRackDrag(e, idx));
    tile.addEventListener('click', () => onRackTileClick(idx));
    rackEl.appendChild(tile);
  });
}

function renderOppPanel() {
  const oppIdx = 1 - app.playerIndex;
  const hasOpp = !!seatName(app.room, oppIdx);
  $('opp-name').textContent = hasOpp ? playerName(oppIdx) : 'Waiting for opponent…';
  $('opp-score').textContent = app.state.scores[oppIdx];
  $('opp-tiles').textContent = app.state.started ? `${app.state.racks[oppIdx].length} tiles` : '';
  $('opp-turn').classList.toggle('hidden', !(app.state.started && !app.state.gameOver && app.state.turn === oppIdx));
  const dot = $('opp-online');
  dot.className = `online-dot ${app.oppOnline ? 'online' : 'offline'}`;
  dot.title = app.oppOnline ? 'online' : 'offline';
}

function renderMyPanel() {
  $('my-name').textContent = `${app.name} (you)`;
  $('my-score').textContent = app.state.scores[app.playerIndex];
  $('my-turn').classList.toggle('hidden', !isMyTurn());
  $('bag-count').textContent = app.state.started ? `bag: ${app.state.bag.length}` : '';
  renderMyOnline();
}

function renderControls() {
  const my = isMyTurn();
  $('btn-pass').disabled = !my;
  // Flag the Pass button red once the game is within one round (two turns) of
  // ending — either both players have passed once, or scoreless turns are piling up.
  const passWarn = app.state.consecutivePasses >= MAX_CONSECUTIVE_PASSES - 2
    || app.state.scorelessTurns >= MAX_SCORELESS_TURNS - 2;
  $('btn-pass').classList.toggle('btn-pass-warn', passWarn);
  $('btn-exchange').disabled = !my || app.state.bag.length < RACK_SIZE;
  $('btn-shuffle').disabled = !!app.pending.length;
  $('btn-challenge').disabled = !canChallenge();

  const playBtn = $('btn-play');
  if (my && app.pending.length) {
    const cells = app.pending.map(({ r, c, letter, blank }) => ({ r, c, letter, blank }));
    const result = validatePlacement(app.state, cells);
    if (result.ok) {
      playBtn.disabled = false;
      playBtn.textContent = `Play for ${result.total}`;
      setStatus(`Forms: ${result.words.map((w) => w.word).join(', ')}${result.bingo ? ' — BINGO! (+50)' : ''}`);
    } else {
      playBtn.disabled = true;
      playBtn.textContent = 'Play';
      setStatus(result.error);
    }
  } else {
    playBtn.disabled = true;
    playBtn.textContent = 'Play';
  }

  $('exchange-bar').classList.toggle('hidden', !app.exchangeMode);
  $('btn-exchange-go').textContent = `Swap ${app.exchangeSel.size} tile${app.exchangeSel.size === 1 ? '' : 's'}`;
  $('btn-exchange-go').disabled = !app.exchangeSel.size;

  // Resign is offered once there's an opponent and the game isn't already over.
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

  if (app.state.started) {
    startOv.classList.add('hidden');
    return;
  }

  startOv.classList.remove('hidden');
  const haveGuest = !!seatName(app.room, 1);
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

  let reason;
  if (s.endDetail.reason === 'passes') {
    reason = s.endDetail.byPasses
      ? 'Both players passed twice in a row, ending the game.'
      : 'Six scoreless turns in a row ended the game.';
  } else if (s.endDetail.reason === 'forfeit') {
    reason = `${playerName(s.endDetail.resignedPlayer)} resigned.`;
  } else {
    reason = `${playerName(s.endDetail.outPlayer)} played their last tile.`;
  }
  const adjustNote = s.endDetail.reason === 'forfeit'
    ? ''
    : '<p class="muted">Final scores include unplayed-tile adjustments.</p>';
  $('gameover-detail').innerHTML = `
    <p>${reason}</p>
    <p class="final-scores">
      ${playerName(0)}: <strong>${s.scores[0]}</strong><br>
      ${playerName(1)}: <strong>${s.scores[1]}</strong>
    </p>
    ${adjustNote}
  `;
}

// ---- Blank tile picker --------------------------------------------------------

function openBlankPicker(onPick) {
  const grid = $('blank-letters');
  grid.innerHTML = '';
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    const b = document.createElement('button');
    b.className = 'blank-letter';
    b.textContent = letter;
    b.addEventListener('click', () => {
      $('modal-blank').classList.add('hidden');
      onPick(letter);
    });
    grid.appendChild(b);
  }
  $('modal-blank').classList.remove('hidden');
}

// ---- Confirmation dialog --------------------------------------------------------

let confirmResolver = null;

// Game-rendered replacement for window.confirm. Returns a promise that
// resolves to true (confirmed) or false (cancelled / dismissed).
function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  $('wz-confirm-title').textContent = title;
  $('wz-confirm-message').textContent = message;
  const okBtn = $('wz-confirm-ok');
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

$('wz-confirm-ok').addEventListener('click', () => settleConfirm(true));
$('wz-confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('modal-confirm').addEventListener('click', (e) => {
  if (e.target.id === 'modal-confirm') settleConfirm(false);
});

// ---- Two-letter words modal -----------------------------------------------------

let wordsTab = 'nwl';

function renderWords() {
  const filter = $('words-filter').value.trim().toUpperCase();
  const grid = $('words-grid');
  grid.innerHTML = '';
  for (const entry of TWO_LETTER_WORDS) {
    if (wordsTab === 'nwl' && entry.collinsOnly) continue;
    if (filter && !entry.w.includes(filter)) continue;
    const div = document.createElement('div');
    div.className = 'word-entry';
    div.innerHTML = `<span class="word">${entry.w}${entry.collinsOnly ? '<sup>C</sup>' : ''}</span><span class="def">${entry.d}</span>`;
    grid.appendChild(div);
  }
}

$('btn-words').addEventListener('click', () => {
  $('modal-words').classList.remove('hidden');
  renderWords();
});
$('words-filter').addEventListener('input', renderWords);
$('tab-nwl').addEventListener('click', () => {
  wordsTab = 'nwl';
  $('tab-nwl').classList.add('active');
  $('tab-collins').classList.remove('active');
  renderWords();
});
$('tab-collins').addEventListener('click', () => {
  wordsTab = 'collins';
  $('tab-collins').classList.add('active');
  $('tab-nwl').classList.remove('active');
  renderWords();
});

// The "How to play" entry and the #help-modal open/close are wired by the
// shared account-ui.js (it opens #help-modal and closes via #help-close).
// Wire only Wurdz's own modals here so we never double-bind the shared ones
// (auth/profile/name/confirm/help) that account-ui already owns.

document.querySelectorAll('.modal-close[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
});
// Backdrop-click closes Wurdz's own modals (words). Blank/confirm are modal
// (no backdrop dismiss); help is wired by account-ui.
['modal-words'].forEach((id) => {
  const m = $(id);
  m?.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
});

// ---- Boot ------------------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  // Feed the game-specific challenge action into the shared friends dialog.
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  renderNotifyBtns(); // set the menu's notification label/visibility up-front

  // Seed the guest name field from the shared key (set on the landing page or
  // any other game) and keep it in sync as it's edited here.
  $('landing-name-input').value = getGuestName();
  $('landing-name-input').addEventListener('input', () => setGuestName($('landing-name-input').value));

  if (!configReady()) {
    landingError('Setup needed: paste your Supabase anon key into js/config.js (see README).');
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    return;
  }

  // Restore any existing login before deciding which screen to show.
  app.user = await currentUser();
  app.userId = app.user?.id ?? null;
  if (app.user) app.name = displayName(app.user);
  applyAuthToUI();
  if (app.user && notifyEnabled()) refreshPushSub();

  const resumed = await tryResume();
  if (!resumed && app.user) { showScreen('lobby'); renderLobby(); }

  // React to later sign-in/out, including magic-link return.
  onAuthChange(handleAuthChange);
}

boot();
