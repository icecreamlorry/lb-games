// Atlaz — map country/state guessing games. Reuses the shared rooms/account
// layer (account-ui.js handles login/profile/friends/menu); this module owns
// the landing/lobby/room flow, the prestart region+mode picker, timing, and
// results. Gameplay itself lives in modes.js on top of map.js.
//
// Multiplayer model (see PLAN.md §6): the host's `start` move (index 0)
// carries { region, mode, startAt }; everyone races the same seeded question
// order concurrently; each seat submits ONE sparse `result` move (index
// 10+seat). Ranking/winner derivation is pure (engine.js).

import { MODES, modeMeta, questionOrder, rankSeats, winnerSeat, scoreOf, compareResults } from './engine.js';
import { REGIONS, regionMeta, loadRegion } from './regions.js';
import { AtlazMap } from './map.js';
import { createMode, renderReview, hidePanels } from './modes.js';
import {
  createRoom, joinRoom, fetchRoom, fetchMyRooms, updateRoomStatus,
  finishRoom, RoomConnection, triggerPush, seatName, seatLeft, markPlayerLeft,
} from './net.js';
import { createRematch } from '../../shared/rematch.js';
import { configReady, GAME_SLUG } from './config.js';
import { currentUser, onAuthChange, displayName } from '../../shared/auth.js';
import { openHistory } from '../../shared/history.js';
import { filterDismissed, dismissGame, makeDismissControl } from '../../shared/dismissed-games.js';
import { getGuestName } from '../../shared/guest-name.js';
import {
  registerServiceWorker, requestNotifications, isEnabled as notifyEnabled,
  subscribeToPush, notificationsSupported, notificationPermission,
} from './notify.js';

const $ = (id) => document.getElementById(id);
const MAX_PLAYERS = 5;
const SESSION_KEY = 'atlaz_session';
const COUNTDOWN_MS = 3000;
const RESULT_MOVE_BASE = 10;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const app = {
  user: null, userId: null, name: null,
  code: null, seat: null, room: null, conn: null,
  solo: false,
  phase: 'idle',            // idle | config | countdown | playing | results
  regionId: null, modeId: null, regionData: null,
  startAt: null,            // epoch ms the countdown began
  order: [],
  map: null, ctl: null,
  results: {},              // seat -> result payload
  submittedResult: false,
  resultPersisted: false, persistedCount: 0,
  resultsDismissed: false,
  viewingSeat: null,        // whose attempt the map is showing (null = live/me)
  online: new Set(),
  timerInt: null,
  rematching: false,
  cfgSel: { region: null, mode: null },
};

function playerName() { return app.user ? displayName(app.user) : getGuestName(); }
function seats() { return app.solo ? 1 : (app.room?.players ?? []).length || 1; }

// ---- Screens ----------------------------------------------------------------

function showScreen(which) {
  for (const id of ['screen-landing', 'screen-lobby', 'screen-game']) {
    $(id).classList.toggle('hidden', id !== `screen-${which}`);
  }
  if (which !== 'lobby') stopLobbyPolling();
}

// ---- Landing ------------------------------------------------------------------

function landingError(msg) { $('landing-error').textContent = msg || ''; }
function requireName(errFn) {
  const n = playerName();
  if (!n) { errFn('Set your name first.'); return null; }
  return n;
}

$('btn-solo').addEventListener('click', () => {
  const name = requireName(landingError); if (!name) return;
  landingError('');
  enterSolo();
});

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
  joinRoom(code, name, app.userId)
    .then(({ room, playerIndex }) => enterRoom(code, playerIndex, name, room))
    .catch((e) => errFn(e.message || 'Could not join that room.'));
}
$('btn-join-go').addEventListener('click', () => doJoin($('code-input'), landingError));
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin($('code-input'), landingError); });
$('btn-go-lobby').addEventListener('click', () => { showScreen('lobby'); renderLobby(); });

// ---- Auth ---------------------------------------------------------------------

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

// ---- Lobby ----------------------------------------------------------------------

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
// lobby-ui's "daily" slot doubles as our solo entry.
const soloBtn = $('btn-lobby-daily');
if (soloBtn) { soloBtn.textContent = '◎ SOLO'; soloBtn.title = 'Practice on your own'; soloBtn.addEventListener('click', () => enterSolo()); }
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
  revealNotify();
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
  card.className = 'lobby-game' + (live ? ' live' : '') + (finished ? ' finished' : '');
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

// ---- Challenge a friend ---------------------------------------------------------

async function challengeFriend(friend) {
  try {
    const room = await createRoom(app.name, app.userId, { userId: friend.id, name: friend.display_name }, MAX_PLAYERS);
    triggerPush({ user_id: friend.id, title: 'Atlaz challenge!', body: `${app.name} challenged you to Atlaz.`, url: location.href.split('#')[0] }).catch(() => {});
    await enterRoom(room.code, 0, app.name, room);
  } catch (e) { $('lobby-error').textContent = e.message; }
}

// ---- Room / game lifecycle ---------------------------------------------------------

function resetGame() {
  if (app.conn) { app.conn.close(); app.conn = null; }
  app.ctl?.destroy(); app.ctl = null;
  app.map?.destroy(); app.map = null;
  app.solo = false;
  app.phase = 'idle';
  app.regionId = null; app.modeId = null; app.regionData = null;
  app.startAt = null;
  app.order = [];
  app.results = {};
  app.submittedResult = false;
  app.resultPersisted = false; app.persistedCount = 0;
  app.resultsDismissed = false;
  app.viewingSeat = null;
  app.online = new Set();
  app.rematching = false;
  if (app.timerInt) { clearInterval(app.timerInt); app.timerInt = null; }
  hidePanels();
  $('prompt-line').textContent = ''; $('prompt-sub').textContent = '';
  $('results-overlay').classList.add('hidden');
  $('countdown-overlay').classList.add('hidden');
  $('timer-chip').classList.add('hidden');
  $('mode-chip').classList.add('hidden');
  if ($('btn-rematch')) $('btn-rematch').disabled = false;
  setStatus('');
}

async function enterRoom(code, seat, name, room) {
  resetGame();
  app.code = code; app.seat = seat; app.name = name; app.room = room;
  $('room-code-text').textContent = code;
  $('room-code-chip').classList.remove('hidden');
  $('solo-chip').classList.add('hidden');
  showScreen('game');
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name }));
  setPhase('config');
  renderAll();

  app.conn = new RoomConnection(code, seat, name, {
    onMove: handleMove,
    onPresence: handlePresence,
    onMode: () => {},
    onRoomUpdate: handleRoomUpdate,
  });
  app.conn.connect();

  if (notifyEnabled()) subscribeToPush({ userId: app.userId || undefined, roomCode: app.userId ? undefined : code, player: app.userId ? undefined : seat }).catch(() => {});
}

function enterSolo() {
  resetGame();
  app.solo = true;
  app.code = null; app.seat = 0;
  app.name = playerName() || 'Player';
  app.room = { players: [{ seat: 0, name: app.name }], status: 'waiting' };
  $('room-code-chip').classList.add('hidden');
  $('solo-chip').classList.remove('hidden');
  showScreen('game');
  setPhase('config');
  renderAll();
}

$('btn-leave').addEventListener('click', leaveRoom);
$('btn-results-done').addEventListener('click', () => { if (app.code) dismissGame(app.userId, app.code); leaveRoom(); });

async function leaveRoom() {
  if (!app.solo && app.code != null && app.seat != null && app.room && app.room.status !== 'finished') {
    try { const room = await markPlayerLeft(app.code, app.seat); if (room) app.conn?.broadcastRoom(room); } catch { /* best effort */ }
  }
  sessionStorage.removeItem(SESSION_KEY);
  resetGame();
  app.code = null; app.seat = null; app.room = null;
  if (app.user) { showScreen('lobby'); renderLobby(); } else showScreen('landing');
}

$('room-code-chip').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(app.code); setStatus('Room code copied.'); } catch {}
});

// ---- Moves ---------------------------------------------------------------------

function handleMove(move) {
  if (move.type === 'rematch') { rematch.follow(move.payload?.code); return; }
  if (move.type === 'start') {
    if (app.startAt != null) return;
    const p = move.payload || {};
    if (!regionMeta(p.region) || !modeMeta(p.mode)) return;
    beginGame(p.region, p.mode, Number(p.startAt) || Date.parse(move.created_at) || Date.now());
    return;
  }
  if (move.type === 'result') {
    const r = move.payload;
    if (!r || typeof move.player !== 'number') return;
    app.results[move.player] = r;
    if (move.player === app.seat) app.submittedResult = true;
    onResultsUpdate();
    renderPlayers();
  }
}

function handlePresence(set) {
  app.online = set;
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
  onResultsUpdate(); // a seat flagged `left` may complete the results
}

// ---- Prestart: region + mode picker ----------------------------------------------

const CFG_KEY = 'atlaz.lastcfg';
function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    if (regionMeta(c.region)) app.cfgSel.region = c.region;
    if (modeMeta(c.mode)) app.cfgSel.mode = c.mode;
  } catch { /* defaults stay */ }
}
function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(app.cfgSel)); } catch {} }

function canConfigure() { return app.solo || app.seat === 0; }

function buildCfgButtons() {
  const mk = (host, defs, key) => {
    host.innerHTML = '';
    for (const d of defs) {
      const b = document.createElement('button');
      b.className = 'cfg-btn';
      b.dataset.val = d.id;
      b.innerHTML = d.tagline ? `<span>${esc(d.name)}</span><small>${esc(d.tagline)}</small>` : esc(d.label);
      b.addEventListener('click', () => {
        if (!canConfigure() || app.phase !== 'config') return;
        app.cfgSel[key] = d.id;
        saveCfg();
        renderPrestart();
      });
      host.appendChild(b);
    }
  };
  mk($('cfg-countries'), REGIONS.filter((r) => r.kind === 'countries'), 'region');
  mk($('cfg-states'), REGIONS.filter((r) => r.kind === 'states'), 'region');
  mk($('cfg-modes'), MODES, 'mode');
}

function renderPrestart() {
  if (app.phase !== 'config') return;
  const host = canConfigure();
  $('cfg').classList.toggle('hidden', !host);
  $('start-title').textContent = host ? 'PICK A MAP & MODE' : 'WAITING FOR THE HOST';

  for (const b of document.querySelectorAll('.cfg-btn')) {
    b.classList.toggle('on', b.dataset.val === app.cfgSel.region || b.dataset.val === app.cfgSel.mode);
  }

  const n = (app.room?.players ?? []).length;
  const picked = regionMeta(app.cfgSel.region) && modeMeta(app.cfgSel.mode);
  if (app.solo) {
    $('start-info').textContent = picked
      ? `${regionMeta(app.cfgSel.region).label} — ${modeMeta(app.cfgSel.mode).name}`
      : 'Pick a region and a mode.';
  } else {
    $('start-info').innerHTML = `${n} player${n === 1 ? '' : 's'} in · share code <strong>${esc(app.code)}</strong>`
      + (host && picked ? ` · ${esc(regionMeta(app.cfgSel.region).label)} — ${esc(modeMeta(app.cfgSel.mode).name)}` : '');
  }
  $('btn-start').classList.toggle('hidden', !host);
  $('btn-start').disabled = !picked;
  $('btn-start').textContent = app.solo ? 'PLAY' : 'START';
  $('start-waiting').classList.toggle('hidden', host);
}

$('btn-start').addEventListener('click', async () => {
  if (!canConfigure() || app.phase !== 'config') return;
  const { region, mode } = app.cfgSel;
  if (!regionMeta(region) || !modeMeta(mode)) return;
  $('btn-start').disabled = true;
  const startAt = Date.now() + 400; // small lead so the move lands first
  if (app.solo) { beginGame(region, mode, startAt); return; }
  try {
    await app.conn.sendMove({ move_index: 0, player: app.seat, type: 'start', payload: { region, mode, startAt } });
    updateRoomStatus(app.code, 'playing').catch(() => {});
    beginGame(region, mode, startAt);
  } catch (e) {
    // Someone else's start won the index-0 slot — pollOnce picks theirs up.
    $('btn-start').disabled = false;
    app.conn.pollOnce().catch(() => {});
    setStatus(e.message || 'Could not start.');
  }
});

// ---- Phases / timers --------------------------------------------------------------

function setPhase(p) {
  app.phase = p;
  $('prestart-overlay').classList.toggle('hidden', p !== 'config');
  $('countdown-overlay').classList.toggle('hidden', p !== 'countdown');
  $('results-overlay').classList.toggle('hidden', p !== 'results' || app.resultsDismissed);
  if (p === 'config') renderPrestart();
}

async function beginGame(regionId, modeId, startAt) {
  app.regionId = regionId; app.modeId = modeId; app.startAt = startAt;
  setStatus('');
  let data;
  try { data = await loadRegion(regionId); }
  catch (e) { setStatus(`Could not load the map (${e.message}).`); return; }
  app.regionData = data;

  app.map?.destroy();
  app.map = new AtlazMap($('map-host'), data);
  const seed = app.solo ? (Math.random() * 2 ** 31) >>> 0 : (Number(app.room?.seed) >>> 0);
  app.order = questionOrder(data.items, seed);

  const m = modeMeta(modeId);
  $('mode-chip').textContent = `${data.label} · ${m.name}`;
  $('mode-chip').classList.remove('hidden');
  $('timer-chip').classList.remove('hidden');

  if (app.timerInt) clearInterval(app.timerInt);
  app.timerInt = setInterval(tick, 200);
  tick();
}

function tick() {
  if (app.startAt == null) return;
  const now = Date.now();
  const reveal = app.startAt + COUNTDOWN_MS;
  if (now < reveal) {
    setPhase('countdown');
    $('countdown-num').textContent = String(Math.max(1, Math.ceil((reveal - now) / 1000)));
    return;
  }
  if (app.phase === 'countdown' || app.phase === 'config') startPlay();
  if (app.phase === 'playing') renderTimer(now - reveal);
}

function startPlay() {
  // Resuming after our result already landed → straight to the scoreboard.
  if (app.results[app.seat]) {
    app.submittedResult = true;
    setPhase('results');
    onResultsUpdate();
    return;
  }
  setPhase('playing');
  app.ctl?.destroy();
  app.ctl = createMode(app.modeId, {
    map: app.map,
    region: app.regionData,
    order: app.order,
    startedAt: app.startAt + COUNTDOWN_MS,
    restore: loadProgress(),
    onProgress: saveProgress,
    onStatus: setStatus,
    onFinish: onMyFinish,
  });
  app.ctl.start();
  renderPlayers();
}

function renderTimer(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  $('timer-chip').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- Progress persistence (survive a refresh mid-run) ------------------------------

function progressKey() { return `atlaz.progress.${app.solo ? 'solo' : app.code}.${app.seat}`; }
function saveProgress(state) {
  try { localStorage.setItem(progressKey(), JSON.stringify(state)); } catch {}
}
function loadProgress() {
  if (app.solo) return null; // solo runs restart clean
  try { return JSON.parse(localStorage.getItem(progressKey()) || 'null'); } catch { return null; }
}
function clearProgress() { try { localStorage.removeItem(progressKey()); } catch {} }

// ---- Finishing ----------------------------------------------------------------------

async function onMyFinish(result) {
  clearProgress();
  app.results[app.seat] = result;
  app.submittedResult = true;
  app.ctl?.destroy(); app.ctl = null;
  if (app.timerInt && app.solo) { clearInterval(app.timerInt); app.timerInt = null; }
  renderReview(app.map, app.regionData, app.modeId, result); // my own map stays reviewable
  app.viewingSeat = app.seat;
  setPhase('results');
  onResultsUpdate();

  if (!app.solo) {
    const move = { move_index: RESULT_MOVE_BASE + app.seat, player: app.seat, type: 'result', payload: result };
    try { await app.conn.sendMove(move); } catch { /* dup = already stored */ }
  }
}

// Seats that still owe a result (ignoring players flagged as having left).
function pendingSeats() {
  if (app.solo) return [];
  const players = app.room?.players ?? [];
  return players.filter((p) => !app.results[p.seat] && !seatLeft(app.room, p.seat)).map((p) => p.seat);
}

function onResultsUpdate() {
  if (app.phase !== 'results') return;
  const pending = pendingSeats();
  const done = pending.length === 0;
  $('results-waiting').classList.toggle('hidden', done);
  if (!done) {
    const names = pending.map((s) => seatName(app.room, s) || `P${s + 1}`).join(', ');
    $('results-waiting').textContent = `Waiting for ${names}…`;
  }
  renderResults(done);
  if (done && !app.solo) persistResult();
}

function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function resultLine(r) {
  if (!r) return '…';
  if (app.modeId === 'sweep') {
    return r.gaveUp || r.foundCount < r.total
      ? `${r.foundCount}/${r.total} · gave up`
      : `${r.total}/${r.total} · ${fmtTime(r.ms)}`;
  }
  return `${scoreOf(r)}/${r.total} · ${fmtTime(r.ms)}`;
}

function renderResults(complete) {
  const n = seats();
  $('results-title').textContent = app.solo ? 'YOUR RUN' : complete ? 'RESULTS' : 'FINISHED!';
  const ol = $('results-list');
  ol.innerHTML = '';
  const ranked = rankSeats(app.modeId, app.results, n);
  ranked.forEach((seat, i) => {
    const r = app.results[seat];
    if (!r && app.solo) return;
    const li = document.createElement('li');
    if (seat === app.seat) li.className = 'me';
    const name = app.solo ? app.name : (seatName(app.room, seat) || `P${seat + 1}`);
    const leftTag = !app.solo && seatLeft(app.room, seat) && !r ? ' <span class="left-tag">left</span>' : '';
    li.innerHTML = `<span class="r-rank">${r ? i + 1 : '·'}</span>`
      + `<span class="r-name">${esc(name)}${leftTag}</span>`
      + `<span class="r-score">${esc(resultLine(r))}</span>`;
    if (r) li.addEventListener('click', () => { spectate(seat); dismissResults(); });
    ol.appendChild(li);
  });

  const winnerEl = $('results-winner');
  if (app.solo || n <= 1 || !complete) {
    winnerEl.textContent = ''; winnerEl.className = 'results-winner';
  } else {
    const w = winnerSeat(app.modeId, app.results, n);
    if (w === 'tie') { winnerEl.textContent = "It's a tie!"; winnerEl.className = 'results-winner'; }
    else if (w === app.seat) { winnerEl.textContent = 'You won! 🎉'; winnerEl.className = 'results-winner'; }
    else { winnerEl.textContent = `${seatName(app.room, w) || `P${w + 1}`} won`; winnerEl.className = 'results-winner loss'; }
  }

  // Solo gets PLAY AGAIN instead of a rematch, and no room to leave behind.
  $('btn-rematch').textContent = app.solo ? 'PLAY AGAIN' : 'REMATCH';
}

// Store the final standings on the room (idempotent; most complete write wins —
// same pattern as Scramblr).
async function persistResult() {
  if (!app.code || app.resultPersisted) return;
  const n = seats();
  const submitted = Object.keys(app.results).length;
  if (app.resultPersisted && submitted <= app.persistedCount) return;
  app.persistedCount = submitted;
  app.resultPersisted = true;
  const scores = Array.from({ length: n }, (_, s) => scoreOf(app.results[s]));
  const result = { scores, winner: winnerSeat(app.modeId, app.results, n), reason: 'done', region: app.regionId, mode: app.modeId };
  try {
    await finishRoom(app.code, result, false);
    if (app.room) { app.room.status = 'finished'; app.room.result = result; }
  } catch { app.resultPersisted = false; }
}

// ---- Spectating attempts -------------------------------------------------------------

function spectate(seat) {
  const r = app.results[seat];
  if (!r) { setStatus('Their map appears once they finish.'); return; }
  app.viewingSeat = seat;
  renderReview(app.map, app.regionData, app.modeId, r);
  const who = seat === app.seat ? 'your' : `${seatName(app.room, seat) || `P${seat + 1}`}'s`;
  setStatus(seat === app.seat ? '' : `Showing ${who} map — tap your own card to go back.`);
  renderPlayers();
}

function dismissResults() {
  app.resultsDismissed = true;
  $('results-overlay').classList.add('hidden');
  if (!app.solo) setStatus('Tap a player up top to compare maps.');
}
$('btn-results-close').addEventListener('click', dismissResults);
$('btn-results-look').addEventListener('click', dismissResults);

// Re-open the scoreboard from the map view by tapping the timer/mode chips.
$('mode-chip').addEventListener('click', reopenResults);
$('timer-chip').addEventListener('click', reopenResults);
function reopenResults() {
  if (app.results[app.seat] == null) return;
  app.resultsDismissed = false;
  setPhase('results');
}

// ---- Players strip ----------------------------------------------------------------------

function renderPlayers() {
  const strip = $('players-strip');
  const players = app.room?.players ?? [];
  strip.innerHTML = '';
  if (app.solo) { $('spectate-hint').classList.add('hidden'); return; }
  players.forEach((p) => {
    const r = app.results[p.seat];
    const div = document.createElement('div');
    div.className = 'pchip' + (p.seat === app.seat ? ' me' : '')
      + (app.viewingSeat === p.seat && app.results[p.seat] ? ' viewing' : '')
      + (r ? ' done' : '');
    const online = app.online.has(String(p.seat));
    const stat = r ? `${scoreOf(r)}` : (app.phase === 'playing' || app.phase === 'countdown' ? '…' : '·');
    div.innerHTML = `<span class="pdot ${online ? '' : 'off'}"></span>`
      + `<span class="pname">${esc(p.name || `P${p.seat + 1}`)}</span>`
      + `<span class="pscore">${stat}</span>`;
    div.addEventListener('click', () => spectate(p.seat));
    strip.appendChild(div);
  });
  $('spectate-hint').classList.toggle('hidden', !(app.phase === 'results' && players.length >= 2));
}

// ---- Rematch / play again --------------------------------------------------------------

const rematch = createRematch({
  state: app,
  createRoom: (name, userId) => createRoom(name, userId, null, MAX_PLAYERS),
  joinRoom, enterRoom,
  onError: (msg) => setStatus(msg),
});
$('btn-rematch').addEventListener('click', () => {
  if (app.solo) {
    const keep = { ...app.cfgSel };
    enterSolo();
    app.cfgSel = keep;
    renderPrestart();
    return;
  }
  rematch.start();
});

// ---- Zoom controls -------------------------------------------------------------------------

$('btn-zoom-in').addEventListener('click', () => app.map?.zoomBy(1.6));
$('btn-zoom-out').addEventListener('click', () => app.map?.zoomBy(1 / 1.6));
$('btn-zoom-reset').addEventListener('click', () => app.map?.resetView());

// ---- Status / render-all ---------------------------------------------------------------------

function setStatus(msg) { $('status-line').textContent = msg || ''; }

function renderAll() {
  renderPrestart();
  renderPlayers();
}

// ---- Notifications (lobby bell) ---------------------------------------------------------------

async function onToggleNotify() {
  const res = await requestNotifications();
  if (res === 'granted') {
    subscribeToPush({ userId: app.userId || undefined }).catch(() => {});
    revealNotify();
  }
}
$('btn-notify-lobby').addEventListener('click', onToggleNotify);

function revealNotify() {
  const btn = $('btn-notify-lobby');
  const show = notificationsSupported() && notificationPermission() !== 'denied' && !notifyEnabled();
  btn.classList.toggle('hidden', !show);
}

// ---- Resume / boot ------------------------------------------------------------------------------

async function tryResume() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  try {
    const { code, name } = JSON.parse(raw);
    const { room, playerIndex } = await joinRoom(code, name, app.userId);
    await enterRoom(code, playerIndex, name, room);
    return true;
  } catch { sessionStorage.removeItem(SESSION_KEY); return false; }
}

async function boot() {
  registerServiceWorker();
  window.LB_CONFIG.onChallengeFriend = challengeFriend;
  buildCfgButtons();
  loadCfg();
  if (!configReady()) landingError('Backend not configured.');
  try { app.user = await currentUser(); } catch {}
  app.userId = app.user?.id ?? null;
  app.name = playerName();
  onAuthChange(onAuth);

  const resumed = await tryResume();
  if (!resumed) onAuth(app.user);
}

// Close the help modal on backdrop / buttons (account-ui wires its own modals).
$('help-modal')?.addEventListener('click', (e) => { if (e.target === $('help-modal')) $('help-modal').classList.add('hidden'); });
$('help-close')?.addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-got-it')?.addEventListener('click', () => $('help-modal').classList.add('hidden'));

boot();
