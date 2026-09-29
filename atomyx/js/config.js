// Atomyx per-game configuration.
//
// The backend endpoint is shared by every LB Games title and lives in
// shared/api-config.js — re-exported so this game's modules keep importing
// it from one place. Only this game's identity lives here.

export { API_BASE, configReady } from '../../shared/api-config.js';

// GAME_SLUG keeps this game's rooms separate in the shared "My Games" tables.
export const GAME_SLUG = 'atomyx';
export const GAME_NAME = 'Atomyx';

// VAPID public key for Web Push — project-wide (the private half is a
// secret on the API Worker), so every LB Games title shares it.
export { VAPID_PUBLIC_KEY } from '../../shared/api-config.js';
