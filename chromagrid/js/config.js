// Chromagrid per-game configuration.
//
// Project-level Supabase credentials are shared by every LB Games title and
// live in shared/supabase-config.js — re-exported so this game's modules keep
// importing them from one place. Only this game's identity lives here.

export { SUPABASE_URL, SUPABASE_ANON_KEY, configReady } from '../../shared/supabase-config.js';

// GAME_SLUG keeps this game's rooms separate in the shared "My Games" tables.
export const GAME_SLUG = 'chromagrid';
export const GAME_NAME = 'Chromagrid';
