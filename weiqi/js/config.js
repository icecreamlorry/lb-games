// Weiqi per-game configuration.
//
// Project-level Supabase credentials are shared by every LB Games title and
// live in shared/supabase-config.js — we re-export them so this game's modules
// keep importing them from one place. Only this game's identity (slug, name,
// push key) is defined here.

export { SUPABASE_URL, SUPABASE_ANON_KEY, configReady } from '../../shared/supabase-config.js';

// GAME_SLUG keeps this game's rooms separate in the shared "My Games" tables;
// GAME_NAME is the display name. These two are all that change per game.
export const GAME_SLUG = 'weiqi';
export const GAME_NAME = 'Weiqi';

// VAPID public key for Web Push. Project-wide (the private half is a single
// Supabase Edge Function secret), so every LB Games title shares this key.
export const VAPID_PUBLIC_KEY = 'BDw2f2Kt2pCDGw9GpQEZh3G9olKazyL8hQLnRHEmd1-8cogNxMIgZy5G4AZp_9M7QInjdzm2RCJm1N_wbLUUneM';
