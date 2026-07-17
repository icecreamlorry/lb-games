// Atomyx per-game configuration.
//
// Project-level Supabase credentials are shared by every LB Games title and
// live in shared/supabase-config.js — re-exported so this game's modules keep
// importing them from one place. Only this game's identity lives here.

export { SUPABASE_URL, SUPABASE_ANON_KEY, configReady } from '../../shared/supabase-config.js';

// GAME_SLUG keeps this game's rooms separate in the shared "My Games" tables.
export const GAME_SLUG = 'atomyx';
export const GAME_NAME = 'Atomyx';

// VAPID public key for Web Push (the private half is a Supabase Edge Function
// secret). Shared across LB Games titles.
export const VAPID_PUBLIC_KEY = 'BDw2f2Kt2pCDGw9GpQEZh3G9olKazyL8hQLnRHEmd1-8cogNxMIgZy5G4AZp_9M7QInjdzm2RCJm1N_wbLUUneM';
