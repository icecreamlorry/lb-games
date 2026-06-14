// Chromagrid leaderboard — read/write high scores in the shared Supabase
// project. Game-independent in spirit: every row carries the GAME_SLUG so the
// same `scores` table can serve other games in the same project.
//
// A player is identified by a stable key:
//   • logged in → 'u:<auth user id>'
//   • guest     → 'g:<random id kept in localStorage>'
// so a returning guest keeps updating their own row instead of spamming new
// ones. Scores are written through the submit_score() RPC, which keeps the
// higher of the old/new score atomically.

import { supabase } from './supabaseClient.js';
import { GAME_SLUG, configReady } from './config.js';

const GUEST_ID_KEY = 'chromagrid.guestId';

function randomId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function guestId() {
  let id = localStorage.getItem(GUEST_ID_KEY);
  if (!id) { id = randomId(); localStorage.setItem(GUEST_ID_KEY, id); }
  return id;
}

// Stable per-player key for the current identity.
export function playerKey(user) {
  return user ? 'u:' + user.id : 'g:' + guestId();
}

// Submit a finished run. Keeps the player's best automatically (server-side).
// Returns the player's stored best after the write.
export async function submitScore({ score, name, user }) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  const key = playerKey(user);
  const { error } = await supabase().rpc('submit_score', {
    p_game: GAME_SLUG,
    p_player_key: key,
    p_name: (name || '').trim() || 'Player',
    p_score: Math.max(0, Math.round(score || 0)),
    p_user_id: user?.id ?? null,
  });
  if (error) throw error;
  return myBest({ user });
}

// Top N scores for this game, highest first.
export async function topScores(limit = 10) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  const { data, error } = await supabase()
    .from('scores')
    .select('name, score, player_key, updated_at')
    .eq('game', GAME_SLUG)
    .order('score', { ascending: false })
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// Leaderboard filtered to the signed-in player and their accepted friends,
// highest first. Requires being logged in (friends need accounts); guests get
// an empty list. Backed by the friends_leaderboard() RPC.
export async function friendScores(limit = 50) {
  if (!configReady()) throw new Error('Leaderboard not configured');
  const { data, error } = await supabase().rpc('friends_leaderboard', { p_game: GAME_SLUG });
  if (error) throw error;
  return (data ?? []).slice(0, limit);
}

// The current player's stored best (0 if none yet).
export async function myBest({ user }) {
  if (!configReady()) return 0;
  const { data, error } = await supabase()
    .from('scores')
    .select('score')
    .eq('game', GAME_SLUG)
    .eq('player_key', playerKey(user))
    .maybeSingle();
  if (error) throw error;
  return data?.score ?? 0;
}
