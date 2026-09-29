// Chromagrid per-game configuration.
//
// The backend endpoint is shared by every LB Games title and lives in
// shared/api-config.js — re-exported so this game's modules keep importing
// it from one place. Only this game's identity lives here.

export { API_BASE, configReady } from '../../shared/api-config.js';

// GAME_SLUG keeps this game's rooms separate in the shared "My Games" tables.
export const GAME_SLUG = 'chromagrid';
export const GAME_NAME = 'Chromagrid';
