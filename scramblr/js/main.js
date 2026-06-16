// Scramblr — multiplayer word hunt. Reuses the shared rooms/account layer
// (account-ui.js handles login/profile/friends/menu); this module handles the
// landing/lobby/room flow and the Scramblr gameplay.

import {
  makeBoard, validPath, wordFromPath, wordPoints, adjacent, MIN_WORD,
  COUNTDOWN_MS, GAME_MS, standings,
} from './engine.js';
import { loadDictionary, isWord, dictionaryLoaded } from './dictionary.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMyRooms, updateRoomStatus,
  finishRoom, RoomConnection, triggerPush, seatName,
} from './net.js';
import { configReady, GAME_SLUG } from './config.js';
import { currentUser, onAuthChange, displayName } from '../../shared/auth.js';
import { listFriends } from '../../shared/friends.js';
import { openHistory } from '../../shared/history.js';
import { getGuestName } from '../../shared/guest-name.js';
import { loadTheme, createThemePicker } from '../../shared/themes.js';
import { registerServiceWorker } from './notify.js';

// Scramblr keeps the neon Synth theme by default (a stored preference wins).
loadTheme('synth');

const $ = (id) => document.getElementById(id);
const MAX_PLAYERS = 8;
const SESSION_KEY = 'scramblr_session';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const app = {
  user: null, userId: null, name: null,
  code: null, seat: null, room: null, conn: null,
  board: null,
  phase: 'idle',           // idle | waiting | countdown | playing | results
  startAt: null,           // epoch ms the countdown began (from the start move)
  online: new Set(),
  found: new Set(),
  foundOrder: [],
  myScore: 0,              // provisional (pre-dedup) running total
  path: [],
  dragging: false,
  dragMoved: false,
  results: {},             // seat -> string[] of submitted words
  submittedResult: false,
  timerInt: null,
  resultPersisted: false,  // have we stored the final result on the room yet
  persistedCount: 0,       // how many seats' results were in that stored copy
  rotation: 0,             // 0 | 1 | 2 | 3 — number of 90° CW quarter-turns
  scoringStarted: false,   // have we kicked off the word-by-word scoring animation?
  scoringAbort: false,     // set to true to skip/abort the animation
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
  // Only change screens when not mid-game.
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
$('btn-lobby-challenge').addEventListener('click', openChallenge);
$('btn-lobby-history').addEventListener('click', () => openHistory({ userId: app.userId, gameSlug: GAME_SLUG }));
$('btn-logout-lobby').addEventListener('click', async () => { const { signOut } = await import('../../shared/auth.js'); try { await signOut(); } catch {} });

function dismissedKey() { return `scramblr.dismissed.${app.userId}`; }
function getDismissed() { try { return new Set(JSON.parse(localStorage.getItem(dismissedKey()) || '[]')); } catch { return new Set(); } }
function dismissGame(code) { const s = getDismissed(); s.add(code); localStorage.setItem(dismissedKey(), JSON.stringify([...s])); }

async function renderLobby() {
  if (!app.userId) return;
  startLobbyPolling();
  $('lobby-name').textContent = app.name || 'player';
  let rooms;
  try { rooms = await fetchMyRooms(app.userId); }
  catch (e) { $('lobby-error').textContent = `Could not load games (${e.message}).`; return; }
  const dismissed = getDismissed();
  rooms = rooms.filter((r) => !dismissed.has(r.code));
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
  // Finished games re-open to show their final results (the History button in
  // the lobby is the way to browse all past games).
  card.addEventListener('click', () => openFromLobby(room, invitedMe));
  if (finished) {
    const x = document.createElement('span');
    x.className = 'lobby-dismiss'; x.textContent = '×'; x.title = 'Remove';
    x.addEventListener('click', (e) => { e.stopPropagation(); dismissGame(room.code); card.remove(); if (!$('lobby-list').children.length) renderLobby(); });
    card.appendChild(x);
  }
  return card;
}

async function openFromLobby(room, invitedMe) {
  try {
    if (invitedMe) {
      const { room: updated, playerIndex } = await joinRoom(room.code, app.name, app.userId);
      await enterRoom(room.code, playerIndex, app.name, updated);
    } else {
      const { room: updated, playerIndex } = await joinRoom(room.code, app.name, app.userId);
      await enterRoom(room.code, playerIndex, app.name, updated);
    }
  } catch (e) { $('lobby-error').textContent = e.message; }
}

// ---- Challenge a friend ---------------------------------------------------

async function openChallenge() {
  $('modal-challenge').classList.remove('hidden');
  const el = $('challenge-list');
  el.innerHTML = '<li class="friend-item empty">Loading…</li>';
  let friends = [];
  try { friends = await listFriends(); } catch { el.innerHTML = '<li class="friend-item empty">Could not load friends.</li>'; return; }
  if (!friends.length) { el.innerHTML = '<li class="friend-item empty">No friends yet — add some from your profile.</li>'; return; }
  el.innerHTML = '';
  for (const f of friends) {
    const li = document.createElement('li');
    li.className = 'friend-item';
    li.innerHTML = `<span class="friend-name">${esc(f.display_name || 'Player')}</span>`
      + '<span class="friend-actions"><button class="btn-primary">CHALLENGE</button></span>';
    li.querySelector('button').addEventListener('click', () => challengeFriend(f));
    el.appendChild(li);
  }
}

async function challengeFriend(friend) {
  $('modal-challenge').classList.add('hidden');
  try {
    const room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name }, MAX_PLAYERS);
    triggerPush({ user_id: friend.id, title: 'Scramblr challenge!', body: `${app.name} challenged you to Scramblr.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { $('lobby-error').textContent = e.message; }
}

// ---- Room / game ----------------------------------------------------------

function resetGame() {
  app.phase = 'idle'; app.startAt = null;
  app.found = new Set(); app.foundOrder = []; app.myScore = 0;
  app.path = []; app.dragging = false; app.dragMoved = false;
  app.results = {}; app.submittedResult = false;
  app.resultPersisted = false; app.persistedCount = 0;
  app.scoringStarted = false; app.scoringAbort = false;
  if (app.timerInt) { clearInterval(app.timerInt); app.timerInt = null; }
}

async function enterRoom(code, seat, name, room) {
  resetGame();
  // Re-opening a finished game is review-only: pretend we've already submitted
  // so the replayed end-of-game never clobbers our stored words with an empty
  // set (our real result is loaded from the move log instead).
  if (room.status === 'finished') app.submittedResult = true;
  app.code = code; app.seat = seat; app.name = name; app.room = room;
  app.board = makeBoard(Number(room.seed));
  $('room-code-text').textContent = code;
  showScreen('game');
  buildBoard();
  renderPlayers();
  renderFoundReset();
  setStatus('');
  setPhase('waiting');
  loadDictionary().catch(() => {});
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name }));

  app.conn = new RoomConnection(code, seat, name, {
    onMove: handleMove,
    onPresence: handlePresence,
    onMode: setConn,
    onRoomUpdate: handleRoomUpdate,
  });
  app.conn.connect();
}

function handleMove(move) {
  // Note: result moves use sparse, per-seat indices (2 + seat) and can arrive
  // in any order, so we deliberately don't advance the connection's nextIndex
  // — handleMove is idempotent and the move count is tiny, so re-polling all
  // moves is cheap and avoids ever skipping a lower-indexed result.
  if (move.type === 'start') {
    if (app.startAt == null) {
      app.startAt = Number(move.payload?.startAt) || Date.parse(move.created_at) || Date.now();
    }
    startTimers();
  } else if (move.type === 'result') {
    app.results[move.player] = Array.isArray(move.payload?.words) ? move.payload.words : [];
    if (app.phase === 'results' || app.phase === 'scoring' || isOver()) onResultsUpdate();
  }
}

function handlePresence(set) {
  app.online = set;
  // A seat we don't know about showed up (new joiner) — refresh the room.
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

function setConn(mode) {
  const b = $('conn-badge'); // optional — the header no longer shows a badge
  if (!b) return;
  b.textContent = mode === 'live' ? 'live' : 'syncing…';
  b.classList.toggle('live', mode === 'live');
}

$('room-code-chip').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(app.code); setStatus('Room code copied.'); } catch {}
});

$('btn-leave').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  if (app.conn) { app.conn.close(); app.conn = null; }
  resetGame();
  app.code = null; app.seat = null; app.room = null;
  if (app.user) { showScreen('lobby'); renderLobby(); } else showScreen('landing');
});

$('btn-start').addEventListener('click', async () => {
  if (app.startAt != null) return;
  $('btn-start').disabled = true;
  const startAt = Date.now();
  try {
    await app.conn.sendMove({ move_index: 0, player: 0, type: 'start', payload: { startAt } });
    updateRoomStatus(app.code, 'playing').catch(() => {});
    app.startAt = startAt;
    startTimers();
  } catch (e) { $('btn-start').disabled = false; setStatus(e.message || 'Could not start.'); }
});

$('btn-results-done').addEventListener('click', () => {
  if (app.code) dismissGame(app.code);
  $('btn-leave').click();
});

$('btn-scoring-skip').addEventListener('click', () => { app.scoringAbort = true; });

// ---- Phase + timers -------------------------------------------------------

function isOver() {
  return app.startAt != null && Date.now() >= app.startAt + COUNTDOWN_MS + GAME_MS;
}

function startTimers() {
  if (app.timerInt) return;
  app.timerInt = setInterval(tick, 200);
  tick();
}

function tick() {
  if (app.startAt == null) return;
  const now = Date.now();
  const reveal = app.startAt + COUNTDOWN_MS;
  const end = reveal + GAME_MS;
  if (now < reveal) {
    setPhase('countdown');
    $('countdown-num').textContent = String(Math.max(1, Math.ceil((reveal - now) / 1000)));
  } else if (now < end) {
    if (app.phase !== 'playing') startPlay();
    renderTimer(end - now);
  } else {
    endPlay();
  }
}

function setPhase(p) {
  if (app.phase === p) return;
  app.phase = p;
  $('prestart-overlay').classList.toggle('hidden', p !== 'waiting');
  $('countdown-overlay').classList.toggle('hidden', p !== 'countdown');
  $('scoring-overlay').classList.toggle('hidden', p !== 'scoring');
  $('results-overlay').classList.toggle('hidden', p !== 'results');
  const reveal = p === 'playing' || p === 'scoring' || p === 'results';
  showLetters(reveal);
  if (p === 'waiting') renderPrestart();
}

function startPlay() {
  setPhase('playing');
  loadDictionary().catch(() => {});
  renderPlayers();
}

function endPlay() {
  if (app.phase !== 'results' && app.phase !== 'scoring') {
    if (app.timerInt) { clearInterval(app.timerInt); app.timerInt = null; }
    renderTimer(0);
    clearPath();
    submitMyResult();
    app.scoringStarted = false;
    app.scoringAbort = false;
    if (app.code) updateRoomStatus(app.code, 'finished').catch(() => {});
    // Show results overlay in "waiting" state (no scoreboard yet)
    $('results-list').innerHTML = '';
    $('results-winner').textContent = '';
    $('results-waiting').classList.remove('hidden');
    setPhase('results');
  }
  onResultsUpdate();
}

function submitMyResult() {
  if (app.submittedResult || app.seat == null) return;
  app.submittedResult = true;
  const words = [...app.found];
  app.results[app.seat] = words;
  app.conn?.sendMove({ move_index: 2 + app.seat, player: app.seat, type: 'result', payload: { words } }).catch(() => {});
}

// ---- Board rendering + input ---------------------------------------------

let cellEls = []; // indexed by original cell index (data-i), persists across rotations

function buildBoard() {
  const el = $('board');
  el.innerHTML = '';
  cellEls = [];
  app.rotation = 0;
  for (let i = 0; i < 16; i++) {
    const c = document.createElement('div');
    c.className = 'bcell';
    c.dataset.i = String(i);
    cellEls.push(c);
    el.appendChild(c);
  }
}

// Compute the display order for r quarter-turns clockwise on a 4×4 grid.
// Returns an array of 16 original cell indices, one per display position.
function rotationOrder(r) {
  const N = 4;
  return Array.from({ length: N * N }, (_, k) => {
    let row = Math.floor(k / N), col = k % N;
    for (let t = 0; t < r; t++) { const nr = N - 1 - col; col = row; row = nr; }
    return row * N + col;
  });
}

function applyRotation() {
  const el = $('board');
  rotationOrder(app.rotation).forEach(origIdx => el.appendChild(cellEls[origIdx]));
}

$('btn-rotate').addEventListener('click', () => {
  if (app.phase !== 'playing' && app.phase !== 'results' && app.phase !== 'scoring') return;
  app.rotation = (app.rotation + 1) % 4;
  applyRotation();
});

function showLetters(show) {
  for (let i = 0; i < cellEls.length; i++) {
    const t = app.board[i];
    cellEls[i].textContent = show ? (t === 'QU' ? 'Qu' : t) : '';
  }
  renderPath();
}

function cellIndexFromPoint(x, y, circular = false) {
  const el = document.elementFromPoint(x, y);
  if (!el || !el.classList.contains('bcell')) return -1;
  if (circular) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const radius = Math.min(r.width, r.height) / 2;
    if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) return -1;
  }
  return Number(el.dataset.i);
}

function tryAdd(i) {
  const path = app.path;
  if (i < 0) return;
  if (path.length === 0) { path.push(i); return; }
  const last = path[path.length - 1];
  if (i === last) return;
  const pos = path.indexOf(i);
  if (pos !== -1) { app.path = path.slice(0, pos + 1); return; } // backtrack to a visited cell
  if (adjacent(last, i)) path.push(i);
}

function onPointerDown(e) {
  if (app.phase !== 'playing') return;
  const i = cellIndexFromPoint(e.clientX, e.clientY);
  if (i < 0) return;
  e.preventDefault();
  app.dragging = true; app.dragMoved = false;
  const last = app.path[app.path.length - 1];
  if (app.path.length && i === last) { submitWord(); return; } // tap last cell again = accept
  tryAdd(i);
  renderPath();
}

function onPointerMove(e) {
  if (!app.dragging || app.phase !== 'playing') return;
  const i = cellIndexFromPoint(e.clientX, e.clientY, app.path.length > 0);
  if (i < 0) return;
  const before = app.path.length;
  const last = app.path[app.path.length - 1];
  if (i !== last) { tryAdd(i); if (app.path.length !== before) { app.dragMoved = true; renderPath(); } }
}

function onPointerUp() {
  if (!app.dragging) return;
  app.dragging = false;
  if (app.dragMoved) submitWord(); // drag-release accepts; taps keep building
}

function renderPath() {
  const set = new Set(app.path);
  const last = app.path[app.path.length - 1];
  for (let i = 0; i < cellEls.length; i++) {
    cellEls[i].classList.toggle('sel', set.has(i));
    cellEls[i].classList.toggle('last', i === last);
  }
  const word = app.path.length ? wordFromPath(app.board, app.path) : '';
  $('current-word').textContent = word === '' ? '' : (word === 'QU' ? 'Qu' : titleWord(word));
  $('btn-accept').disabled = app.path.length === 0;
  $('btn-clear').disabled = app.path.length === 0;
}
function titleWord(w) { return w.replace('QU', 'Qu'); }

function clearPath() { app.path = []; renderPath(); }
$('btn-clear').addEventListener('click', clearPath);
$('btn-accept').addEventListener('click', submitWord);

function submitWord() {
  const path = app.path.slice();
  clearPath();
  if (!path.length) return;
  if (!validPath(path)) { flashWord('—', 'invalid'); return; }
  const word = wordFromPath(app.board, path);
  if (word.length < MIN_WORD) { setStatus(`${titleWord(word)} — too short (3+)`); return; }
  if (app.found.has(word)) { setStatus(`${titleWord(word)} — already found`); return; }
  if (!dictionaryLoaded()) { setStatus('Loading dictionary…'); loadDictionary().catch(() => {}); return; }
  if (!isWord(word)) { setStatus(`${titleWord(word)} — not a word`); return; }
  const pts = wordPoints(word);
  app.found.add(word); app.foundOrder.unshift(word); app.myScore += pts;
  addFoundChip(word);
  $('my-score').textContent = String(app.myScore);
  $('found-count').textContent = `${app.found.size} word${app.found.size === 1 ? '' : 's'}`;
  setStatus(`+${pts}  ${titleWord(word)}`);
}

function renderFoundReset() {
  $('found-list').innerHTML = '';
  $('my-score').textContent = '0';
  $('found-count').textContent = '0 words';
}
function addFoundChip(word) {
  const span = document.createElement('span');
  span.className = 'fw flash';
  span.textContent = titleWord(word);
  $('found-list').prepend(span);
  setTimeout(() => span.classList.remove('flash'), 600);
}
function flashWord() { /* reserved for invalid-path feedback */ }

function setStatus(msg) { $('status-line').textContent = msg || ''; }
function renderTimer(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const t = $('timer');
  t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  t.classList.toggle('warn', s <= 30 && s > 10);
  t.classList.toggle('danger', s <= 10);
}

// Bind board pointer handlers once.
const boardEl = $('board');
boardEl.addEventListener('pointerdown', onPointerDown);
boardEl.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- Players + prestart + results ----------------------------------------

function renderPlayers() {
  const strip = $('players-strip');
  const players = app.room?.players ?? [];
  strip.innerHTML = '';
  players.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'pchip' + (p.seat === app.seat ? ' me' : '');
    const online = app.online.has(String(p.seat));
    const showScore = app.phase === 'results' && lastStandings != null;
    const score = showScore ? scoreForSeat(p.seat) : null;
    div.innerHTML = `<span class="pdot ${online ? '' : 'off'}"></span>`
      + `<span class="pname">${esc(p.name || `P${p.seat + 1}`)}</span>`
      + `<span class="pscore">${score == null ? '·' : score}</span>`;
    strip.appendChild(div);
  });
}

function renderPrestart() {
  if (app.phase !== 'waiting') return;
  const players = app.room?.players ?? [];
  const n = players.length;
  $('start-title').textContent = n >= 2 ? 'READY?' : 'WAITING FOR PLAYERS';
  $('start-info').innerHTML = `${n} player${n === 1 ? '' : 's'} in · share code <strong>${esc(app.code)}</strong>`;
  const host = app.seat === 0;
  $('btn-start').classList.toggle('hidden', !host);
  $('btn-start').disabled = false;
  $('start-waiting').classList.toggle('hidden', host);
}

let lastStandings = null;
function scoreForSeat(seat) { return lastStandings ? (lastStandings[seat]?.score ?? 0) : 0; }

// Build validated word list per seat using all received results.
function buildWordsBySeat(seats) {
  const arr = [];
  for (let s = 0; s < seats; s++) arr[s] = app.results[s] || (s === app.seat ? [...app.found] : []);
  return arr;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Called whenever a result move arrives or the game ends.
// Manages the transition: waiting → scoring animation → final results.
function onResultsUpdate() {
  if (app.phase !== 'results' && app.phase !== 'scoring') return;
  const seats = (app.room?.players ?? []).length || 1;
  const submitted = Object.keys(app.results).length;
  renderPlayers();

  if (app.phase === 'results' && !app.scoringStarted) {
    const allReady = submitted >= seats;
    $('results-waiting').classList.toggle('hidden', allReady);
    if (allReady) {
      app.scoringStarted = true;
      startScoringAnimation(seats).catch(() => { renderFinalResults(); setPhase('results'); });
    }
  }
}

// Animate the player's own words being revealed one-by-one, with score
// additions and cancellations shown in real time.
async function startScoringAnimation(seats) {
  const wordsBySeat = buildWordsBySeat(seats);
  if (!dictionaryLoaded()) { try { await loadDictionary(); } catch {} }
  lastStandings = standings(app.board, isWord, wordsBySeat);
  persistResultIfReady(Object.keys(app.results).length, seats);

  // Map word → seats that submitted it (raw; cancellation logic is best-effort)
  const wordOwners = new Map();
  for (let s = 0; s < seats; s++) {
    for (const w of (wordsBySeat[s] || [])) {
      const key = String(w).toUpperCase();
      if (!wordOwners.has(key)) wordOwners.set(key, []);
      wordOwners.get(key).push(s);
    }
  }

  const myWords = [...(wordsBySeat[app.seat] || [])].map(w => String(w).toUpperCase()).sort();

  setPhase('scoring');
  $('scoring-list').innerHTML = '';
  $('scoring-total').textContent = '0 pts';
  $('scoring-total').className = 'scoring-total';

  let score = 0;

  for (const word of myWords) {
    if (app.scoringAbort || app.phase !== 'scoring') break;

    const owners = wordOwners.get(word) || [app.seat];
    const pts = wordPoints(word);
    const cancelled = owners.length > 1;
    const otherNames = owners
      .filter((s) => s !== app.seat)
      .map((s) => seatName(app.room, s) || `P${s + 1}`)
      .join(' & ');

    const row = document.createElement('div');
    row.className = 'sw';
    const wSpan = document.createElement('span');
    wSpan.className = 'sw-word';
    wSpan.textContent = titleWord(word);
    const sSpan = document.createElement('span');
    sSpan.className = 'sw-pts';
    sSpan.textContent = `+${pts}`;
    row.appendChild(wSpan);
    row.appendChild(sSpan);
    $('scoring-list').appendChild(row);
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Slide the row in
    requestAnimationFrame(() => requestAnimationFrame(() => row.classList.add('visible')));
    await delay(200);
    if (app.scoringAbort || app.phase !== 'scoring') break;

    // Tentatively add pts to running total
    score += pts;
    $('scoring-total').textContent = `${score} pts`;

    if (cancelled) {
      await delay(380);
      if (app.scoringAbort || app.phase !== 'scoring') break;

      // Reveal the canceller's name, cross out the word, wiggle total back down
      sSpan.className = 'sw-canceller';
      sSpan.textContent = otherNames;
      row.classList.add('cancelled');
      score -= pts;
      const totalEl = $('scoring-total');
      totalEl.textContent = `${score} pts`;
      totalEl.classList.remove('wiggle');
      void totalEl.offsetWidth; // restart animation
      totalEl.classList.add('wiggle');
      setTimeout(() => totalEl.classList.remove('wiggle'), 650);
      await delay(680);
    } else {
      await delay(180);
    }
  }

  if (app.phase !== 'scoring') return; // user navigated away

  // Pause on the final total before revealing the scoreboard
  if (!app.scoringAbort) await delay(2200);

  if (app.phase !== 'scoring') return;

  app.scoringAbort = false;
  renderFinalResults();
  setPhase('results');
}

// Build and show the final scoreboard with expandable unique-word lists.
function renderFinalResults() {
  const seats = (app.room?.players ?? []).length || 1;
  const wordsBySeat = buildWordsBySeat(seats);
  if (dictionaryLoaded()) lastStandings = standings(app.board, isWord, wordsBySeat);

  // Compute unique words per seat for the click-to-reveal feature
  const wordOwners = new Map();
  for (let s = 0; s < seats; s++) {
    for (const w of (wordsBySeat[s] || [])) {
      const key = String(w).toUpperCase();
      if (!wordOwners.has(key)) wordOwners.set(key, []);
      wordOwners.get(key).push(s);
    }
  }
  const uniqueWords = Array.from({ length: seats }, (_, s) =>
    (wordsBySeat[s] || [])
      .map(w => String(w).toUpperCase())
      .filter(w => (wordOwners.get(w) || []).length === 1)
      .sort()
  );

  const ranked = (lastStandings || [])
    .map((r, seat) => ({ seat, ...r, name: seatName(app.room, seat) || `P${seat + 1}` }))
    .sort((a, b) => b.score - a.score || (b.unique || 0) - (a.unique || 0));

  const ol = $('results-list');
  ol.innerHTML = '';
  ranked.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.seat === app.seat) li.className = 'me';

    const row = document.createElement('div');
    row.className = 'results-row';
    row.innerHTML = `<span class="r-rank">${i + 1}</span>`
      + `<span class="r-name">${esc(r.name)}</span>`
      + `<span class="r-score">${r.score}</span>`;
    li.appendChild(row);

    const uw = uniqueWords[r.seat] || [];
    if (uw.length) {
      const nameEl = row.querySelector('.r-name');
      nameEl.classList.add('has-words');
      const wordsEl = document.createElement('div');
      wordsEl.className = 'r-words';
      wordsEl.textContent = uw.map(w => titleWord(w)).join('  ·  ');
      li.appendChild(wordsEl);
      nameEl.addEventListener('click', () => wordsEl.classList.toggle('open'));
    }

    ol.appendChild(li);
  });

  const winnerEl = $('results-winner');
  if (ranked.length <= 1) {
    winnerEl.textContent = ''; winnerEl.className = 'results-winner';
  } else {
    const topScore = ranked[0].score;
    const tied = ranked.filter(r => r.score === topScore);
    const iWon = tied.some(r => r.seat === app.seat);
    const isTie = tied.length > 1;
    if (isTie && iWon) {
      winnerEl.textContent = "It's a tie!"; winnerEl.className = 'results-winner';
    } else if (iWon) {
      winnerEl.textContent = 'You won!'; winnerEl.className = 'results-winner';
    } else if (isTie) {
      winnerEl.textContent = `${tied.map(r => r.name).join(' & ')} tied`;
      winnerEl.className = 'results-winner loss';
    } else {
      winnerEl.textContent = `${ranked[0].name} won`;
      winnerEl.className = 'results-winner loss';
    }
  }

  $('results-waiting').classList.add('hidden');
  persistResultIfReady(Object.keys(app.results).length, seats);
  renderPlayers();
}

// Store the final standings on the room so the lobby and Game History can show
// outcomes without recomputing. We write once everyone has submitted (so every
// client computes identical standings), or when the clock is up; if more
// results arrive later we re-write the more complete copy. Idempotent across
// clients, last (most complete) write wins.
async function persistResultIfReady(submitted, seats) {
  if (!lastStandings || !app.code) return;
  const complete = submitted >= seats;
  if (!complete && !isOver()) return;
  if (app.resultPersisted && submitted <= app.persistedCount) return;
  app.persistedCount = submitted;
  app.resultPersisted = true;

  const scores = lastStandings.map((s) => s?.score ?? 0);
  const result = { scores, winner: winnerSeat(scores), reason: 'time' };
  try {
    await finishRoom(app.code, result, false); // keep Scramblr's tiny move log
    if (app.room) { app.room.status = 'finished'; app.room.result = result; }
  } catch {
    app.resultPersisted = false; // allow a later attempt to retry
  }
}

// Seat with the top score, or 'tie' when the best score is shared (or all zero).
function winnerSeat(scores) {
  let best = -Infinity, who = null, ties = 0;
  scores.forEach((s, i) => {
    if (s > best) { best = s; who = i; ties = 1; }
    else if (s === best) { ties += 1; }
  });
  return ties > 1 || best <= 0 ? 'tie' : who;
}

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

// Drop the theme picker into the shared hamburger menu (injected by
// account-ui), just above "More Games".
function addThemePicker() {
  const menu = document.getElementById('app-menu');
  if (!menu || menu.querySelector('.theme-picker-section')) return;
  const picker = createThemePicker();
  picker.style.padding = '8px 12px';
  const moreGames = menu.querySelector('a[href="../"]');
  menu.insertBefore(picker, moreGames || null);
}

async function boot() {
  registerServiceWorker();
  addThemePicker();
  if (!configReady()) { landingError('Setup needed: Supabase key missing.'); return; }
  try { app.user = await currentUser(); } catch {}
  app.userId = app.user?.id ?? null;
  app.name = playerName();
  $('btn-go-lobby').classList.toggle('hidden', !app.user);
  if (app.user) { showScreen('lobby'); renderLobby(); } else showScreen('landing');
  onAuthChange(onAuth);
  tryResume();
}

// Close challenge/help modals on backdrop / close button (account-ui wires its
// own injected modals; these two are ours).
for (const id of ['modal-challenge', 'help-modal']) {
  $(id)?.addEventListener('click', (e) => { if (e.target === $(id)) $(id).classList.add('hidden'); });
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => $(b.dataset.close).classList.add('hidden')));

boot();
