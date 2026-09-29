import {
  newGameState, applyMove, replayMoves, currentDice, pipCount,
  legalStepList, maxDiceUsable, stepResult, colorOf, ownerAt,
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
const removeDie = (dice, d) => { const i = dice.indexOf(d); const c = dice.slice(); if (i >= 0) c.splice(i, 1); return c; };

const app = {
  user: null, userId: null, name: null, code: null, playerIndex: null,
  room: null, state: null, conn: null,
  work: null,           // { board, bar, off, dice } — the turn being built
  turnDice: [],         // this turn's original pips
  steps: [],            // steps committed this turn (local, pre-submit)
  selected: null,       // selected source: point index or 'bar'
  maxDice: 0,           // dice that must be played this turn
  turnInitFor: -1,      // turnIndex this turn was initialised for
  oppInitFor: -1,       // turnIndex the opponent's auto-roll was played for
  rolled: false,        // have the dice been rolled/revealed this turn?
  rolling: false,       // roll animation in progress
  rollFaces: null,      // the two tumbling faces shown during the animation
  justLanded: false,    // one render after settling → plays the "pop"
  rolledPairOnly: false,// doubles: briefly show the landed PAIR before it splits to 4
  dupLanded: false,     // doubles: the render that duplicates the pair into 4
  rollTimer: null,      // pending animation frame timeout
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
  $('setup-subtitle').textContent = friend ? `Choose a per-move time for your challenge to ${friend.display_name || 'your friend'}.` : 'How long does each player get per move?';
  $('modal-setup').classList.remove('hidden');
}
function closeSetup() { $('modal-setup').classList.add('hidden'); setupCtx = null; }
document.querySelectorAll('#setup-times .setup-time').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.time; const ctx = setupCtx; closeSetup(); if (!ctx) return;
    if (ctx.friend) createChallengeWithTime(ctx.friend, key); else createAndEnter(ctx.name, ctx.userId, key, ctx.onError);
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
  try { app.timeKey = timeKey; let room = await createRoom(name, userId); room = await stampTime(room, timeKey); await enterRoom(room.code, 0, name, room); } catch (e) { onError(e.message); }
}
async function joinAndEnter(code, name, userId, onError) {
  if (code.length < 4) { onError('Enter the room code you were given.'); return; }
  requestNotifications().then(onNotifyPermissionResolved);
  try { const { room, playerIndex } = await joinRoom(code, name, userId); await enterRoom(code, playerIndex, name, room); } catch (e) { onError(e.message); }
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
  try { const reg = await navigator.serviceWorker.ready; const inGame = !$('screen-game').classList.contains('hidden'); reg.active?.postMessage({ type: 'room-visible', code: inGame ? app.code : null, visible: inGame && !document.hidden }); } catch { /* ignore */ }
}
function pushRoute() { if (app.userId) return { userId: app.userId }; if (app.code !== null && app.playerIndex !== null) return { roomCode: app.code, player: app.playerIndex }; return null; }
function refreshPushSub() { const r = pushRoute(); if (r && notifyEnabled()) subscribeToPush(r).catch(() => {}); }
function applyAuthToUI() { $('btn-go-lobby')?.classList.toggle('hidden', !app.user); if (app.user) $('lobby-name').textContent = app.name; renderNotifyBtns(); }
function handleAuthChange(user) {
  app.user = user; app.userId = user?.id ?? null; if (user) app.name = displayName(user);
  applyAuthToUI(); if (user && notifyEnabled()) refreshPushSub();
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
  try { state = replayMoves(room.seed, await fetchMoves(room.code)); } catch { /* ignore */ }
  return { room, myIndex, oppIndex, oppName, state };
}
function buildLobbyCard({ room, myIndex, oppIndex, oppName, state }) {
  const card = document.createElement('button'); card.className = 'lobby-game';
  const timeTag = `<span class="lobby-size">${esc(TIME_SHORT[room?.players?.[0]?.time || 'unlimited'] || 'Backgammon')}</span>`;
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
    triggerPush({ user_id: friend.id, title: 'Backgammon — you have been challenged', body: `${app.name} challenged you to a game.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { showScreen('lobby'); lobbyError(`Could not start the game (${e.message}).`); }
}

// ---- Entering / leaving -----------------------------------------------------

async function enterRoom(code, playerIndex, name, room) {
  // The room is the authority on who occupies this seat. A stored session can
  // carry a stale name (or one from a different identity), and showing that
  // instead would label you as someone else.
  app.code = code; app.playerIndex = playerIndex; app.name = seatName(room, playerIndex) || name; app.room = room;
  app.rematching = false; app.work = null; app.steps = []; app.selected = null; app.turnInitFor = -1;
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
  app.conn = new RoomConnection(code, playerIndex, name, { onMove: handleIncomingMove, onPresence: handlePresence, onMode: (mode) => { app.connMode = mode; renderMyOnline(); }, onRoomUpdate: handleRoomUpdate });
  app.conn.setNextIndex(app.state.moveCount); app.conn.connect(); app.connMode = 'db';

  stopLobbyPolling(); showScreen('game'); ensureBoard();
  $('room-code-text').textContent = code;
  renderNotifyBtns(); refreshPushSub(); renderAll(); announceLastMove(); startClockTicker();
}
function ensureBoard() {
  if (goboard) return;
  goboard = createBoard($('board'), { onPoint, onRoll: startRoll, draggable: isDragSource, dragTargets: dragTargetsFor, onDrop });
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
  renderNotifyBtns(); if (notifyEnabled()) refreshPushSub(); else if (!app.userId) unsubscribeFromPush().catch(() => {});
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
  const recipient = app.state.turn; if (recipient === app.playerIndex) return;
  triggerPush({ room_code: app.code, player: recipient, title: "Backgammon — it's your turn", body: moveSummary(app.state.lastMove, playerName(app.state.lastMove?.player)), url: location.href.split('#')[0] }).catch(() => {});
}
function moveSummary(lm, mover) {
  if (!lm) return 'Your move!';
  if (lm.type === 'move') return `${mover} rolled ${lm.dice?.join('-')} and moved. Your roll!`;
  if (lm.type === 'start') return 'The game has started. Roll and move!';
  if (lm.type === 'resign') return `${mover} resigned. You win!`;
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
  if (app.user) { app.conn?.close(); app.conn = null; app.code = null; app.playerIndex = null; app.room = null; app.state = null; app.work = null; app.pendingMoves = new Map(); showScreen('lobby'); renderLobby(); }
  else { try { await unsubscribeFromPush(); } catch { /* ignore */ } location.reload(); }
});
$('room-code-chip').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomShareUrl(app.code)); setStatus('Invite link copied.'); } catch { /* ignore */ } });
$('btn-resign').addEventListener('click', async () => {
  if (!app.state || app.state.gameOver || (app.room?.player_count ?? 0) < 2) return;
  if (!(await confirmDialog({ title: 'Resign this game?', message: "You'll forfeit — your opponent wins and the game ends. This can't be undone.", confirmText: 'Resign', danger: true }))) return;
  await submitMove('resign', {});
  triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Backgammon — game over', body: `${app.name} resigned — you win!`, url: location.href.split('#')[0] }).catch(() => {});
  if (app.userId) dismissGame(app.userId, app.code);
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
    app.turnAnchorMs = Date.now(); moveTimer?.resetClaim();
    renderAll(); announceLastMove(); maybeNotifyTurn(); maybeFinish();
  } else if (move.move_index > app.state.moveCount) app.conn.pollOnce().catch(() => {});
}
// ---- Running match score (across a rematch chain) --------------------------
// Carried on room.players[seat].{matchWins,matchPoints} (shared/rooms.js's
// extra-field params on createRoom/joinRoom). Undefined until the 2nd+ game
// of an actual rematch chain, so a fresh one-off room never shows a
// meaningless "0–0". matchPoints uses backgammon's own gammon/backgammon
// stakes (roundPoints, above) — the number that actually matters in a
// backgammon match, not just games won.
function carriedTally(seat) {
  const old = app.room?.players?.[seat];
  const won = app.state.winner === seat;
  return {
    matchWins: (old?.matchWins || 0) + (won ? 1 : 0),
    matchPoints: (old?.matchPoints || 0) + (won ? roundPoints(app.state) : 0),
  };
}
function matchPreview() {
  if (app.room?.players?.[app.playerIndex]?.matchWins == null) return null;
  return { my: carriedTally(app.playerIndex), their: carriedTally(1 - app.playerIndex) };
}
function renderMatchChip() {
  const chip = $('match-chip'); if (!chip) return;
  const has = app.room?.players?.[app.playerIndex]?.matchWins != null;
  chip.classList.toggle('hidden', !has);
  if (!has) return;
  const my = app.room.players[app.playerIndex].matchPoints || 0;
  const their = app.room.players[1 - app.playerIndex]?.matchPoints || 0;
  chip.textContent = `Match ${my}–${their} pts`;
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
  app.oppOnline = present.has(String(1 - app.playerIndex)); renderOppPanel();
  if (app.oppOnline && !seatName(app.room, 1 - app.playerIndex)) { try { app.room = await fetchRoom(app.code); renderAll(); } catch { /* ignore */ } }
}
function handleRoomUpdate(room) {
  const hadSecond = (app.room?.player_count ?? 0) >= 2; app.room = room;
  if (room.status === 'finished' && room.result && app.state && !app.state.gameOver) { applyStoredResult(app.state, room.result); app.finishPersisted = true; renderAll(); return; }
  app.timeKey = roomTimeKey(room);
  if (room.last_move_at) { const t = Date.parse(room.last_move_at); if (!Number.isNaN(t)) app.turnAnchorMs = t; }
  if (!hadSecond && room.player_count >= 2) renderAll(); else { if (app.state) renderOppPanel(); renderOverlays(); }
}

function announceLastMove() {
  const lm = app.state.lastMove; if (!lm) { setStatus(''); return; }
  const who = lm.player === app.playerIndex ? 'You' : playerName(lm.player);
  if (lm.type === 'move') { const hits = lm.steps.filter((s) => s.hit).length; setStatus(`${who} rolled ${lm.dice.join('-')}${hits ? ` and hit ${hits}` : ''}.`); }
  else if (lm.type === 'start') setStatus(`Game on! ${playerName(lm.first)} rolls first.`);
  else if (lm.type === 'resign') setStatus(`${who} resigned — game over.`);
  else if (lm.type === 'timeout') setStatus(`${playerName(lm.player)} ran out of time — game over.`);
  if (isMyTurn()) { if (app.rolled) announceRoll(); else setStatus('Tap the dice to roll.'); }
}

// ---- Helpers ----------------------------------------------------------------

function playerName(idx) { if (!app.room) return '?'; return seatName(app.room, idx) ?? 'Opponent'; }
function isMyTurn() { return app.state.started && !app.state.gameOver && app.state.turn === app.playerIndex; }
function boardFlipped() { return app.playerIndex === 1; }
function setStatus(msg) { $('status-line').textContent = msg; }

// ---- Turn building ----------------------------------------------------------

function syncTurn() {
  if (!app.state) return;
  const s = app.state;
  if (isMyTurn()) {
    if (app.turnInitFor !== s.turnIndex) initTurn();
    app.oppInitFor = -1;
  } else {
    app.work = null; app.steps = []; app.selected = null; app.turnInitFor = -1;
    // The opponent's dice roll themselves (on their side of the board) the moment
    // it becomes their turn — once per turn.
    if (s.started && !s.gameOver && s.turn != null) {
      if (app.oppInitFor !== s.turnIndex) initOppTurn();
    } else { resetRoll(); app.oppInitFor = -1; }
  }
}
function initOppTurn() {
  app.oppInitFor = app.state.turnIndex;
  app.turnDice = currentDice(app.state).slice();
  resetRoll();
  beginTumble(settleRoll);          // auto-roll for the opponent (no tap)
}
function initTurn() {
  const seat = app.playerIndex;
  app.turnDice = currentDice(app.state).slice();
  app.work = { board: app.state.board.slice(), bar: app.state.bar.slice(), off: app.state.off.slice(), dice: app.turnDice.slice() };
  app.steps = []; app.selected = null;
  app.maxDice = maxDiceUsable(app.state.board, app.state.bar, app.state.off, seat, app.turnDice);
  app.turnInitFor = app.state.turnIndex;
  resetRoll();                         // a fresh turn starts unrolled — tap to roll
  if (app.work.bar[seat] > 0) app.selected = 'bar';
}
function resetRoll() {
  if (app.rollTimer) { clearTimeout(app.rollTimer); app.rollTimer = null; }
  app.rolled = false; app.rolling = false; app.rollFaces = null;
  app.justLanded = false; app.rolledPairOnly = false; app.dupLanded = false;
}

// The dice values are already known (seed-derived); the roll is a purely cosmetic
// reveal. Show tumbling faces (Math.random is fine — never stored, never fed to
// the engine), fast then slowing, then settle on the real pips with a pop.
const rollFace = () => 1 + Math.floor(Math.random() * 6);
// Shared tumble used for BOTH players' dice: fast then slowing, then `onSettle`.
function beginTumble(onSettle) {
  app.rolling = true;
  const delays = [70, 70, 80, 95, 115, 140, 170, 210, 260]; // ease-out tumble ≈ 1.2s
  let i = 0;
  const step = () => {
    app.rollFaces = [rollFace(), rollFace()];
    renderBoard();
    if (i < delays.length) { app.rollTimer = setTimeout(step, delays[i++]); }
    else onSettle();
  };
  step();
}
function startRoll() {                 // my turn, triggered by tapping the idle dice
  if (!isMyTurn() || !app.work || app.rolled || app.rolling) return;
  beginTumble(settleRoll);
}
function settleRoll() {
  app.rollTimer = null; app.rolling = false; app.rolled = true; app.rollFaces = null;
  if (app.turnDice.length === 4) {
    // Doubles: land as a PAIR first, then split that pair into four dice.
    app.rolledPairOnly = true; app.justLanded = true;
    renderBoard(); app.justLanded = false;
    app.rollTimer = setTimeout(() => {
      app.rollTimer = null; app.rolledPairOnly = false; app.dupLanded = true;
      renderAll(); announceRoll();
      app.dupLanded = false;
    }, 430);
  } else {
    app.justLanded = true;               // this one render plays the landing pop
    renderAll(); announceRoll();
    app.justLanded = false;
  }
}
function rolledFacesText() {
  return app.turnDice.length === 4 ? `${app.turnDice[0]} & ${app.turnDice[0]} — doubles!` : app.turnDice.join(' & ');
}
// Status after a roll settles — worded for whoever just rolled.
function announceRoll() {
  if (isMyTurn()) {
    setStatus(app.maxDice === 0
      ? `You rolled ${rolledFacesText()} — no legal moves, press Pass.`
      : `You rolled ${rolledFacesText()} — make your move.`);
  } else {
    setStatus(`${playerName(app.state.turn)} rolled ${rolledFacesText()}.`);
  }
}
function rebuildWork() {
  const seat = app.playerIndex;
  app.work = { board: app.state.board.slice(), bar: app.state.bar.slice(), off: app.state.off.slice(), dice: app.turnDice.slice() };
  for (const st of app.steps) {
    const r = stepResult(app.work.board, app.work.bar, app.work.off, seat, st, app.work.dice);
    if (r) { app.work.board = r.board; app.work.bar = r.bar; app.work.off = r.off; app.work.dice = removeDie(app.work.dice, r.die); }
  }
  app.selected = app.work.bar[seat] > 0 ? 'bar' : null;
}
function workSteps() { return legalStepList(app.work.board, app.work.bar, app.work.off, app.playerIndex, app.work.dice); }

function onPoint(t) {
  if (!isMyTurn() || !app.work || !app.rolled || app.rolling || app.rolledPairOnly) return;
  const seat = app.playerIndex;
  const source = app.work.bar[seat] > 0 ? 'bar' : app.selected;
  if (source != null) {
    const m = workSteps().find((s) => s.from === source && s.to === t);
    if (m) { applyStep(source, t); return; }
  }
  if (app.work.bar[seat] > 0) return; // must play from the bar; tap a highlighted target
  if (t !== 'bar' && t !== 'off' && ownerAt(app.work.board, t) === seat && workSteps().some((s) => s.from === t)) { app.selected = t; renderAll(); return; }
  app.selected = null; renderAll();
}
function applyStep(source, to) {
  const seat = app.playerIndex;
  const r = stepResult(app.work.board, app.work.bar, app.work.off, seat, { from: source, to }, app.work.dice);
  if (!r) return;
  app.work.board = r.board; app.work.bar = r.bar; app.work.off = r.off; app.work.dice = removeDie(app.work.dice, r.die);
  app.steps.push({ from: source, to });
  app.selected = app.work.bar[seat] > 0 ? 'bar' : null;
  if (!app.confirmMoves && app.maxDice > 0 && app.steps.length === app.maxDice) { doneTurn(); return; }
  renderAll();
}

// ---- Drag and drop (board.js queries these before/at a checker drag) -------
// Pure — never mutate app state — so board.js can safely call them at
// pointerdown time to decide whether a press even COULD start a drag, and
// live while the pointer moves to know the legal drop set. Mirrors the exact
// eligibility check already inlined in onPoint's "select a new source"
// branch, extracted rather than duplicated with different logic.
function isDragSource(t) {
  if (!isMyTurn() || !app.work || !app.rolled || app.rolling || app.rolledPairOnly) return false;
  const seat = app.playerIndex;
  if (app.work.bar[seat] > 0) return t === 'bar';
  if (t === 'bar' || t === 'off') return false;
  return ownerAt(app.work.board, t) === seat && workSteps().some((s) => s.from === t);
}
function dragTargetsFor(t) { return workSteps().filter((s) => s.from === t).map((s) => s.to); }
// A drag's (from, to) is unambiguous by construction — apply it directly
// rather than through onPoint's two-tap disambiguation, which resolves
// against app.selected (a PRIOR tap) that a fresh drag gesture doesn't have
// and must not inherit (see the comment on this in board.js).
function onDrop(from, to) {
  if (!isDragSource(from) || !dragTargetsFor(from).includes(to)) return;
  applyStep(from, to);
}
$('btn-undo').addEventListener('click', () => { if (!app.steps.length) return; app.steps.pop(); rebuildWork(); renderAll(); });
$('btn-done').addEventListener('click', doneTurn);
function doneTurn() {
  if (!isMyTurn() || app.steps.length !== app.maxDice) return;
  submitMove('move', { steps: app.steps.map((s) => ({ from: s.from, to: s.to })) });
}

async function submitMove(type, payload) {
  const move = { move_index: app.state.moveCount, player: app.playerIndex, type, payload };
  applyMove(app.state, move);
  app.conn.setNextIndex(app.state.moveCount);
  app.turnAnchorMs = Date.now(); moveTimer?.resetClaim();
  app.steps = []; app.selected = null; app.work = null; app.turnInitFor = -1;
  renderAll(); announceLastMove();
  try { await app.conn.sendMove(move); pushOpponentIfTheirTurn(); maybeFinish(); }
  catch (e) {
    setStatus(`Could not save your move (${e.message}). Re-syncing…`);
    const moves = await fetchMoves(app.code); app.state = replayMoves(app.room.seed, moves);
    app.conn.setNextIndex(app.state.moveCount); app.turnInitFor = -1; renderAll();
  }
}

// Backgammon's own stakes convention: a plain win is 1 point, a gammon 2, a
// backgammon 3 (s.endDetail.margin, already computed by classifyWin() in the
// engine for a normal bear-off finish). Resign/timeout have no margin — count
// as a plain 1-point win. Shared by maybeFinish (this round's result) and
// carriedTally (the running match total).
function roundPoints(s) { return { single: 1, gammon: 2, backgammon: 3 }[s.endDetail?.margin] ?? 1; }

async function maybeFinish() {
  if (!app.state?.gameOver || app.finishPersisted) return;
  app.finishPersisted = true; const s = app.state;
  const points = roundPoints(s);
  const scores = s.winner === 0 ? [points, 0] : [0, points];
  const result = { winner: s.winner, scores, reason: s.endDetail?.reason ?? null, endDetail: s.endDetail ?? null };
  try { await finishRoom(app.code, result, true); if (app.room) { app.room.status = 'finished'; app.room.result = result; } app.conn?.broadcastRoom(app.room); } catch { app.finishPersisted = false; }
}
function applyStoredResult(stateObj, result) {
  stateObj.started = true; stateObj.gameOver = true; stateObj.winner = result.winner;
  stateObj.endDetail = result.endDetail || (result.reason ? { reason: result.reason } : null);
}

$('btn-start').addEventListener('click', async () => {
  $('btn-start').disabled = true;
  try { await submitMove('start', { tpm: TIME_CONTROLS[roomTimeKey(app.room)] || 0 }); await updateRoomStatus(app.code, 'playing'); app.room.status = 'playing'; app.conn.broadcastRoom(app.room); renderOverlays(); }
  finally { $('btn-start').disabled = false; }
});

// ---- Per-move clock ---------------------------------------------------------

let moveTimer = null;
function ensureTimer() {
  if (moveTimer) return;
  moveTimer = createMoveTimer({
    elMy: $('my-clock'), elOpp: $('opp-clock'), mySeat: () => app.playerIndex,
    context: () => ({ tpm: app.state?.started ? (app.state.tpm || 0) : (TIME_CONTROLS[roomTimeKey(app.room)] || 0), live: !!(app.state?.started && !app.state.gameOver && (app.room?.player_count ?? 0) >= 2), turn: app.state?.turn, anchorMs: app.turnAnchorMs }),
    onFlag: (seat) => claimTimeout(seat),
  });
}
function startClockTicker() { ensureTimer(); moveTimer.resetClaim(); moveTimer.start(); }
function stopClockTicker() { moveTimer?.stop(); }
async function claimTimeout(flaggedSeat) {
  if (!app.state || app.state.gameOver) return;
  await submitMove('timeout', { player: flaggedSeat });
  if (flaggedSeat !== app.playerIndex) triggerPush({ room_code: app.code, player: 1 - app.playerIndex, title: 'Backgammon — game over', body: `You ran out of time — ${app.name} wins.`, url: location.href.split('#')[0] }).catch(() => {});
  if (app.userId && app.state.gameOver && app.state.winner !== app.playerIndex) dismissGame(app.userId, app.code);
}

// ---- Rendering --------------------------------------------------------------

function renderAll() { syncTurn(); renderBoard(); renderOppPanel(); renderMyPanel(); renderControls(); renderOverlays(); renderClocks(); renderMatchChip(); }
function renderMyOnline() { const dot = $('my-online'); if (!dot) return; const live = app.connMode === 'live'; dot.className = `online-dot ${live ? 'online' : 'syncing'}`; dot.title = live ? 'Connected — moves arrive instantly' : 'Syncing through the database'; }

function diceView() {
  const s = app.state; if (!s.started || s.gameOver || s.turn == null) return [];
  if (app.rolling) return (app.rollFaces || [1, 1]).map((v) => ({ value: v, used: false }));
  if (app.rolledPairOnly) { const v = app.turnDice[0]; return [{ value: v, used: false }, { value: v, used: false }]; }
  if (isMyTurn() && app.work) {
    if (!app.rolled) return [{ value: null, used: false }, { value: null, used: false }]; // idle → two "?"
    const remaining = app.work.dice.slice();
    return app.turnDice.map((v) => { const i = remaining.indexOf(v); if (i >= 0) { remaining.splice(i, 1); return { value: v, used: false }; } return { value: v, used: true }; });
  }
  // The opponent's dice (their full roll, shown on their side).
  return currentDice(s).map((v) => ({ value: v, used: false }));
}
function diceStateNow() {
  if (app.rolling) return 'rolling';
  if (app.dupLanded) return 'dup';
  if (app.justLanded) return 'landed';
  if (isMyTurn() && app.work && !app.rolled) return 'idle';
  return 'done';
}
function highlights() {
  if (!isMyTurn() || !app.work || !app.rolled || app.rolledPairOnly) return {};
  const seat = app.playerIndex;
  const steps = workSteps();
  const sel = app.work.bar[seat] > 0 ? 'bar' : app.selected;
  if (sel != null) return { selected: sel, targets: steps.filter((s) => s.from === sel).map((s) => s.to) };
  return { sources: [...new Set(steps.map((s) => s.from).filter((x) => x !== 'bar'))], selected: null };
}
function renderBoard() {
  if (!goboard) return;
  const s = app.state;
  goboard.setInteractive(isMyTurn());
  const pos = (isMyTurn() && app.work) ? app.work : { board: s.board, bar: s.bar, off: s.off };
  // Dice sit on the roller's side of the board and take the roller's checker
  // colour, so it's unmistakable whose dice they are.
  const diceSide = isMyTurn() ? 'me' : 'opp';
  const diceColor = (s.started && s.turn != null) ? colorOf(s, s.turn) : 'w';
  goboard.render({
    board: pos.board, bar: pos.bar, off: pos.off, flipped: boardFlipped(),
    dice: diceView(), diceState: diceStateNow(), diceSide, diceColor, highlights: highlights(),
  });
}

function sideGlyph(seat) { return `<span class="side-glyph ${colorOf(app.state, seat)}"></span>`; }
function renderMaterial(el, seat) {
  if (!app.state.started) { el.innerHTML = ''; return; }
  const off = app.state.off[seat], bar = app.state.bar[seat], pip = pipCount(app.state, seat);
  el.innerHTML = `<span>${off}/15 off</span><span class="adv">pip ${pip}</span>${bar ? `<span class="adv">bar ${bar}</span>` : ''}`;
}
function renderOppPanel() {
  const oppIdx = 1 - app.playerIndex, hasOpp = !!seatName(app.room, oppIdx), nameEl = $('opp-name');
  const nm = hasOpp ? `${sideGlyph(oppIdx)}<span class="nm">${esc(playerName(oppIdx))}</span>` : '<span class="nm">Waiting for opponent…</span>';
  nameEl.innerHTML = (hasOpp && seatLeft(app.room, oppIdx) && !app.state.gameOver) ? `${nm} <span class="left-tag">offline</span>` : nm;
  renderMaterial($('opp-material'), oppIdx);
  const oppTurn = app.state.started && !app.state.gameOver && app.state.turn === oppIdx;
  $('opp-turn').classList.toggle('hidden', !oppTurn);
  $('opp-panel')?.classList.toggle('active-turn', oppTurn);
  const dot = $('opp-online'); dot.className = `online-dot ${app.oppOnline ? 'online' : 'offline'}`; dot.title = app.oppOnline ? 'online' : 'offline';
}
function renderMyPanel() {
  $('my-name').innerHTML = `${sideGlyph(app.playerIndex)}<span class="nm">${esc(app.name)} (you)</span>`;
  renderMaterial($('my-material'), app.playerIndex);
  $('my-turn').classList.toggle('hidden', !isMyTurn());
  $('my-name').closest('.player-panel')?.classList.toggle('active-turn', isMyTurn());
  renderMyOnline();
}
function renderControls() {
  const canAct = (app.room?.player_count ?? 0) >= 2 && app.state.started && !app.state.gameOver;
  $('btn-resign').classList.toggle('hidden', !canAct);
  const my = isMyTurn();
  // Hide the turn controls until the dice have been rolled — before that the
  // player shouldn't see "Pass"/move count (it would reveal the roll's outcome).
  const acting = my && app.rolled && !app.rolledPairOnly;
  const done = $('btn-done'), undo = $('btn-undo');
  done.classList.toggle('hidden', !acting);
  const complete = acting && app.steps.length === app.maxDice;
  done.disabled = !complete;
  done.textContent = app.maxDice === 0 ? 'Pass' : 'Done';
  undo.classList.toggle('hidden', !(acting && app.steps.length));
  if (acting && app.maxDice === 0) setStatusOnce('No legal moves — press Pass.');
}
let lastAutoStatus = '';
function setStatusOnce(msg) { if (lastAutoStatus !== msg) { lastAutoStatus = msg; setStatus(msg); } }
function renderClocks() { moveTimer?.refresh(); }

function renderOverlays() {
  const startOv = $('start-overlay'), goOv = $('gameover-overlay');
  if (app.state.gameOver) { startOv.classList.add('hidden'); goOv.classList.remove('hidden'); renderGameOver(); return; }
  goOv.classList.add('hidden');
  if (app.state.started) { startOv.classList.add('hidden'); return; }
  startOv.classList.remove('hidden');
  const haveGuest = !!seatName(app.room, 1);
  $('start-time').textContent = TIME_LABELS[roomTimeKey(app.room)] || '';
  $('start-share').classList.toggle('hidden', haveGuest); $('start-code').textContent = app.code;
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
  $('gameover-title').textContent = s.winner === me ? 'You win! 🎉' : `${playerName(s.winner)} wins`;
  const margin = s.endDetail?.margin;
  let detail = 'Game over.';
  if (s.endDetail?.reason === 'borne-off') detail = margin === 'backgammon' ? 'A backgammon — triple stakes!' : margin === 'gammon' ? 'A gammon — double stakes!' : 'All checkers borne off.';
  else if (s.endDetail?.reason === 'resign') detail = 'By resignation.';
  else if (s.endDetail?.reason === 'timeout') detail = 'On time.';
  let html = `<p class="gameover-reason">${esc(detail)}</p>`;
  const mp = matchPreview();
  if (mp) {
    const lead = mp.my.matchPoints > mp.their.matchPoints ? 'you lead' : mp.my.matchPoints < mp.their.matchPoints ? `${playerName(1 - me)} leads` : 'tied';
    html += `<p class="gameover-match">Match: ${mp.my.matchPoints}–${mp.their.matchPoints} pts · ${esc(lead)}</p>`;
  }
  $('gameover-detail').innerHTML = html;
}

// ---- Confirmation dialog ----------------------------------------------------

let confirmResolver = null;
function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  $('bg-confirm-title').textContent = title; $('bg-confirm-message').textContent = message;
  const okBtn = $('bg-confirm-ok'); okBtn.textContent = confirmText; okBtn.classList.toggle('btn-danger', danger); okBtn.classList.toggle('btn-primary', !danger);
  $('modal-confirm').classList.remove('hidden');
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function settleConfirm(v) { if (!confirmResolver) return; $('modal-confirm').classList.add('hidden'); const r = confirmResolver; confirmResolver = null; r(v); }
$('bg-confirm-ok').addEventListener('click', () => settleConfirm(true));
$('bg-confirm-cancel').addEventListener('click', () => settleConfirm(false));
$('modal-confirm').addEventListener('click', (e) => { if (e.target.id === 'modal-confirm') settleConfirm(false); });

// ---- Boot -------------------------------------------------------------------

async function boot() {
  registerServiceWorker();
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  renderNotifyBtns();
  app.confirmMoves = confirmEnabled(GAME_SLUG, true);
  injectConfirmToggle(GAME_SLUG, true, (on) => { app.confirmMoves = on; });


  if (!configReady()) {
    landingError('Setup needed: set the API endpoint in shared/api-config.js (see README).');
    $('btn-create').disabled = true; $('btn-join').disabled = true; window.LBBoot?.done(); return;
  }
  app.user = cachedUser(); app.userId = app.user?.id ?? null; if (app.user) app.name = displayName(app.user);
  applyAuthToUI(); if (app.user && notifyEnabled()) refreshPushSub();
  const resumed = await tryResume();
  if (!resumed && app.user) { showScreen('lobby'); renderLobby(); }
  onAuthChange(handleAuthChange);
  window.LBBoot?.done();
}
boot();
