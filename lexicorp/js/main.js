// Lexicorp — turn-based word/patent/stock game over the shared rooms layer.
// Reuses the shared rooms/account system (account-ui.js handles login, profile,
// friends and the menu); this module owns the landing/lobby flow and the
// turn-based gameplay.
//
// Networking model: deterministic lockstep. Both clients build the same deck
// from the room seed and replay the same ordered move log (one move per turn),
// so the full game state is reproduced everywhere with no server authority.
// Each player only ever sees their own hand.

import {
  initialState, applyMove, validatePlay, whoseTurn, letterOf,
  finalStandings, winnerSeat, patentValueOf, PATENTS, POWER_TEXT,
  endThreshold,
} from './engine.js';
import { loadDictionary, isWord, dictionaryLoaded } from './dictionary.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMyRooms, updateRoomStatus,
  finishRoom, RoomConnection, triggerPush, seatName, seatLeft, markPlayerLeft,
} from './net.js';
import { createRematch } from '../../shared/rematch.js';
import { configReady, GAME_SLUG, GAME_NAME } from './config.js';
import { currentUser, onAuthChange, displayName } from '../../shared/auth.js';
import { openHistory } from '../../shared/history.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';
import { getGuestName } from '../../shared/guest-name.js';
import {
  registerServiceWorker, requestNotifications, subscribeToPush,
  showTurnNotification, clearTurnNotification, isEnabled as notifyEnabled,
} from './notify.js';

const $ = (id) => document.getElementById(id);
const NUM_PLAYERS = 2;            // head-to-head
const SESSION_KEY = 'lexicorp_session';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const app = {
  user: null, userId: null, name: null,
  code: null, seat: null, room: null, conn: null,
  game: null,              // engine state (deterministic, rebuilt from moves)
  started: false,
  phase: 'idle',           // idle | waiting | playing | results
  online: new Set(),
  nextExpected: 0,         // next move_index to apply
  buffer: new Map(),       // move_index -> move, for out-of-order delivery
  draft: null,             // current turn's working selection (see freshDraft)
  rematching: false,
  resultPersisted: false,
  wasMyTurn: false,        // to fire the "your turn" notification on the edge
};

function freshDraft() {
  return { cards: [], appendS: false, second: null, activeTray: 'main', buy: null, qDiscard: null, doubledId: null };
}

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
    const room = await createRoom(name, app.userId, null, NUM_PLAYERS);
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
    const room = await createRoom(app.name, app.userId, null, NUM_PLAYERS);
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
  card.className = 'lobby-game' + (live ? ' live' : '');
  card.innerHTML = `<span class="lobby-opp">${esc(label)}</span><span class="lobby-status">${esc(status)}</span>`
    + `<span class="lobby-score">${room.code}</span>`;
  card.addEventListener('click', () => (
    finished ? openHistory({ userId: app.userId, gameSlug: GAME_SLUG }) : openFromLobby(room)
  ));
  card.appendChild(makeDismissControl({
    userId: app.userId, code: room.code, card,
    onRemoved: () => { if (!$('lobby-list').children.length) renderLobby(); },
  }));
  return card;
}

async function openFromLobby(room) {
  try {
    const { room: updated, playerIndex } = await joinRoom(room.code, app.name, app.userId);
    await enterRoom(room.code, playerIndex, app.name, updated);
  } catch (e) { $('lobby-error').textContent = e.message; }
}

// ---- Challenge a friend ---------------------------------------------------

async function challengeFriend(friend) {
  try {
    const room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name }, NUM_PLAYERS);
    triggerPush({ user_id: friend.id, title: 'Lexicorp challenge!', body: `${app.name} challenged you to Lexicorp.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { $('lobby-error').textContent = e.message; }
}

// ---- Entering / leaving a room --------------------------------------------

function resetRoomState() {
  stopSafetyPoll();
  if (app.conn) { app.conn.close(); app.conn = null; }
  app.game = null;
  app.started = false;
  app.phase = 'idle';
  app.online = new Set();
  app.nextExpected = 0;
  app.buffer = new Map();
  app.draft = freshDraft();
  app.rematching = false;
  app.resultPersisted = false;
  app.wasMyTurn = false;
  if ($('btn-rematch')) $('btn-rematch').disabled = false;
}

async function enterRoom(code, seat, name, room) {
  resetRoomState();
  app.code = code; app.seat = seat; app.name = name; app.room = room;
  app.game = initialState(Number(room.seed), NUM_PLAYERS);
  $('room-code-text').textContent = code;
  showScreen('game');
  app.phase = 'waiting';
  if (typeof Notification !== 'undefined') $('btn-notify').classList.toggle('hidden', notifyEnabled());
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name }));
  loadDictionary().catch(() => {});

  // A finished room renders straight from its stored result (no replay needed).
  if (room.status === 'finished' && room.result) {
    app.phase = 'results';
    renderResultsFrom(room.result);
  }

  renderAll();

  app.conn = new RoomConnection(code, seat, name, {
    onMove: handleMove,
    onPresence: handlePresence,
    onMode: () => {},
    onRoomUpdate: handleRoomUpdate,
  });
  app.conn.connect();
  startSafetyPoll();
  notifyWorkerVisible(true);
}

// Safety net for turn-based play: the shared connection only polls in DB mode,
// so on a live websocket a dropped 'move' broadcast would leave us stuck on the
// opponent's turn forever (board visible, nothing to do). While a game is live
// we re-pull the move log on a slow timer so missed moves always catch up.
let safetyPoll = null;
function startSafetyPoll() {
  stopSafetyPoll();
  safetyPoll = setInterval(() => {
    if (!app.conn || !app.started || app.game?.ended || document.hidden) return;
    if (app.conn.mode === 'live') app.conn.pollOnce?.().catch(() => {});
  }, 4000);
}
function stopSafetyPoll() { if (safetyPoll) { clearInterval(safetyPoll); safetyPoll = null; } }

$('btn-leave').addEventListener('click', leaveRoom);
$('btn-prestart-leave').addEventListener('click', leaveRoom);
async function leaveRoom() {
  if (app.code != null && app.seat != null && app.room && app.room.status !== 'finished') {
    try { const room = await markPlayerLeft(app.code, app.seat); if (room) app.conn?.broadcastRoom(room); } catch { /* best effort */ }
  }
  sessionStorage.removeItem(SESSION_KEY);
  notifyWorkerVisible(false);
  clearTurnNotification();
  resetRoomState();
  app.code = null; app.seat = null; app.room = null;
  if (app.user) { showScreen('lobby'); renderLobby(); } else showScreen('landing');
}

$('room-code-chip').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(app.code); setStatus('Room code copied.'); } catch {}
});

$('btn-results-done').addEventListener('click', () => {
  if (app.code) dismissGame(app.userId, app.code);
  leaveRoom();
});

// ---- Move handling / replay ------------------------------------------------

function handleMove(move) {
  if (move.type === 'rematch') { rematch.follow(move.payload?.code); return; }
  app.buffer.set(move.move_index, move);
  drainBuffer();
}

// Apply buffered moves in strict index order so state is always consistent.
function drainBuffer() {
  let applied = false;
  while (app.buffer.has(app.nextExpected)) {
    const move = app.buffer.get(app.nextExpected);
    app.buffer.delete(app.nextExpected);
    applyOne(move);
    app.nextExpected += 1;
    app.conn?.setNextIndex(app.nextExpected);
    applied = true;
  }
  if (applied) {
    maybeNotifyTurn();
    renderAll();
    checkEnded();
  }
}

function applyOne(move) {
  if (move.type === 'start') {
    app.started = true;
    if (app.phase === 'waiting') app.phase = 'playing';
    if (app.room && app.room.status === 'waiting') app.room.status = 'playing';
    return;
  }
  if (move.type === 'play' || move.type === 'swap') {
    applyMove(app.game, move, dictionaryLoaded() ? isWord : undefined);
  }
}

function checkEnded() {
  if (app.game?.ended && app.phase !== 'results') {
    app.phase = 'results';
    renderResultsLive();
    persistResult();
  }
}

function handlePresence(set) {
  app.online = set;
  const known = (app.room?.players ?? []).length;
  let maxSeat = -1;
  set.forEach((k) => { const n = Number(k); if (Number.isFinite(n)) maxSeat = Math.max(maxSeat, n); });
  if (maxSeat + 1 > known) {
    fetchRoom(app.code).then((r) => { app.room = r; renderAll(); }).catch(() => {});
  }
  renderAll();
}

function handleRoomUpdate(room) {
  if (!room) return;
  app.room = room;
  if (room.status === 'finished' && room.result && app.phase !== 'results') {
    app.phase = 'results';
    renderResultsFrom(room.result);
  } else if (room.status === 'playing' && !app.started) {
    // The room says play is underway but we haven't applied the 'start' move
    // yet (e.g. a realtime broadcast was missed while we were connecting). Pull
    // the move log so the prestart overlay clears instead of stranding us on the
    // waiting screen — which, since the overlay covers the board, would read as
    // "I'm in a game but can't take my turn".
    app.conn?.pollOnce?.().catch(() => {});
  }
  renderAll();
}

// ---- Start ----------------------------------------------------------------

$('btn-start').addEventListener('click', async () => {
  if (app.started) return;
  const players = app.room?.players ?? [];
  if (players.length < NUM_PLAYERS) { setStartInfo('Waiting for an opponent to join…'); return; }
  $('btn-start').disabled = true;
  try {
    await app.conn.sendMove({ move_index: 0, player: 0, type: 'start', payload: { startAt: Date.now() } });
    updateRoomStatus(app.code, 'playing').catch(() => {});
    app.started = true;
    app.phase = 'playing';
    if (app.room) app.room.status = 'playing';
    app.nextExpected = 1;
    app.conn.setNextIndex(1);
    renderAll();
  } catch (e) { $('btn-start').disabled = false; setStartInfo(e.message || 'Could not start.'); }
});

// ---- Rematch --------------------------------------------------------------

const rematch = createRematch({
  state: app,
  createRoom: (name, userId) => createRoom(name, userId, null, NUM_PLAYERS),
  joinRoom, enterRoom,
  onError: (msg) => { setStatus(msg); },
});
$('btn-rematch').addEventListener('click', rematch.start);

// ---- Turn helpers ---------------------------------------------------------

function myTurn() {
  return app.started && app.game && !app.game.ended && whoseTurn(app.game) === app.seat;
}
function ownedPowersSet() {
  const set = new Set();
  if (!app.game) return set;
  for (const [letter, owner] of Object.entries(app.game.patents)) {
    if (owner === app.seat && PATENTS[letter].power) set.add(PATENTS[letter].power);
  }
  return set;
}

// The hand to display this turn, accounting for a pending Q discard/draw.
function displayHand() {
  const hand = app.game.hands[app.seat].slice();
  if (app.draft.qDiscard == null) return hand;
  const i = hand.indexOf(app.draft.qDiscard);
  if (i !== -1) hand.splice(i, 1);
  if (app.game.top < app.game.deck.length) hand.push(app.game.top);
  return hand;
}

function usageCount(id) {
  let n = 0;
  for (const c of app.draft.cards) if (c === id) n++;
  if (app.draft.second) for (const c of app.draft.second.cards) if (c === id) n++;
  return n;
}

function activeCards() {
  return app.draft.activeTray === 'second' && app.draft.second ? app.draft.second.cards : app.draft.cards;
}

function addCard(id) {
  if (!myTurn()) return;
  // Q discard mode: the next hand tile tapped is discarded for a fresh draw.
  if (app.draft.qMode) {
    if (app.game.hands[app.seat].includes(id)) {
      app.draft.qDiscard = id;
      app.draft.qMode = false;
      // Any references to the discarded card in the trays are dropped.
      app.draft.cards = app.draft.cards.filter((c) => c !== id);
      if (app.draft.second) app.draft.second.cards = app.draft.second.cards.filter((c) => c !== id);
      renderAll();
    }
    return;
  }
  const count = usageCount(id);
  if (count === 0) { activeCards().push(id); }
  else if (count === 1 && ownedPowersSet().has('X') && app.draft.doubledId == null) {
    activeCards().push(id); app.draft.doubledId = id;       // X: use one card twice
  } else { return; }
  renderAll();
}

function removeFromTray(tray, index) {
  const arr = tray === 'second' ? app.draft.second.cards : app.draft.cards;
  const [removed] = arr.splice(index, 1);
  if (removed === app.draft.doubledId && usageCount(removed) < 2) app.draft.doubledId = null;
  renderAll();
}

function clearDraft() { app.draft = freshDraft(); renderAll(); }
$('btn-clear').addEventListener('click', clearDraft);

// ---- Rendering ------------------------------------------------------------

function renderAll() {
  renderPlayers();
  renderTurnBanner();
  renderPatents();
  renderTiles('pool', app.game ? app.game.pool : [], 'pool');
  renderTiles('hand', app.game ? displayHand() : [], 'hand');
  renderTray();
  renderAbilityControls();
  updatePreview();
  renderOverlays();
}

function renderPlayers() {
  const strip = $('players-strip');
  const players = app.room?.players ?? [];
  strip.innerHTML = '';
  players.forEach((p) => {
    const seat = p.seat;
    const div = document.createElement('div');
    const isTurn = app.started && app.game && !app.game.ended && whoseTurn(app.game) === seat;
    div.className = 'pchip' + (seat === app.seat ? ' me' : '') + (isTurn ? ' turn' : '');
    const online = app.online.has(String(seat));
    const left = seatLeft(app.room, seat);
    const money = app.game ? app.game.money[seat] : 0;
    const stock = app.game ? app.game.stock[seat] : 0;
    const pv = app.game ? patentValueOf(app.game, seat) : 0;
    div.innerHTML =
      `<div class="prow"><span class="pdot ${online ? '' : 'off'}"></span>`
      + `<span class="pname">${esc(p.name || `P${seat + 1}`)}</span>`
      + (left ? '<span class="left-tag">left</span>' : '') + '</div>'
      + `<div class="pstats"><span title="Money">$${money}</span>`
      + `<span title="Stock">▣${stock}</span>`
      + `<span title="Patent value">©${pv}</span></div>`;
    strip.appendChild(div);
  });
}

function renderTurnBanner() {
  const el = $('turn-banner');
  if (!app.started || !app.game) { el.textContent = ''; el.className = 'turn-banner'; return; }
  if (app.game.ended) { el.textContent = 'GAME OVER'; el.className = 'turn-banner'; return; }
  const final = app.game.lastRound ? ' · FINAL ROUND' : '';
  if (myTurn()) { el.textContent = `YOUR TURN${final}`; el.className = 'turn-banner mine'; }
  else {
    const opp = seatName(app.room, whoseTurn(app.game)) || 'opponent';
    el.textContent = `${opp}'s turn…${final}`;
    el.className = 'turn-banner';
  }
}

function renderPatents() {
  const wrap = $('patents');
  wrap.innerHTML = '';
  const owned = app.game ? app.game.patents : {};
  // Buyable letters this turn (in the current valid word, unowned, affordable).
  const buyable = currentBuyable();
  for (const letter of Object.keys(PATENTS)) {
    const p = PATENTS[letter];
    const owner = owned[letter];
    const chip = document.createElement('div');
    let cls = 'pat';
    if (owner === app.seat) cls += ' own-me';
    else if (owner != null) cls += ' own-opp';
    if (p.power) cls += ' power';
    if (buyable.has(letter)) cls += ' buyable';
    if (app.draft.buy === letter) cls += ' selected';
    chip.className = cls;
    chip.innerHTML = `<span class="pat-l">${letter}</span><span class="pat-c">$${p.cost}</span>`;
    if (p.power) chip.title = POWER_TEXT[p.power];
    if (buyable.has(letter)) chip.addEventListener('click', () => toggleBuy(letter));
    wrap.appendChild(chip);
  }
  $('patent-hint').textContent = app.game
    ? `· reach ©${endThreshold(NUM_PLAYERS)} to end`
    : '';
}

// Generic tile renderer for pool/hand.
function renderTiles(elId, ids, kind) {
  const wrap = $(elId);
  wrap.innerHTML = '';
  const interactive = myTurn();
  ids.forEach((id) => {
    const tile = document.createElement('div');
    const used = usageCount(id) > 0;
    tile.className = 'tile' + (used ? ' used' : '') + (interactive ? ' tappable' : '');
    if (kind === 'hand' && app.draft.qMode && app.game.hands[app.seat].includes(id)) tile.className += ' q-target';
    tile.textContent = letterOf(app.game, id);
    if (interactive) tile.addEventListener('click', () => addCard(id));
    wrap.appendChild(tile);
  });
  if (!ids.length) wrap.innerHTML = '<span class="empty-note">—</span>';
}

function renderTray() {
  const target = $('word-target');
  if (app.draft.second) {
    target.classList.remove('hidden');
    target.innerHTML = trayToggle();
    $('second-wrap').classList.remove('hidden');
  } else {
    target.classList.add('hidden');
    $('second-wrap').classList.add('hidden');
  }
  fillTray('word-tray', app.draft.cards, 'main', app.draft.appendS);
  if (app.draft.second) fillTray('second-tray', app.draft.second.cards, 'second', app.draft.second.appendS);
}

function trayToggle() {
  const m = app.draft.activeTray === 'main' ? 'active' : '';
  const s = app.draft.activeTray === 'second' ? 'active' : '';
  return `<button class="tray-tab ${m}" data-tray="main">WORD 1</button>`
    + `<button class="tray-tab ${s}" data-tray="second">WORD 2</button>`;
}

function fillTray(elId, ids, tray, appendS) {
  const wrap = $(elId);
  wrap.innerHTML = '';
  ids.forEach((id, idx) => {
    const tile = document.createElement('div');
    tile.className = 'tile tray-tile' + (myTurn() ? ' tappable' : '');
    tile.textContent = letterOf(app.game, id);
    if (myTurn()) tile.addEventListener('click', () => removeFromTray(tray, idx));
    wrap.appendChild(tile);
  });
  if (appendS) {
    const s = document.createElement('div');
    s.className = 'tile tray-tile s-bonus';
    s.textContent = 'S';
    wrap.appendChild(s);
  }
  if (!ids.length && !appendS) wrap.innerHTML = '<span class="empty-note">Tap your letters to build a word</span>';
}

// Active-tray switch (delegated, since the toggle is re-rendered).
$('word-target').addEventListener('click', (e) => {
  const btn = e.target.closest('.tray-tab');
  if (!btn) return;
  app.draft.activeTray = btn.dataset.tray;
  renderAll();
});

function renderAbilityControls() {
  const wrap = $('ability-controls');
  wrap.innerHTML = '';
  if (!myTurn()) return;
  const owned = ownedPowersSet();
  const mk = (label, on, fn, title) => {
    const b = document.createElement('button');
    b.className = 'ability-btn' + (on ? ' on' : '');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    wrap.appendChild(b);
  };
  if (owned.has('Z')) mk(app.draft.appendS ? '✓ +S (Z)' : '+S (Z)', app.draft.appendS,
    () => { app.draft.appendS = !app.draft.appendS; renderAll(); }, POWER_TEXT.Z);
  if (owned.has('V')) mk(app.draft.second ? '✓ Second word (V)' : 'Second word (V)', !!app.draft.second,
    () => {
      if (app.draft.second) { app.draft.second = null; app.draft.activeTray = 'main'; }
      else { app.draft.second = { cards: [], appendS: false }; app.draft.activeTray = 'second'; }
      renderAll();
    }, POWER_TEXT.V);
  if (owned.has('Q')) mk(app.draft.qMode ? 'Tap a card to discard…' : 'Discard & draw (Q)', !!app.draft.qMode,
    () => {
      if (app.draft.qDiscard != null) { app.draft.qDiscard = null; app.draft.qMode = false; }
      else app.draft.qMode = !app.draft.qMode;
      renderAll();
    }, POWER_TEXT.Q);
  if (owned.has('X')) {
    const note = document.createElement('span');
    note.className = 'ability-note';
    note.textContent = 'X: tap a card twice to use it twice';
    wrap.appendChild(note);
  }
}

// Build the engine payload from the current draft.
function draftPayload() {
  const payload = { cards: app.draft.cards.slice(), appendS: app.draft.appendS };
  if (app.draft.second && app.draft.second.cards.length) {
    payload.second = { cards: app.draft.second.cards.slice(), appendS: app.draft.second.appendS };
  }
  if (app.draft.buy) payload.buy = app.draft.buy;
  if (app.draft.qDiscard != null) payload.qDiscard = app.draft.qDiscard;
  return payload;
}

// Which letters could be patented with the current word right now.
function currentBuyable() {
  const out = new Set();
  if (!myTurn()) return out;
  const res = validatePlay(app.game, app.seat, draftPayload(), dictionaryLoaded() ? isWord : undefined);
  if (!res.ok || !res.letters) return out;
  const projected = app.game.money[app.seat] + res.money;
  for (const letter of res.letters) {
    if (PATENTS[letter] && app.game.patents[letter] == null && projected >= PATENTS[letter].cost) out.add(letter);
  }
  return out;
}

function toggleBuy(letter) {
  app.draft.buy = app.draft.buy === letter ? null : letter;
  renderAll();
}

function updatePreview() {
  const prev = $('word-preview');
  const playBtn = $('btn-play');
  const clearBtn = $('btn-clear');
  const swapBtn = $('btn-swap');
  // Swap (the "stuck? redraw" relief valve) is available whenever it's your
  // turn. sendTurn() disables it during a submit; this re-enables it on the next
  // render so it's never left permanently dead after your first move.
  swapBtn.disabled = !myTurn();
  if (!myTurn()) { prev.textContent = ''; prev.className = 'word-preview'; playBtn.disabled = true; clearBtn.disabled = true; return; }
  const hasAny = app.draft.cards.length || (app.draft.second && app.draft.second.cards.length);
  clearBtn.disabled = !hasAny && app.draft.qDiscard == null;
  if (!hasAny) { prev.textContent = ''; prev.className = 'word-preview'; playBtn.disabled = true; return; }

  const res = validatePlay(app.game, app.seat, draftPayload(), dictionaryLoaded() ? isWord : undefined);
  if (!res.ok) {
    prev.textContent = res.error;
    prev.className = 'word-preview bad';
    playBtn.disabled = true;
    return;
  }
  const parts = res.words.map((w) => `${w.word} +$${w.money}${w.stock ? ` ▣${w.stock}` : ''}`);
  let txt = parts.join('   ·   ');
  if (app.draft.buy) txt += `   →  patent ${app.draft.buy} (−$${PATENTS[app.draft.buy].cost})`;
  prev.textContent = txt;
  prev.className = 'word-preview ok';
  playBtn.disabled = false;
}

$('btn-play').addEventListener('click', playWord);
async function playWord() {
  if (!myTurn()) return;
  const payload = draftPayload();
  const res = validatePlay(app.game, app.seat, payload, dictionaryLoaded() ? isWord : undefined);
  if (!res.ok) { setStatus(res.error); return; }
  if (!dictionaryLoaded()) { setStatus('Loading dictionary…'); await loadDictionary().catch(() => {}); }
  await sendTurn({ type: 'play', payload });
}

$('btn-swap').addEventListener('click', async () => {
  if (!myTurn()) return;
  await sendTurn({ type: 'swap', payload: {} });
});

// Apply a turn locally (optimistic) then persist+broadcast it.
async function sendTurn({ type, payload }) {
  const moveIndex = app.game.turn + 1;
  const move = { move_index: moveIndex, player: app.seat, type, payload };
  $('btn-play').disabled = true;
  $('btn-swap').disabled = true;
  try {
    applyMove(app.game, move, dictionaryLoaded() ? isWord : undefined);
    app.nextExpected = app.game.turn + 1;
    app.conn.setNextIndex(app.nextExpected);
    clearDraftSilent();
    renderAll();
    pushOpponent();
    checkEnded();
    await app.conn.sendMove(move);
  } catch (e) {
    setStatus(`Could not send move (${e.message}). It may retry on reconnect.`);
  }
}
function clearDraftSilent() { app.draft = freshDraft(); }

// ---- Results --------------------------------------------------------------

function renderResultsLive() {
  const rows = finalStandings(app.game).map((r) => ({ ...r, name: seatName(app.room, r.seat) || `P${r.seat + 1}` }));
  paintResults(rows, winnerSeat(app.game));
}
function renderResultsFrom(result) {
  const rows = (result.rows || []).map((r) => ({ ...r, name: seatName(app.room, r.seat) || `P${r.seat + 1}` }));
  if (!rows.length && result.scores) {
    result.scores.forEach((s, seat) => rows.push({ seat, score: s, money: s, stock: 0, patentValue: 0, name: seatName(app.room, seat) || `P${seat + 1}` }));
  }
  paintResults(rows, result.winner);
}

function paintResults(rows, winner) {
  app.phase = 'results';
  const ranked = rows.slice().sort((a, b) => b.score - a.score || b.patentValue - a.patentValue);
  const ol = $('results-list');
  ol.innerHTML = '';
  ranked.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.seat === app.seat) li.className = 'me';
    const left = seatLeft(app.room, r.seat) ? ' <span class="left-tag">left</span>' : '';
    li.innerHTML = `<span class="r-rank">${i + 1}</span>`
      + `<span class="r-name">${esc(r.name)}${left}</span>`
      + `<span class="r-breakdown">$${r.money} · ▣${r.stock} · ©${r.patentValue}</span>`
      + `<span class="r-score">${r.score}</span>`;
    ol.appendChild(li);
  });
  const winEl = $('results-winner');
  if (winner === 'tie') { winEl.textContent = "It's a tie!"; winEl.className = 'results-winner'; }
  else if (winner === app.seat) { winEl.textContent = 'You won!'; winEl.className = 'results-winner'; }
  else {
    const wn = seatName(app.room, winner) || `P${(winner ?? 0) + 1}`;
    winEl.textContent = `${wn} won`;
    winEl.className = 'results-winner loss';
  }
  renderOverlays();
}

async function persistResult() {
  if (app.resultPersisted || !app.code || !app.game) return;
  app.resultPersisted = true;
  const rows = finalStandings(app.game);
  const scores = rows.map((r) => r.score);
  const result = { scores, rows, winner: winnerSeat(app.game), reason: 'end' };
  try {
    await finishRoom(app.code, result, false);
    if (app.room) { app.room.status = 'finished'; app.room.result = result; }
    clearTurnNotification();
  } catch { app.resultPersisted = false; }
}

// ---- Overlays -------------------------------------------------------------

function renderOverlays() {
  // Once the game has started the prestart overlay must never show again — gate
  // on app.started too, so a stale phase can't leave it covering the board.
  const showPrestart = app.phase === 'waiting' && !app.started;
  $('prestart-overlay').classList.toggle('hidden', !showPrestart);
  $('results-overlay').classList.toggle('hidden', app.phase !== 'results');
  if (showPrestart) renderPrestart();
}

function renderPrestart() {
  const players = app.room?.players ?? [];
  const n = players.length;
  $('start-title').textContent = n >= NUM_PLAYERS ? 'READY?' : 'WAITING FOR PLAYERS';
  setStartInfo(`${n}/${NUM_PLAYERS} players in · share code <strong>${esc(app.code)}</strong>`);
  const host = app.seat === 0;
  $('btn-start').textContent = 'START GAME';
  $('btn-start').classList.toggle('hidden', !host);
  $('btn-start').disabled = n < NUM_PLAYERS;
  $('start-waiting').classList.toggle('hidden', host);
}
function setStartInfo(html) { $('start-info').innerHTML = html; }
function setStatus(msg) { $('status-line').textContent = msg || ''; }

// ---- "Your turn" notifications --------------------------------------------

function maybeNotifyTurn() {
  const mine = myTurn();
  if (mine && !app.wasMyTurn && app.started && document.hidden) {
    const opp = seatName(app.room, (app.seat + 1) % NUM_PLAYERS) || 'Your opponent';
    showTurnNotification(`${opp} played. Your move!`);
  }
  if (mine && !document.hidden) clearTurnNotification();
  app.wasMyTurn = mine;
}

function pushOpponent() {
  if (!app.room) return;
  const oppSeat = (app.seat + 1) % NUM_PLAYERS;
  const oppUserId = app.room.players?.[oppSeat]?.userId || null;
  const route = oppUserId ? { user_id: oppUserId } : { room_code: app.code, player: oppSeat };
  triggerPush({
    ...route,
    title: "Lexicorp — it's your turn",
    body: `${app.name} played their word.`,
    url: location.href.split('#')[0],
  }).catch(() => {});
}

$('btn-notify').addEventListener('click', async () => {
  const perm = await requestNotifications();
  if (perm === 'granted') {
    const route = app.userId ? { userId: app.userId } : { roomCode: app.code, player: app.seat };
    await subscribeToPush(route);
    setStatus('Turn notifications on.');
    $('btn-notify').classList.add('on');
  }
});

function notifyWorkerVisible(visible) {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'room-visible', visible, code: app.code });
  } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => {
  notifyWorkerVisible(!document.hidden && !!app.code);
  if (!document.hidden) { clearTurnNotification(); if (app.code) maybeNotifyTurn(); }
});

// ---- Resume / boot --------------------------------------------------------

async function tryResume() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return;
  try {
    const { code, name } = JSON.parse(raw);
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
  } catch { sessionStorage.removeItem(SESSION_KEY); }
}

async function boot() {
  registerServiceWorker();
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  if (!configReady()) { landingError('Setup needed: Supabase key missing.'); return; }
  try { app.user = await currentUser(); } catch {}
  app.userId = app.user?.id ?? null;
  app.name = playerName();
  $('btn-go-lobby').classList.toggle('hidden', !app.user);
  if (app.user) { showScreen('lobby'); renderLobby(); } else showScreen('landing');
  onAuthChange(onAuth);
  tryResume();
}

// Help modal close handlers (account-ui wires its own injected modals).
$('help-modal')?.addEventListener('click', (e) => { if (e.target === $('help-modal')) $('help-modal').classList.add('hidden'); });
$('help-close')?.addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-got-it')?.addEventListener('click', () => $('help-modal').classList.add('hidden'));

boot();
