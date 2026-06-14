// Supabase project configuration.
//
// The anon ("publishable") key is safe to ship in client code — access is
// controlled by Row Level Security. Find it in the Supabase dashboard under
// Project Settings -> API Keys.
//
// This is the SAME project Wurdz uses: accounts live at the project level, so
// one login works across every game that points here. Only GAME_SLUG /
// GAME_NAME change per game.

export const SUPABASE_URL = 'https://ymeobjtrhxbwywcvaova.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_xic2yc7GGMKvfs6D09MzQA_rcGvFMwT';

// Per-game identity. Several small games can share one Supabase project (and
// therefore one set of accounts). GAME_SLUG keeps each game's leaderboard
// rows separate. Change these two lines — nothing else — when copying the
// account layer to another game.
export const GAME_SLUG = 'chromagrid';
export const GAME_NAME = 'Chromagrid';

export function configReady() {
  return SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith('PASTE_');
}
