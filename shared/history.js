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
  // Theme-token driven (shared.css :root vars) so Synth/Maritime/Pastel all
  // reskin the panel — this used to be hard-coded Synth neon in every game.
  style.textContent = `
    #lbh-modal {
      position: fixed; inset: 0; z-index: 970;
      display: none; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--dark) 82%, transparent);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      padding: 16px; font-family: var(--font-mono);
    }
    #lbh-modal.lbh-open { display: flex; }
    .lbh-panel {
      width: 100%; max-width: 480px; max-height: 88vh;
      display: flex; flex-direction: column;
      background: var(--panel); color: var(--cyan);
      border: 1px solid color-mix(in srgb, var(--cyan) 28%, transparent);
      border-radius: var(--panel-radius);
      box-shadow: var(--panel-aura, 0 16px 40px rgba(0,0,0,0.3));
    }
    .lbh-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid color-mix(in srgb, var(--cyan) 18%, transparent); }
    .lbh-title {
      flex: 1; font-family: var(--font-ui); font-weight: 800;
      font-size: 0.74rem; letter-spacing: var(--ui-tracking); color: var(--cyan);
      text-shadow: var(--glow-cyan, none); text-transform: var(--ui-transform);
    }
    .lbh-x {
      background: transparent; color: var(--magenta);
      border: 1px solid color-mix(in srgb, var(--magenta) 50%, transparent);
      border-radius: var(--ui-radius); padding: 5px 10px; font-family: var(--font-ui); font-size: 0.62rem;
      letter-spacing: var(--ui-tracking); text-transform: var(--ui-transform); cursor: pointer;
    }
    .lbh-x:hover { background: color-mix(in srgb, var(--magenta) 14%, transparent); }
    .lbh-filter { padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, var(--cyan) 12%, transparent); display: flex; align-items: center; gap: 8px; }
    .lbh-filter label { font-size: 0.6rem; letter-spacing: 0.12em; color: color-mix(in srgb, var(--cyan) 55%, transparent); text-transform: uppercase; }
    .lbh-dd { position: relative; flex: 1; }
    .lbh-dd-btn {
      width: 100%; display: flex; align-items: center; gap: 8px;
      background: color-mix(in srgb, var(--cyan) 5%, transparent); color: var(--cyan);
      border: 1px solid color-mix(in srgb, var(--cyan) 25%, transparent); border-radius: var(--ui-radius);
      padding: 7px 10px; font-family: inherit; font-size: 0.72rem; cursor: pointer; text-align: left;
    }
    .lbh-dd-btn:hover { border-color: color-mix(in srgb, var(--cyan) 50%, transparent); }
    .lbh-dd-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lbh-dd-caret { color: color-mix(in srgb, var(--cyan) 60%, transparent); font-size: 0.6rem; transition: transform 0.15s; }
    .lbh-dd.open .lbh-dd-caret { transform: rotate(180deg); }
    .lbh-dd-menu {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 5;
      list-style: none; margin: 0; padding: 4px;
      max-height: 240px; overflow-y: auto;
      background: var(--panel); border: 1px solid color-mix(in srgb, var(--cyan) 30%, transparent);
      border-radius: var(--ui-radius);
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    }
    .lbh-dd-menu.hidden { display: none; }
    .lbh-dd-item {
      padding: 8px 10px; border-radius: var(--ui-radius); font-size: 0.72rem; color: var(--cyan); cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .lbh-dd-item:hover { background: color-mix(in srgb, var(--cyan) 10%, transparent); }
    .lbh-dd-item.sel { background: color-mix(in srgb, var(--cyan) 16%, transparent); }
    .lbh-body { overflow-y: auto; padding: 8px 10px; }
    .lbh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .lbh-item {
      display: grid; grid-template-columns: 1fr auto; gap: 4px 10px;
      padding: 9px 11px; border-radius: var(--item-radius);
      background: color-mix(in srgb, var(--cyan) 4%, transparent);
      border: 1px solid color-mix(in srgb, var(--cyan) 12%, transparent);
      border-left-width: 3px;
    }
    .lbh-item.won  { border-left-color: #1fd98a; }
    .lbh-item.lost { border-left-color: #ff3b5c; }
    .lbh-item.tie  { border-left-color: #ffd23b; }
    .lbh-opp { font-size: 0.8rem; color: var(--cyan); }
    .lbh-outcome { font-family: var(--font-ui); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; text-align: right; }
    .lbh-item.won  .lbh-outcome { color: #2ee6a0; }
    .lbh-item.lost .lbh-outcome { color: #ff6a85; }
    .lbh-item.tie  .lbh-outcome { color: #d8b93a; }
    .lbh-sub { font-size: 0.66rem; color: color-mix(in srgb, var(--cyan) 55%, transparent); }
    .lbh-score { font-variant-numeric: tabular-nums; font-size: 0.72rem; color: color-mix(in srgb, var(--cyan) 85%, transparent); text-align: right; }
    .lbh-empty { padding: 26px 12px; text-align: center; color: color-mix(in srgb, var(--cyan) 45%, transparent); font-size: 0.72rem; line-height: 1.6; }
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
        <label>Vs</label>
        <div class="lbh-dd" id="lbh-dd">
          <button type="button" class="lbh-dd-btn" id="lbh-dd-btn" aria-haspopup="listbox" aria-expanded="false">
            <span class="lbh-dd-label" id="lbh-dd-label">All opponents</span>
            <span class="lbh-dd-caret">▾</span>
          </button>
          <ul class="lbh-dd-menu hidden" id="lbh-dd-menu" role="listbox"></ul>
        </div>
      </div>
      <div class="lbh-body"><ul class="lbh-list" id="lbh-list"></ul></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closePanel(); });
  $('lbh-close').addEventListener('click', closePanel);
  $('lbh-dd-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(); });
  // Close the dropdown when clicking elsewhere inside the panel.
  modal.addEventListener('click', () => closeDropdown());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isDropdownOpen()) closeDropdown();
    else if (isOpen()) closePanel();
  });
}

// Options for the friend filter: "All opponents" plus each friend.
function filterOptions() {
  return [{ value: 'all', label: 'All opponents' },
    ...state.friends.map((f) => ({ value: f.id, label: f.display_name || 'Player' }))];
}

function currentFilterLabel() {
  return filterOptions().find((o) => o.value === state.filter)?.label || 'All opponents';
}

function renderFriendSelect() {
  $('lbh-dd-label').textContent = currentFilterLabel();
  const menu = $('lbh-dd-menu');
  menu.innerHTML = '';
  for (const o of filterOptions()) {
    const li = document.createElement('li');
    li.className = 'lbh-dd-item' + (o.value === state.filter ? ' sel' : '');
    li.setAttribute('role', 'option');
    li.textContent = o.label;
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      state.filter = o.value;
      closeDropdown();
      renderFriendSelect();
      renderList();
    });
    menu.appendChild(li);
  }
}

function isDropdownOpen() { return $('lbh-dd')?.classList.contains('open'); }
function toggleDropdown() { isDropdownOpen() ? closeDropdown() : openDropdown(); }
function openDropdown() {
  $('lbh-dd').classList.add('open');
  $('lbh-dd-menu').classList.remove('hidden');
  $('lbh-dd-btn').setAttribute('aria-expanded', 'true');
}
function closeDropdown() {
  $('lbh-dd')?.classList.remove('open');
  $('lbh-dd-menu')?.classList.add('hidden');
  $('lbh-dd-btn')?.setAttribute('aria-expanded', 'false');
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
  // Optional per-game detail (Atlaz: "Europe · Pinpoint") appended to the sub line.
  let detail = '';
  try { detail = window.LB_CONFIG?.historyDetail?.(room) || ''; } catch { /* cosmetic */ }
  if (detail) sub += ` · ${detail}`;
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
  closeDropdown();
  $('lbh-modal').classList.add('lbh-open');
  $('app-menu')?.classList.add('hidden');

  const list = $('lbh-list');
  list.innerHTML = '<li class="lbh-empty">Loading…</li>';

  const [rooms, friends] = await Promise.all([
    fetchFinishedRooms(userId, gameSlug).catch(() => []),
    listFriends().catch(() => []),
  ]);
  // Practice runs (rooms that only ever had one player) aren't history.
  state.rooms = rooms.filter((r) => (r.players?.length ?? 0) >= 2);
  state.friends = friends;

  // If a friend was pre-selected but isn't in the list yet, add a stub so the
  // dropdown shows them.
  if (friendId && friendId !== 'all' && !friends.some((f) => f.id === friendId)) {
    state.friends = [{ id: friendId, display_name: friendName || 'Player' }, ...friends];
  }
  renderFriendSelect();
  renderList();
}
