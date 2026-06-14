// Leaderboard — read/write high scores in the shared Supabase project.
//
// Game-independent: every row carries the game slug so the same `scores`
// table serves all LB Games titles. Per-game identity comes from
// window.LB_CONFIG (set by each game's HTML before loading this module).
//
// A player is identified by a stable key:
//   • logged in → 'u:<auth user id>'
//   • guest     → 'g:<random id in localStorage>'
// so a returning guest keeps updating their own row. Scores are written
// through submit_score() which keeps the higher value atomically.

import { supabase } from './supabaseClient.js';
import { configReady } from './supabase-config.js';

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
  const key = playerKey(user);
  const { error } = await supabase().rpc('submit_score', {
    p_game:       gameSlug(),
    p_player_key: key,
    p_name:       (name || '').trim() || 'Player',
    p_score:      Math.max(0, Math.round(score || 0)),
    p_user_id:    user?.id ?? null,
  });
  if (error) throw error;
  return myBest({ user });
}

export async function topScores(limit = 10) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  const { data, error } = await supabase()
    .from('scores')
    .select('name, score, player_key, updated_at')
    .eq('game', gameSlug())
    .order('score', { ascending: false })
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function friendScores(limit = 50) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  const { data, error } = await supabase().rpc('friends_leaderboard', { p_game: gameSlug() });
  if (error) throw error;
  return (data ?? []).slice(0, limit);
}

export async function myBest({ user }) {
  if (!configReady()) return 0;
  const { data, error } = await supabase()
    .from('scores')
    .select('score')
    .eq('game', gameSlug())
    .eq('player_key', playerKey(user))
    .maybeSingle();
  if (error) throw error;
  return data?.score ?? 0;
}
