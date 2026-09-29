// shared/home-dashboard.js — the landing page's two cross-game dashboards:
//
//   1. "Your games" — every open invite and every room where it's YOUR turn,
//      across all the room-based games, in one place. Signed-in only (guests
//      have no server-side games list). Clicking a card opens that game already
//      pointed at the right room (?room=CODE).
//
//   2. "Daily challenges" — every game that has a real daily challenge, showing
//      whether you've done today's and your score vs the day's high score.
//      Clicking opens the game straight into today's daily (?daily).
//
// Turn detection reuses each game's OWN engine: the turn-based games all fold
// their move log with `replayMoves(seed, moves) -> { turn, gameOver }` (the same
// call their lobbies use), so "your turn" here means exactly what it means in
// the game. Nothing is stored or duplicated — we import the engine lazily and
// only for rooms actually in progress.

import { configReady } from './api-config.js';
import { fetchTopScores, fetchScoreFor } from './leaderboard.js';
import { fetchMyRooms, fetchMoves, seatName, userSeat } from './rooms.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Game registry ----------------------------------------------------------
// kind: how "your turn" is decided for a room-based game.
//   'replay'   — fold with the game's replayMoves(seed, moves) -> {turn,gameOver}
//   'lexicorp' — fold with initialState/applyMove/whoseTurn (its own shape)
//   'race'     — simultaneous race, no per-player turn (invites only)
const ROOM_GAMES = [
  { slug: 'chromagrid', name: 'Chromagrid', href: 'chromagrid/', kind: 'race' },
  { slug: 'wurdz', name: 'Wurdz', href: 'wurdz/', kind: 'replay' },
  { slug: 'scramblr', name: 'Scramblr', href: 'scramblr/', kind: 'race' },
  { slug: 'splitz', name: 'Splitz', href: 'splitz/', kind: 'race' },
  { slug: 'lexicorp', name: 'Lexicorp', href: 'lexicorp/', kind: 'lexicorp' },
  { slug: 'atlaz', name: 'Atlaz', href: 'atlaz/', kind: 'race' },
  { slug: 'flagz', name: 'Flagz', href: 'flagz/', kind: 'race' },
  { slug: 'atomyx', name: 'Atomyx', href: 'atomyx/', kind: 'race' },
  { slug: 'buffz', name: 'Buffz', href: 'buffz/', kind: 'race' },
  { slug: 'weiqi', name: 'Weiqi', href: 'weiqi/', kind: 'replay' },
  { slug: 'chess', name: 'Chess', href: 'chess/', kind: 'replay' },
  { slug: 'draughts', name: 'Draughts', href: 'draughts/', kind: 'replay' },
  { slug: 'backgammon', name: 'Backgammon', href: 'backgammon/', kind: 'replay' },
  { slug: 'rummikub', name: 'Rummikub', href: 'rummikub/', kind: 'replay' },
  { slug: 'reversi', name: 'Reversi', href: 'reversi/', kind: 'replay' },
  { slug: 'dominoes', name: 'Dominoes', href: 'dominoes/', kind: 'replay' },
  { slug: 'chrono', name: 'Chrono', href: 'chrono/', kind: 'race' },
];

const DAILY_GAMES = [
  { slug: 'chromagrid', name: 'Chromagrid', href: 'chromagrid/' },
  { slug: 'scramblr', name: 'Scramblr', href: 'scramblr/' },
];

// Initials fallback shown behind the favicon (if the icon fails to load).
const badge = (name) => esc(name.slice(0, 2).toUpperCase());
// Each game's favicon
const iconFor = (game) => `${game.href}icons/icon.svg`;
const badgeHtml = (game) => `<span class="dash-badge">${badge(game.name)}<img src="${iconFor(game)}" alt="" onerror="this.remove()"></span>`;

// ---- Turn resolution (reuses each game's engine) ----------------------------

const engineCache = {};
function loadEngine(slug) { return (engineCache[slug] ??= import(`../${slug}/js/engine.js`)); }

// Returns { turn: seat, over: bool } for a room, or null if it can't be told.
async function resolveTurn(game, room) {
  try {
    const moves = await fetchMoves(room.code);
    if (game.kind === 'lexicorp') {
      const { initialState, applyMove, whoseTurn } = await loadEngine('lexicorp');
      const players = (room.players ?? []).length || 2;
      const g = initialState(Number(room.seed), players);
      let started = false;
      for (const m of moves) { try { applyMove(g, m); started = true; } catch { /* skip unappliable */ } }
      if (!started) return null;
      return { turn: whoseTurn(g), over: !!g.ended };
    }
    const { replayMoves } = await loadEngine(game.slug);
    const st = replayMoves(room.seed, moves);
    if (!st || !st.started) return null;
    return { turn: st.turn, over: !!(st.gameOver || st.ended) };
  } catch {
    return null; // engine load / replay failed — just don't claim a turn
  }
}

// ---- Pure classification (unit-tested) --------------------------------------
// Given a room + my user id + (optional) resolved turn, decide what dashboard
// row it is: an open invite, my turn, or nothing to surface.
export function classifyRoom(room, userId, turn /* {turn,over}|null */) {
  if (!room || room.status === 'finished') return null;
  const mySeat = userSeat(room, userId);
  const invitedMe = room.invited_user_id === userId && mySeat === -1;
  if (invitedMe) {
    const host = seatName(room, 0) || 'Someone';
    return { kind: 'invite', label: `${host} invited you`, sub: 'Tap to accept' };
  }
  if (mySeat === -1) return null;             // not my seat, not an invite
  if (room.status !== 'playing') return null; // waiting to start / lobby — not "my turn"
  if (!turn || turn.over) return null;        // race game, unknown, or finished
  if (turn.turn !== mySeat) return null;      // opponent's turn
  const opp = seatName(room, mySeat === 0 ? 1 : 0) || 'opponent';
  return { kind: 'turn', label: `Your turn vs ${opp}`, sub: 'Tap to play your move' };
}

// ---- Your games -------------------------------------------------------------

async function collectYourGames(userId) {
  const perGame = await Promise.all(ROOM_GAMES.map(async (game) => {
    let rooms = [];
    try { rooms = await fetchMyRooms(userId, game.slug); } catch { rooms = []; }
    const rows = [];
    for (const room of rooms) {
      // Cheap pass first: invites need no move fold.
      const quick = classifyRoom(room, userId, null);
      if (quick && quick.kind === 'invite') { rows.push({ game, room, ...quick }); continue; }
      // Only in-progress turn-based rooms need a fold.
      if (room.status === 'playing' && userSeat(room, userId) !== -1 && game.kind !== 'race') {
        const turn = await resolveTurn(game, room);
        const c = classifyRoom(room, userId, turn);
        if (c) rows.push({ game, room, ...c });
      }
    }
    return rows;
  }));
  const rows = perGame.flat();
  // Invites first, then most-recently-active.
  rows.sort((a, b) => {
    if ((a.kind === 'invite') !== (b.kind === 'invite')) return a.kind === 'invite' ? -1 : 1;
    return new Date(b.room.last_move_at || 0) - new Date(a.room.last_move_at || 0);
  });
  return rows;
}

function renderYourGames(rows) {
  const section = $('home-yourgames');
  const list = $('yourgames-list');
  if (!section || !list) return;
  if (!rows.length) { section.classList.add('hidden'); return; }
  list.innerHTML = '';
  for (const r of rows) {
    const a = document.createElement('a');
    a.className = 'dash-card is-mine';
    a.href = `${r.game.href}?room=${encodeURIComponent(r.room.code)}`;
    const tag = r.kind === 'invite' ? 'invite' : 'turn';
    const tagText = r.kind === 'invite' ? 'Invite' : 'Your turn';
    a.innerHTML = badgeHtml(r.game)
      + `<span class="dash-body"><span class="dash-game">${esc(r.game.name)}</span>`
      + `<span class="dash-line">${esc(r.label)}</span></span>`
      + `<span class="dash-tag ${tag}">${tagText}</span>`;
    list.appendChild(a);
  }
  section.classList.remove('hidden');
}

// ---- Daily challenges -------------------------------------------------------

function utcCompact(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
function dailySlug(slug) { return `${slug}-daily-${utcCompact()}`; }

// The player key a game would have used for today's score: signed-in users key
// on their user id (stable across games); guests key on the per-game guest id
// that game stored in localStorage (only present if they've played it).
function playerKeyFor(slug, user) {
  if (user) return `u:${user.id}`;
  try { const g = localStorage.getItem(`lb.guest.${slug}`); return g ? `g:${g}` : null; }
  catch { return null; }
}

async function dailyStatus(game, user) {
  const slug = dailySlug(game.slug);
  let high = null, mine = null;
  try {
    const top = await fetchTopScores(slug, 1);
    high = top && top[0] ? top[0] : null;
    const key = playerKeyFor(game.slug, user);
    if (key) mine = await fetchScoreFor(slug, key);
  } catch { /* leave nulls — still render the "play today" card */ }
  return { game, high, mine };
}

function renderDaily(statuses) {
  const section = $('home-daily');
  const list = $('daily-list');
  if (!section || !list) return;
  list.innerHTML = '';
  for (const s of statuses) {
    const a = document.createElement('a');
    const done = s.mine != null;
    a.className = 'dash-card' + (done ? '' : ' is-mine');
    a.href = `${s.game.href}?daily`;
    const bestTxt = s.high ? `best ${Number(s.high.score).toLocaleString()}` : 'no scores yet';
    const line = done
      ? `Done — ${Number(s.mine).toLocaleString()} · ${bestTxt}`
      : `Play today · ${bestTxt}`;
    const tag = done ? 'done' : 'todo';
    const tagText = done ? 'Done' : 'Play';
    a.innerHTML = badgeHtml(s.game)
      + `<span class="dash-body"><span class="dash-game">${esc(s.game.name)}</span>`
      + `<span class="dash-line">${esc(line)}</span></span>`
      + `<span class="dash-tag ${tag}">${tagText}</span>`;
    list.appendChild(a);
  }
  section.classList.remove('hidden');
}

// ---- Orchestration ----------------------------------------------------------

let lastUserId = undefined;
async function refresh(user) {
  if (!configReady()) return;
  // Daily area is public (high scores are); "your games" needs a signed-in user.
  dailyStatus && Promise.all(DAILY_GAMES.map((g) => dailyStatus(g, user))).then(renderDaily).catch(() => {});
  if (user) {
    collectYourGames(user.id).then(renderYourGames).catch(() => {});
  } else {
    $('home-yourgames')?.classList.add('hidden');
  }
}

// Called by the landing page. Re-runs when auth resolves/changes.
export function initHomeDashboard({ cachedUser, onAuthChange }) {
  refresh(cachedUser());
  onAuthChange((user) => {
    const id = user?.id ?? null;
    if (id === lastUserId) return; // ignore duplicate INITIAL_SESSION echoes
    lastUserId = id;
    refresh(user);
  });
}
