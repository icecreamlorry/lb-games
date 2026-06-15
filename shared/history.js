// Shared "Game history" panel for LB Games.
//
// Game-agnostic: it reads finished rooms (rooms.status='finished' with a stored
// rooms.result) and renders outcomes straight from that result + the room's
// player list — no move replay needed. Works for 2-player games (Wurdz) and
// N-player games (Scramblr) alike.
//
// Open it from a game's lobby:
//   import { openHistory } from '../shared/history.js';
//   openHistory({ userId, gameSlug });                    // all opponents
//   openHistory({ userId, gameSlug, friendId, friendName }); // pre-filtered
//
// It brings its own styles (scoped .lbh-*) so no per-game CSS is required.

import { fetchFinishedRooms, userSeat } from './rooms.js';
import { listFriends } from './friends.js';

const $ = (id) => document.getElementById(id);

const state = {
  userId: null,
  gameSlug: null,
  rooms: [],
  friends: [],
  filter: 'all', // 'all' or a friend userId
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---- styles ---------------------------------------------------------------

function injectStyles() {
  if ($('lbh-styles')) return;
  const style = document.createElement('style');
  style.id = 'lbh-styles';
  style.textContent = `
    #lbh-modal {
      position: fixed; inset: 0; z-index: 970;
      display: none; align-items: center; justify-content: center;
      background: rgba(2,2,8,0.82);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      padding: 16px; font-family: 'Share Tech Mono', ui-monospace, monospace;
    }
    #lbh-modal.lbh-open { display: flex; }
    .lbh-panel {
      width: 100%; max-width: 480px; max-height: 88vh;
      display: flex; flex-direction: column;
      background: #07071a; color: #cfe9ee;
      border: 1px solid rgba(0,245,255,0.28); border-radius: 6px;
      box-shadow: 0 0 40px rgba(0,245,255,0.08), inset 0 0 60px rgba(0,0,0,0.5);
    }
    .lbh-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid rgba(0,245,255,0.18); }
    .lbh-title {
      flex: 1; font-family: 'Orbitron', monospace; font-weight: 800;
      font-size: 0.74rem; letter-spacing: 0.22em; color: #00f5ff;
      text-shadow: 0 0 10px rgba(0,245,255,0.6); text-transform: uppercase;
    }
    .lbh-x {
      background: transparent; color: #ff5ad8; border: 1px solid rgba(255,0,200,0.5);
      border-radius: 3px; padding: 5px 10px; font-family: inherit; font-size: 0.62rem;
      letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer;
    }
    .lbh-x:hover { background: rgba(255,0,200,0.14); color: #fff; }
    .lbh-filter { padding: 10px 14px; border-bottom: 1px solid rgba(0,245,255,0.12); display: flex; align-items: center; gap: 8px; }
    .lbh-filter label { font-size: 0.6rem; letter-spacing: 0.12em; color: rgba(0,245,255,0.55); text-transform: uppercase; }
    .lbh-select {
      flex: 1; background: rgba(0,245,255,0.05); color: #cfe9ee;
      border: 1px solid rgba(0,245,255,0.25); border-radius: 3px;
      padding: 6px 8px; font-family: inherit; font-size: 0.72rem;
    }
    .lbh-body { overflow-y: auto; padding: 8px 10px; }
    .lbh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .lbh-item {
      display: grid; grid-template-columns: 1fr auto; gap: 4px 10px;
      padding: 9px 11px; border-radius: 4px;
      background: rgba(0,245,255,0.04); border: 1px solid rgba(0,245,255,0.12);
      border-left-width: 3px;
    }
    .lbh-item.won  { border-left-color: #1fd98a; }
    .lbh-item.lost { border-left-color: #ff3b5c; }
    .lbh-item.tie  { border-left-color: #ffd23b; }
    .lbh-opp { font-size: 0.8rem; color: #d6eef2; }
    .lbh-outcome { font-family: 'Orbitron', monospace; font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; text-align: right; }
    .lbh-item.won  .lbh-outcome { color: #2ee6a0; }
    .lbh-item.lost .lbh-outcome { color: #ff6a85; }
    .lbh-item.tie  .lbh-outcome { color: #ffe06a; }
    .lbh-sub { font-size: 0.66rem; color: rgba(0,245,255,0.55); }
    .lbh-score { font-variant-numeric: tabular-nums; font-size: 0.72rem; color: rgba(0,245,255,0.85); text-align: right; }
    .lbh-empty { padding: 26px 12px; text-align: center; color: rgba(0,245,255,0.45); font-size: 0.72rem; line-height: 1.6; }
  `;
  document.head.appendChild(style);
}

// ---- panel ----------------------------------------------------------------

function buildPanel() {
  if ($('lbh-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'lbh-modal';
  modal.innerHTML = `
    <div class="lbh-panel">
      <div class="lbh-head">
        <span class="lbh-title">Game History</span>
        <button class="lbh-x" id="lbh-close">Close</button>
      </div>
      <div class="lbh-filter">
        <label for="lbh-friend">Vs</label>
        <select class="lbh-select" id="lbh-friend"><option value="all">All opponents</option></select>
      </div>
      <div class="lbh-body"><ul class="lbh-list" id="lbh-list"></ul></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closePanel(); });
  $('lbh-close').addEventListener('click', closePanel);
  $('lbh-friend').addEventListener('change', (e) => { state.filter = e.target.value; renderList(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) closePanel(); });
}

function renderFriendSelect() {
  const sel = $('lbh-friend');
  sel.innerHTML = '<option value="all">All opponents</option>';
  for (const f of state.friends) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.display_name || 'Player';
    sel.appendChild(opt);
  }
  sel.value = state.filter;
}

// Turn one finished room into the data the list needs.
function describe(room) {
  const mySeat = userSeat(room, state.userId);
  const players = room.players ?? [];
  const scores = room.result?.scores ?? [];
  const winner = room.result?.winner;
  const myScore = Number(scores[mySeat] ?? 0);
  const opponents = players.filter((p) => p.seat !== mySeat);
  const oppNames = opponents.map((p) => p.name || 'Player').join(', ') || 'Opponent';

  let outcome = 'Tie', cls = 'tie';
  if (winner === mySeat) { outcome = 'Won'; cls = 'won'; }
  else if (winner != null && winner !== 'tie') { outcome = 'Lost'; cls = 'lost'; }

  let scoreLine, sub;
  if (players.length <= 2) {
    const oppScore = Number(scores[opponents[0]?.seat] ?? 0);
    scoreLine = `${myScore} – ${oppScore}`;
    sub = `vs ${oppNames}`;
  } else {
    const rank = scores.map((s, i) => ({ seat: i, s: Number(s) }))
      .sort((a, b) => b.s - a.s)
      .findIndex((r) => r.seat === mySeat) + 1;
    scoreLine = String(myScore);
    sub = `${ordinal(rank)} of ${players.length} · vs ${oppNames}`;
  }
  return { cls, outcome, scoreLine, sub, date: fmtDate(room.result?.endedAt || room.last_move_at || room.created_at) };
}

function filteredRooms() {
  if (state.filter === 'all') return state.rooms;
  return state.rooms.filter((room) =>
    (room.players ?? []).some((p) => p.userId === state.filter && p.userId !== state.userId)
  );
}

function renderList() {
  const el = $('lbh-list');
  const rooms = filteredRooms();
  if (!rooms.length) {
    el.innerHTML = `<li class="lbh-empty">${state.filter === 'all'
      ? 'No finished games yet.'
      : 'No finished games against this friend yet.'}</li>`;
    return;
  }
  el.innerHTML = '';
  for (const room of rooms) {
    const d = describe(room);
    const li = document.createElement('li');
    li.className = 'lbh-item ' + d.cls;
    li.innerHTML =
      `<span class="lbh-opp">${esc(d.sub)}</span>` +
      `<span class="lbh-outcome">${esc(d.outcome)}</span>` +
      `<span class="lbh-sub">${esc(d.date)}</span>` +
      `<span class="lbh-score">${esc(d.scoreLine)}</span>`;
    el.appendChild(li);
  }
}

function isOpen() { return $('lbh-modal')?.classList.contains('lbh-open'); }
function closePanel() { $('lbh-modal')?.classList.remove('lbh-open'); }

export async function openHistory({ userId, gameSlug, friendId = 'all', friendName } = {}) {
  if (!userId) return;
  injectStyles();
  buildPanel();
  state.userId = userId;
  state.gameSlug = gameSlug;
  state.filter = friendId || 'all';
  $('lbh-modal').classList.add('lbh-open');
  $('app-menu')?.classList.add('hidden');

  const list = $('lbh-list');
  list.innerHTML = '<li class="lbh-empty">Loading…</li>';

  const [rooms, friends] = await Promise.all([
    fetchFinishedRooms(userId, gameSlug).catch(() => []),
    listFriends().catch(() => []),
  ]);
  state.rooms = rooms;
  state.friends = friends;

  // If a friend was pre-selected but isn't in the list yet, add a stub so the
  // dropdown shows them.
  if (friendId && friendId !== 'all' && !friends.some((f) => f.id === friendId)) {
    state.friends = [{ id: friendId, display_name: friendName || 'Player' }, ...friends];
  }
  renderFriendSelect();
  renderList();
}
