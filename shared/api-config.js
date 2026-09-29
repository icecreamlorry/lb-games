// LB Games backend endpoint — shared across every title.
//
// The backend is one Cloudflare Worker (worker/ in this repo): accounts, rooms,
// live room channels, leaderboards, friends and Web Push. Nothing here is
// secret; access rules are enforced by the Worker.
//
// Per-game identity (slug / name) lives in each game's window.LB_CONFIG and
// js/config.js, NOT here.

export const API_BASE = 'https://lb-games-api.__SUBDOMAIN__.workers.dev';

// Web Push application-server key (public half; the private half is the
// Worker's VAPID_PRIVATE_JWK secret). Shared across LB Games titles.
export const VAPID_PUBLIC_KEY = '__VAPID_PUBLIC_KEY__';

export function configReady() {
  return !!API_BASE && !API_BASE.includes('__');
}
