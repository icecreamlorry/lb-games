// Leaderboard — read/write high scores through the LB Games API.
//
// Game-independent: every row carries the game slug so the same `scores`
// table serves all LB Games titles. Per-game identity comes from
// window.LB_CONFIG (set by each game's HTML before loading this module).
//
// A player is identified by a stable key:
//   • logged in → 'u:<auth user id>'
//   • guest     → 'g:<random id in localStorage>'
// so a returning guest keeps updating their own row. Scores are written
// through POST /scores, which keeps the higher value atomically.

import { api } from './api.js';
import { configReady } from './api-config.js';

function cfg() { return window.LB_CONFIG || {}; }
function gameSlug() { return cfg().gameSlug || 'unknown'; }
function guestIdKey() { return cfg().guestIdKey || 'lb.guest.' + gameSlug(); }

function randomId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function guestId() {
  const key = guestIdKey();
  let id = localStorage.getItem(key);
  if (!id) { id = randomId(); localStorage.setItem(key, id); }
  return id;
}

export function playerKey(user) {
  return user ? 'u:' + user.id : 'g:' + guestId();
}

export async function submitScore({ score, name, user }) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  await postScore(gameSlug(), playerKey(user), name, score);
  return myBest({ user });
}

// Record a score for any leaderboard key (the daily boards use
// '<slug>-daily-YYYYMMDD'). Signed-in players are identified by the session.
export async function postScore(game, player_key, name, score) {
  await api('/scores', {
    method: 'POST',
    body: {
      game,
      player_key,
      name: (name || '').trim() || 'Player',
      score: Math.max(0, Math.round(score || 0)),
    },
  });
}

// Top rows for any leaderboard key: [{ name, score, player_key, updated_at }].
export async function fetchTopScores(game, limit = 10) {
  return (await api(`/scores?game=${encodeURIComponent(game)}&limit=${limit}`)) ?? [];
}

// One player's stored score for a leaderboard key, or null.
export async function fetchScoreFor(game, player_key) {
  const r = await api(`/scores/mine?game=${encodeURIComponent(game)}&key=${encodeURIComponent(player_key)}`);
  return r?.score ?? null;
}

export async function topScores(limit = 10) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  return fetchTopScores(gameSlug(), limit);
}

export async function friendScores(limit = 50) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  const data = await api(`/scores/friends?game=${encodeURIComponent(gameSlug())}`);
  return (data ?? []).slice(0, limit);
}

export async function myBest({ user }) {
  if (!configReady()) return 0;
  return (await fetchScoreFor(gameSlug(), playerKey(user))) ?? 0;
}
