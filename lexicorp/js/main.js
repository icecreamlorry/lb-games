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
import { cachedUser, onAuthChange, displayName } from '../../shared/auth.js';
import { openHistory } from '../../shared/history.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';
import { getGuestName } from '../../shared/guest-name.js';
import {
  registerServiceWorker, requestNotifications, subscribeToPush,
  showTurnNotification, clearTurnNotification, isEnabled as notifyEnabled,
} from './notify.js';

const $ = (id) => document.getElementById(id);
const MIN_PLAYERS = 2;           // host can start with as few as 2…
const MAX_PLAYERS = 5;           // …and as many as 5 (Letter Tycoon's range)
const SESSION_KEY = 'lexicorp_session';

// Guests keep the "resume this room" pointer in localStorage so they auto-return
// to their game after a full browser close (they have no server-side games
// list); signed-in players keep it tab-scoped in sessionStorage and rely on
// their lobby. See shared/guest-id.js for the matching persistent guest id.
function saveSession(data) {
  const raw = JSON.stringify(data);
  try {
    if (app.userId) { sessionStorage.setItem(SESSION_KEY, raw); localStorage.removeItem(SESSION_KEY); }
    else { localStorage.setItem(SESSION_KEY, raw); sessionStorage.removeItem(SESSION_KEY); }
  } catch { /* storage blocked — resume just won't persist */ }
}
function readSession() {
  try { return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY); }
  catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
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
  handOrder: [],           // local-only display order of my hand's card ids
  patInfo: null,           // letter whose patent details are open, or null
};

function freshDraft() {
  return {
    stage: 'word',          // 'word' (build) → 'buy' (review earnings + patent)
    cards: [], appendS: false, second: null, activeTray: 'main', buy: null,
    qDiscard: null, doubledId: null,
    yVowels: new Set(),     // Y card ids the player has declared vowels
    discardMode: false,     // choosing cards to discard instead of building a word
    discardSet: new Set(),  // hand card ids marked for discard
  };
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
    const room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name }, MAX_PLAYERS);
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
  app.handOrder = [];
  app.patInfo = null;
  if ($('btn-rematch')) $('btn-rematch').disabled = false;
}

// Build the deterministic game state once the player count is known (fixed at
// the moment the host starts and carried in the 'start' move, so every client
// — host, opponents, late replays — deals the same hands from the seed).
function beginGame(numPlayers) {
  app.game = initialState(Number(app.room.seed), numPlayers);
}

async function enterRoom(code, seat, name, room) {
  resetRoomState();
  app.code = code; app.seat = seat; app.name = name; app.room = room;
  // app.game stays null until the 'start' move sets the final player count.
  $('room-code-text').textContent = code;
  showScreen('game');
  app.phase = 'waiting';
  if (typeof Notification !== 'undefined') $('btn-notify').classList.toggle('hidden', notifyEnabled());
  saveSession({ code, name });
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
  clearSession();
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
    // Older 2-player games predate the player count in the payload — default to 2.
    if (!app.game) beginGame(move.payload?.players ?? 2);
    app.started = true;
    if (app.phase === 'waiting') app.phase = 'playing';
    if (app.room && app.room.status === 'waiting') app.room.status = 'playing';
    return;
  }
  if (move.type === 'play' || move.type === 'swap' || move.type === 'discard') {
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
  const n = players.length;
  if (n < MIN_PLAYERS) { setStartInfo('Waiting for players to join…'); return; }
  $('btn-start').disabled = true;
  try {
    await app.conn.sendMove({ move_index: 0, player: 0, type: 'start', payload: { startAt: Date.now(), players: n } });
    updateRoomStatus(app.code, 'playing').catch(() => {});
    beginGame(n);
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
  createRoom: (name, userId) => createRoom(name, userId, null, MAX_PLAYERS),
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

function seatNameOr(seat) { return seatName(app.room, seat) || `P${seat + 1}`; }

// The hand to display this turn, accounting for a pending Q discard/draw.
function displayHand() {
  const hand = app.game.hands[app.seat].slice();
  if (app.draft.qDiscard == null) return hand;
  const i = hand.indexOf(app.draft.qDiscard);
  if (i !== -1) hand.splice(i, 1);
  if (app.game.top < app.game.deck.length) hand.push(app.game.top);
  return hand;
}

// Apply (and refresh) the player's local drag-reorder over the current hand:
// keep the remembered order for cards still held, append anything newly drawn.
// Purely cosmetic — the engine never reads display order, so this stays local.
function orderedHand(ids) {
  const held = new Set(ids);
  const kept = app.handOrder.filter((id) => held.has(id));
  const seen = new Set(kept);
  for (const id of ids) if (!seen.has(id)) kept.push(id);
  app.handOrder = kept;
  return kept.slice();
}

// $ each OTHER player would collect in royalties from these cards (seat -> $).
function royaltyPreview(usedIds) {
  const out = new Map();
  for (const id of usedIds) {
    const owner = app.game.patents[letterOf(app.game, id)];
    if (owner != null && owner !== app.seat) out.set(owner, (out.get(owner) || 0) + 1);
  }
  return out;
}

// One line describing an applied log entry ("Bob played FIRE for $2, patented F").
function describeLog(entry, who) {
  if (!entry) return `${who} moved.`;
  if (entry.swap) return `${who} swapped their whole hand.`;
  if (entry.discard != null) return `${who} discarded ${entry.discard} card${entry.discard === 1 ? '' : 's'}.`;
  const words = (entry.words || []).map((w) => w.word).join(' + ') || '—';
  let txt = `${who} played ${words} for $${entry.money}${entry.stock ? ` + ▣${entry.stock}` : ''}`;
  if (entry.bought) txt += `, patented ${entry.bought}`;
  return txt + '.';
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
  // Discard mode: tapping a hand card toggles whether it's marked for discard.
  if (app.draft.discardMode) {
    if (!app.game.hands[app.seat].includes(id)) return; // only your own hand
    if (app.draft.discardSet.has(id)) app.draft.discardSet.delete(id);
    else app.draft.discardSet.add(id);
    renderAll();
    return;
  }
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
  syncDraftStage();
  renderPlayers();
  renderTurnBanner();
  renderLastMove();
  renderPatents();
  renderPowers();
  renderTiles('pool', app.game ? app.game.pool : [], 'pool');
  renderTiles('hand', app.game ? orderedHand(displayHand()) : [], 'hand');
  $('build-panel').classList.toggle('hidden', !myTurn());
  renderDiscardUI();
  renderStages();
  renderTray();
  renderAbilityControls();
  renderYControls();
  renderBuyRow();
  renderBuySummary();
  updatePreview();
  renderOverlays();
}

// The buy stage only makes sense while it's your turn and the word is still
// valid; anything else snaps the draft back to the word stage.
function syncDraftStage() {
  if (!app.draft || app.draft.stage !== 'buy') return;
  if (!myTurn()) { app.draft.stage = 'word'; return; }
  const p = draftPayload();
  delete p.buy; // the buy is re-checked separately (renderBuyRow clears a stale one)
  const res = validatePlay(app.game, app.seat, p, dictionaryLoaded() ? isWord : undefined);
  if (!res.ok) app.draft.stage = 'word';
}

function renderStages() {
  const buying = !!app.draft && app.draft.stage === 'buy';
  $('word-stage').classList.toggle('hidden', buying);
  $('buy-stage').classList.toggle('hidden', !buying);
}

// Persistent line under the turn banner announcing the last completed move,
// so you always see what your opponents just played (à la Wurdz).
function renderLastMove() {
  const el = $('last-move');
  const entry = app.game?.log?.[app.game.log.length - 1];
  if (!app.started || !entry || app.game.ended) { el.textContent = ''; el.classList.add('hidden'); return; }
  const who = entry.seat === app.seat ? 'You' : seatNameOr(entry.seat);
  let txt = describeLog(entry, who);
  const mine = entry.royalties?.[app.seat] || 0;
  if (entry.seat !== app.seat && mine > 0) txt += ` You collected $${mine} in royalties.`;
  el.textContent = txt;
  el.classList.remove('hidden');
}

// Your owned patent powers, listed whether or not it's your turn.
function renderPowers() {
  const panel = $('powers-panel');
  const list = $('powers-list');
  const owned = ownedPowersSet();
  panel.classList.toggle('hidden', !app.started || !owned.size);
  list.innerHTML = '';
  for (const p of Object.keys(POWER_TEXT)) {
    if (!owned.has(p)) continue;
    const div = document.createElement('div');
    div.className = 'power-chip';
    div.innerHTML = `<strong>${p}</strong> ${esc(POWER_TEXT[p])}`;
    list.appendChild(div);
  }
}

// Swap the build panel between "build a word" and "discard & redraw".
function renderDiscardUI() {
  const on = !!(app.draft && app.draft.discardMode);
  $('word-build').classList.toggle('hidden', on);
  $('discard-panel').classList.toggle('hidden', !on);
  if (on) {
    const n = app.draft.discardSet.size;
    $('btn-discard-go').textContent = `DISCARD (${n})`;
    $('btn-discard-go').disabled = n === 0;
  }
}

// Per-Y vowel/consonant toggles — shown only when a Y is in your word AND you own
// a power that cares about vowels (B/J/K); otherwise the choice has no effect.
function renderYControls() {
  const wrap = $('y-controls');
  wrap.innerHTML = '';
  if (!myTurn() || app.draft.discardMode) return;
  const owned = ownedPowersSet();
  if (!(owned.has('B') || owned.has('J') || owned.has('K'))) return;
  const seen = new Set();
  const yIds = [];
  const scan = (cards) => { for (const id of cards) if (letterOf(app.game, id) === 'Y' && !seen.has(id)) { seen.add(id); yIds.push(id); } };
  scan(app.draft.cards);
  if (app.draft.second) scan(app.draft.second.cards);
  if (!yIds.length) return;
  const note = document.createElement('span');
  note.className = 'ability-note';
  note.textContent = 'Y counts as:';
  wrap.appendChild(note);
  yIds.forEach((id) => {
    const isV = app.draft.yVowels.has(id);
    const b = document.createElement('button');
    b.className = 'ability-btn' + (isV ? ' on' : '');
    b.textContent = isV ? 'Y = vowel' : 'Y = consonant';
    b.addEventListener('click', () => {
      if (app.draft.yVowels.has(id)) app.draft.yVowels.delete(id);
      else app.draft.yVowels.add(id);
      renderAll();
    });
    wrap.appendChild(b);
  });
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
    if (app.patInfo === letter) cls += ' info-open';
    chip.className = cls;
    chip.innerHTML = `<span class="pat-l">${letter}</span><span class="pat-c">$${p.cost}${p.power ? '★' : ''}</span>`;
    if (p.power) chip.title = POWER_TEXT[p.power];
    // Tap any chip for its details (cost/owner/power) — hover isn't available
    // on touch screens. Buying happens in the turn's step 2, not here.
    chip.addEventListener('click', () => {
      app.patInfo = app.patInfo === letter ? null : letter;
      renderAll();
    });
    wrap.appendChild(chip);
  }
  renderPatInfo();
  $('patent-hint').textContent = app.game
    ? `· reach ©${endThreshold(app.game.numPlayers)} to end`
    : '';
}

function renderPatInfo() {
  const el = $('pat-info');
  const letter = app.patInfo;
  if (!letter || !PATENTS[letter]) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  const p = PATENTS[letter];
  const owner = app.game?.patents?.[letter];
  const ownerTxt = owner == null ? 'unowned'
    : owner === app.seat ? 'owned by you'
    : `owned by ${esc(seatNameOr(owner))}`;
  const powerTxt = p.power ? `★ ${esc(POWER_TEXT[p.power])}` : 'No special power — value and royalties only.';
  el.innerHTML = `<strong>${letter}</strong> · $${p.cost} · ${ownerTxt}<br>${powerTxt}`;
  el.classList.remove('hidden');
}

// Generic tile renderer for pool/hand.
function renderTiles(elId, ids, kind) {
  const wrap = $(elId);
  if (kind === 'hand' && handDragCleanup) handDragCleanup(); // re-render kills a live drag
  wrap.innerHTML = '';
  const discarding = !!(app.draft && app.draft.discardMode);
  const buying = !!(app.draft && app.draft.stage === 'buy');
  // Tap-to-build only while composing the word (step 1) on your turn; while
  // discarding you can only act on your own hand.
  const canTap = myTurn() && !buying && (kind === 'hand' || !discarding);
  // Only the pool greys out — your hand stays bright and drag-reorderable even
  // on an opponent's turn.
  wrap.classList.toggle('locked', kind === 'pool' && !canTap);
  ids.forEach((id) => {
    const tile = document.createElement('div');
    const used = !discarding && usageCount(id) > 0;
    const marked = discarding && kind === 'hand' && app.draft.discardSet.has(id);
    tile.className = 'tile' + (used ? ' used' : '') + (marked ? ' discarding' : '') + (canTap ? ' tappable' : '');
    if (!discarding && kind === 'hand' && app.draft.qMode && app.game.hands[app.seat].includes(id)) tile.className += ' q-target';
    tile.textContent = letterOf(app.game, id);
    if (canTap) tile.addEventListener('click', () => { if (suppressNextClick) return; addCard(id); });
    if (kind === 'hand') tile.addEventListener('pointerdown', (e) => startHandDrag(e, id));
    wrap.appendChild(tile);
  });
  if (!ids.length) wrap.innerHTML = '<span class="empty-note">—</span>';
}

// ---- Hand drag (pointer-based, mouse + touch) -------------------------------
//
// Dragging a hand tile within the hand reorders your letters (any time, even on
// an opponent's turn) — the other tiles slide aside to open a gap where the
// dragged tile will land, like Wurdz's rack. On your turn (step 1) a tile can
// also be dropped straight onto a word tray to add it to the word.

let suppressNextClick = false; // a drag's trailing click must not add a card
let handDragCleanup = null;    // tears down an in-progress drag on re-render

function startHandDrag(e, id) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (app.draft.discardMode || app.draft.qMode) return; // those modes are tap-driven

  const tileEl = e.currentTarget;
  const startX = e.clientX, startY = e.clientY;
  let active = false, ghost = null;
  let allTiles = [];  // every hand tile in display order (DOM index == order index)
  let slots = [];     // base center of each slot, captured before any shifting
  let gapIdx = null;  // current insertion index, or null when no gap is shown

  const canPlace = () => myTurn() && app.draft.stage !== 'buy';
  const trayUnder = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.closest('#word-tray, #second-tray');
  };
  const clearTrayHighlight = () => {
    document.querySelectorAll('.tiles.tray.drop-target').forEach((t) => t.classList.remove('drop-target'));
  };

  const showGap = (ins) => {
    if (ins === gapIdx) return;
    gapIdx = ins;
    let k = 0; // running index among the non-dragged tiles
    allTiles.forEach((t, fi) => {
      if (t === tileEl) return;
      const target = k < ins ? k : k + 1;
      t.style.transform = `translate(${slots[target].x - slots[fi].x}px, ${slots[target].y - slots[fi].y}px)`;
      k++;
    });
  };
  const hideGap = () => {
    if (gapIdx === null) return;
    gapIdx = null;
    allTiles.forEach((t) => { if (t !== tileEl) t.style.transform = ''; });
  };
  // Insertion index in reading order — the hand may wrap onto a second row on
  // narrow screens, so compare rows first, then x within the row.
  const insAt = (x, y) => {
    let n = 0;
    for (const s of slots) {
      if (y > s.y + s.h / 2) n++;
      else if (Math.abs(y - s.y) <= s.h / 2 && x > s.x) n++;
    }
    return Math.max(0, Math.min(n, slots.length - 1));
  };

  const onMove = (ev) => {
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
      active = true;
      tileEl.classList.add('drag-src');
      ghost = document.createElement('div');
      ghost.className = 'tile drag-ghost';
      ghost.textContent = letterOf(app.game, id);
      document.body.appendChild(ghost);
      allTiles = [...$('hand').querySelectorAll('.tile')];
      slots = allTiles.map((t) => {
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
      });
      allTiles.forEach((t) => { if (t !== tileEl) t.style.transition = 'transform 0.15s ease'; });
      handDragCleanup = teardown;
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
    clearTrayHighlight();
    const tray = canPlace() && usageCount(id) === 0 && trayUnder(ev.clientX, ev.clientY);
    if (tray) { tray.classList.add('drop-target'); hideGap(); return; }
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    if (el && el.closest('#hand')) showGap(insAt(ev.clientX, ev.clientY));
    else hideGap();
  };

  // Removes all drag DOM/listeners without committing anything.
  const teardown = () => {
    if (handDragCleanup === teardown) handDragCleanup = null;
    tileEl.removeEventListener('pointermove', onMove);
    tileEl.removeEventListener('pointerup', onUp);
    tileEl.removeEventListener('pointercancel', onCancel);
    if (ghost) { ghost.remove(); ghost = null; }
    clearTrayHighlight();
    allTiles.forEach((t) => { t.style.transition = ''; t.style.transform = ''; });
    tileEl.classList.remove('drag-src');
  };

  const onUp = (ev) => {
    const wasActive = active;
    const dropIdx = gapIdx;
    const x = ev.clientX, y = ev.clientY;
    teardown();
    if (!wasActive) return; // it was a tap → let the click handler run

    ev.preventDefault();
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 350);

    const tray = canPlace() && trayUnder(x, y);
    if (tray) {
      if (tray.id === 'second-tray' && app.draft.second) app.draft.activeTray = 'second';
      else if (tray.id === 'word-tray') app.draft.activeTray = 'main';
      addCard(id);
      return;
    }
    const el = document.elementFromPoint(x, y);
    if (dropIdx !== null && el && el.closest('#hand')) {
      const order = app.handOrder;
      const from = order.indexOf(id);
      if (from !== -1) {
        order.splice(from, 1);
        order.splice(Math.max(0, Math.min(dropIdx, order.length)), 0, id);
        renderAll();
      }
    }
  };

  const onCancel = () => teardown();

  tileEl.setPointerCapture(e.pointerId);
  tileEl.addEventListener('pointermove', onMove);
  tileEl.addEventListener('pointerup', onUp);
  tileEl.addEventListener('pointercancel', onCancel);
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
  if (app.draft.yVowels && app.draft.yVowels.size) payload.yVowels = [...app.draft.yVowels];
  return payload;
}

// Which letters could be patented with the current word right now. Evaluated
// without any already-selected buy, so a stale selection can't zero the set.
function currentBuyable() {
  const out = new Set();
  if (!myTurn() || app.draft.discardMode) return out;
  const payload = draftPayload();
  delete payload.buy;
  const res = validatePlay(app.game, app.seat, payload, dictionaryLoaded() ? isWord : undefined);
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

// Step 2's patent picker: the buyable letters as tappable chips.
function renderBuyRow() {
  const row = $('buy-row');
  row.innerHTML = '';
  if (!myTurn() || app.draft.stage !== 'buy') return;
  const buyable = currentBuyable();
  if (app.draft.buy && !buyable.has(app.draft.buy)) app.draft.buy = null; // word changed under it
  if (!buyable.size) {
    row.innerHTML = '<span class="ability-note">No patent is affordable from this word — just end your turn.</span>';
    return;
  }
  for (const letter of [...buyable].sort((a, b) => PATENTS[b].cost - PATENTS[a].cost)) {
    const p = PATENTS[letter];
    const b = document.createElement('button');
    b.className = 'buy-chip' + (app.draft.buy === letter ? ' selected' : '');
    b.innerHTML = `<span class="pat-l">${letter}</span><span class="pat-c">$${p.cost}${p.power ? '★' : ''}</span>`;
    if (p.power) b.title = POWER_TEXT[p.power];
    b.addEventListener('click', () => toggleBuy(letter));
    row.appendChild(b);
  }
}

// Step 2's summary: your earnings, what each patent owner will collect from
// this play, the patent you're buying, and where that leaves you — everything
// the turn does, shown before you lock it in.
function renderBuySummary() {
  const el = $('turn-summary');
  const playBtn = $('btn-play');
  if (!myTurn() || app.draft.stage !== 'buy') { el.innerHTML = ''; playBtn.disabled = true; return; }
  const res = validatePlay(app.game, app.seat, draftPayload(), dictionaryLoaded() ? isWord : undefined);
  if (!res.ok) {
    el.innerHTML = `<div class="sum-row bad">${esc(res.error)}</div>`;
    playBtn.disabled = true;
    return;
  }
  const rows = res.words.map((w) =>
    `<div class="sum-row"><span>${esc(w.word)}</span><span>+$${w.money}${w.stock ? ` · ▣${w.stock}` : ''}</span></div>`);
  for (const [seat, amt] of royaltyPreview(res.usedIds)) {
    rows.push(`<div class="sum-row roy"><span>${esc(seatNameOr(seat))} collects royalties</span><span>+$${amt} to them</span></div>`);
  }
  const buyCost = app.draft.buy ? PATENTS[app.draft.buy].cost : 0;
  if (app.draft.buy) rows.push(`<div class="sum-row"><span>Patent ${app.draft.buy}</span><span>−$${buyCost}</span></div>`);
  const endMoney = app.game.money[app.seat] + res.money - buyCost;
  const endStock = app.game.stock[app.seat] + res.stock;
  rows.push(`<div class="sum-row total"><span>You'll have</span><span>$${endMoney} · ▣${endStock}</span></div>`);
  el.innerHTML = rows.join('');
  playBtn.disabled = false;
}

function updatePreview() {
  const prev = $('word-preview');
  const nextBtn = $('btn-next');
  const clearBtn = $('btn-clear');
  const swapBtn = $('btn-swap');
  // Swap (the "stuck? redraw" relief valve) is available whenever it's your
  // turn. sendTurn() disables it during a submit; this re-enables it on the next
  // render so it's never left permanently dead after your first move.
  swapBtn.disabled = !myTurn();
  if (!myTurn()) { prev.textContent = ''; prev.className = 'word-preview'; nextBtn.disabled = true; clearBtn.disabled = true; return; }
  const hasAny = app.draft.cards.length || (app.draft.second && app.draft.second.cards.length);
  clearBtn.disabled = !hasAny && app.draft.qDiscard == null;
  if (!hasAny) { prev.textContent = ''; prev.className = 'word-preview'; nextBtn.disabled = true; return; }

  const p = draftPayload();
  delete p.buy; // the patent is chosen in step 2
  const res = validatePlay(app.game, app.seat, p, dictionaryLoaded() ? isWord : undefined);
  if (!res.ok) {
    prev.textContent = res.error;
    prev.className = 'word-preview bad';
    nextBtn.disabled = true;
    return;
  }
  const parts = res.words.map((w) => `${w.word} +$${w.money}${w.stock ? ` ▣${w.stock}` : ''}`);
  let txt = parts.join('   ·   ');
  const roy = royaltyPreview(res.usedIds);
  if (roy.size) txt += '   ·   ' + [...roy].map(([s, amt]) => `${seatNameOr(s)} collects $${amt}`).join(', ');
  prev.textContent = txt;
  prev.className = 'word-preview ok';
  nextBtn.disabled = false;
}

// Step navigation: NEXT locks the word shape and moves to the buy/review step;
// EDIT WORD goes back (keeping everything staged).
$('btn-next').addEventListener('click', () => {
  if (!myTurn()) return;
  const p = draftPayload();
  delete p.buy;
  const res = validatePlay(app.game, app.seat, p, dictionaryLoaded() ? isWord : undefined);
  if (!res.ok) { setStatus(res.error); return; }
  app.draft.stage = 'buy';
  setStatus('');
  renderAll();
});
$('btn-back').addEventListener('click', () => {
  app.draft.stage = 'word';
  renderAll();
});

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

// Discard & redraw: choose specific hand cards, then end the turn.
$('btn-discard-mode').addEventListener('click', () => {
  if (!myTurn()) return;
  app.draft.discardMode = true;
  app.draft.discardSet = new Set();
  setStatus('');
  renderAll();
});
$('btn-discard-cancel').addEventListener('click', () => {
  app.draft.discardMode = false;
  app.draft.discardSet = new Set();
  renderAll();
});
$('btn-discard-go').addEventListener('click', async () => {
  if (!myTurn() || !app.draft.discardSet.size) return;
  await sendTurn({ type: 'discard', payload: { cards: [...app.draft.discardSet] } });
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
  $('start-title').textContent = n >= MIN_PLAYERS ? 'READY?' : 'WAITING FOR PLAYERS';
  setStartInfo(`${n}/${MAX_PLAYERS} players in · need ${MIN_PLAYERS}+ to start · share code <strong>${esc(app.code)}</strong>`);
  const host = app.seat === 0;
  $('btn-start').textContent = 'START GAME';
  $('btn-start').classList.toggle('hidden', !host);
  $('btn-start').disabled = n < MIN_PLAYERS;
  $('start-waiting').classList.toggle('hidden', host);
}
function setStartInfo(html) { $('start-info').innerHTML = html; }
function setStatus(msg) { $('status-line').textContent = msg || ''; }

// ---- "Your turn" notifications --------------------------------------------

function maybeNotifyTurn() {
  const mine = myTurn();
  if (mine && !app.wasMyTurn && app.started && document.hidden) {
    const last = app.game?.log?.[app.game.log.length - 1];
    const who = (last && seatName(app.room, last.seat)) || 'Someone';
    showTurnNotification(`${describeLog(last, who)} Your move!`);
  }
  if (mine && !document.hidden) clearTurnNotification();
  app.wasMyTurn = mine;
}

function pushOpponent() {
  if (!app.room || !app.game) return;
  // Notify whoever's turn it now is (the next player in order), not just "seat 1".
  const oppSeat = whoseTurn(app.game);
  if (oppSeat === app.seat) return;
  const oppUserId = app.room.players?.[oppSeat]?.userId || null;
  const route = oppUserId ? { user_id: oppUserId } : { room_code: app.code, player: oppSeat };
  triggerPush({
    ...route,
    title: "Lexicorp — it's your turn",
    body: describeLog(app.game.log[app.game.log.length - 1], app.name),
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
  const raw = readSession();
  if (!raw) return false;
  try {
    const { code, name } = JSON.parse(raw);
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
    return true;
  } catch { clearSession(); return false; }
}

async function boot() {
  registerServiceWorker();
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  if (!configReady()) { landingError('Setup needed: Supabase key missing.'); window.LBBoot?.done(); return; }
  // Cached session (sync, no network) decides the initial screen; the boot
  // veil stays up until the route — including a room resume — is settled,
  // so the page never shows the lobby and then jumps into a resumed game.
  app.user = cachedUser();
  app.userId = app.user?.id ?? null;
  app.name = playerName();
  $('btn-go-lobby').classList.toggle('hidden', !app.user);
  onAuthChange(onAuth);
  const resumed = await tryResume();
  if (!resumed) {
    if (app.user) { showScreen('lobby'); renderLobby(); } else showScreen('landing');
  }
  window.LBBoot?.done();
}

// Help modal close handlers (account-ui wires its own injected modals).
$('help-modal')?.addEventListener('click', (e) => { if (e.target === $('help-modal')) $('help-modal').classList.add('hidden'); });
$('help-close')?.addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-got-it')?.addEventListener('click', () => $('help-modal').classList.add('hidden'));

boot();
