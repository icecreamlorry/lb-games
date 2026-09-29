// Accounts: game-independent wrapper over the LB Games API's auth endpoints.
//
// Login is optional. Anonymous players never touch this module. An account
// lives at the project level, so the same login works across every LB Games
// title — no separate sign-up.
//
// Sign-in methods:
//   • email + password  (always available)
//   • magic link / password-reset email  (only once the Worker has email
//     sending configured — emailLinksAvailable() says whether it has)

import { api, getSession, setSession, onSessionChange, sessionReady, SESSION_KEY } from './api.js';

export async function currentUser() {
  await sessionReady();
  return getSession()?.user ?? null;
}

// Synchronous read of the locally cached session's user — no network — so
// pages can paint the right signed-in/out layout immediately instead of
// flashing the guest UI and reconfiguring. Optimistic: if the server rejects
// the token, onAuthChange fires with null and the UI corrects itself.
// (shared/boot.js does this same read in classic-script form for pre-paint
// work; keep the two in sync.)
export function cachedUser() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s?.user ?? null;
  } catch {}
  return null;
}

export async function currentSession() {
  await sessionReady();
  const s = getSession();
  return s ? { access_token: s.token, user: s.user } : null;
}

// Fires whenever the user signs in or out (also once, right after subscribing,
// with the current user — like supabase-js's INITIAL_SESSION). Returns an
// unsubscribe function.
export function onAuthChange(cb) {
  let live = true;
  const off = onSessionChange((event, session) => {
    if (event !== 'PASSWORD_RECOVERY') cb(session?.user ?? null);
  });
  sessionReady().then(() => { if (live) cb(getSession()?.user ?? null); });
  return () => { live = false; off(); };
}

// Friendly name to show. Falls back to email prefix if no display name set.
export function displayName(user) {
  if (!user) return null;
  return (
    user.user_metadata?.display_name?.trim() ||
    user.email?.split('@')[0] ||
    'Player'
  );
}

export async function signUp(email, password, name) {
  const r = await api('/auth/signup', { method: 'POST', body: { email, password, name: name?.trim() || '' } });
  setSession(r);
  return { user: r.user, needsConfirmation: false };
}

export async function signInWithPassword(email, password) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password } });
  setSession(r);
  return r.user;
}

let emailCfg = null;
// Whether the backend can send sign-in / reset emails right now.
export async function emailLinksAvailable() {
  emailCfg ??= api('/auth/config').then((c) => !!c?.email, () => false);
  return emailCfg;
}

export async function signInWithMagicLink(email, name) {
  await api('/auth/magic', { method: 'POST', body: { email, name: name?.trim() || '', redirect: redirectUrl() } });
}

export async function signOut() {
  setSession(null);
}

export async function setDisplayName(name) {
  const r = await api('/auth/update', { method: 'POST', body: { name: name.trim() } });
  setSession(r, 'USER_UPDATED');
}

export async function resetPasswordForEmail(email) {
  await api('/auth/reset', { method: 'POST', body: { email, redirect: redirectUrl() } });
}

export async function updatePassword(newPassword) {
  const r = await api('/auth/update', { method: 'POST', body: { password: newPassword } });
  setSession(r, 'USER_UPDATED');
}

// Fires when the user arrives via a password-reset email link.
export function onPasswordRecovery(cb) {
  sessionReady();
  return onSessionChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') cb(session);
  });
}

function redirectUrl() {
  return location.origin + location.pathname;
}
