// Accounts: game-independent wrapper over Supabase Auth.
//
// Login is optional. Anonymous players never touch this module. When a
// player signs in their account lives at the Supabase project level, so
// the same login works across every LB Games title — no separate sign-up.
//
// Two sign-in methods:
//   • email + password  (self-contained, works immediately)
//   • magic link        (passwordless; needs email sending configured)

import { supabase } from './supabaseClient.js';

export async function currentUser() {
  const { data } = await supabase().auth.getUser();
  return data?.user ?? null;
}

// Synchronous read of the locally cached session's user — no client init, no
// network — so pages can paint the right signed-in/out layout immediately
// instead of flashing the guest UI and reconfiguring. Optimistic: if the
// cached token turns out to be unrefreshable, onAuthChange fires with null
// and the UI corrects itself. (shared/boot.js does this same read in
// classic-script form for pre-paint work; keep the two in sync.)
export function cachedUser() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^sb-.+-auth-token$/.test(k)) {
        const s = JSON.parse(localStorage.getItem(k));
        return s?.user ?? s?.currentSession?.user ?? null;
      }
    }
  } catch {}
  return null;
}

export async function currentSession() {
  const { data } = await supabase().auth.getSession();
  return data?.session ?? null;
}

// Fires whenever the user signs in or out (magic-link return, token refresh).
// Returns an unsubscribe function.
export function onAuthChange(cb) {
  const { data } = supabase().auth.onAuthStateChange((_event, session) => {
    cb(session?.user ?? null);
  });
  return () => data?.subscription?.unsubscribe();
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
  const { data, error } = await supabase().auth.signUp({
    email,
    password,
    options: {
      data: { display_name: name?.trim() || '' },
      emailRedirectTo: redirectUrl(),
    },
  });
  if (error) throw error;
  return { user: data.user, needsConfirmation: !data.session };
}

export async function signInWithPassword(email, password) {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signInWithMagicLink(email, name) {
  const { error } = await supabase().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectUrl(),
      data: name?.trim() ? { display_name: name.trim() } : undefined,
    },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase().auth.signOut();
  if (error) throw error;
}

export async function setDisplayName(name) {
  const { error } = await supabase().auth.updateUser({ data: { display_name: name.trim() } });
  if (error) throw error;
}

export async function resetPasswordForEmail(email) {
  const { error } = await supabase().auth.resetPasswordForEmail(email, {
    redirectTo: redirectUrl(),
  });
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase().auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// Fires when the user arrives via a password-reset email link.
export function onPasswordRecovery(cb) {
  const { data } = supabase().auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') cb(session);
  });
  return () => data?.subscription?.unsubscribe();
}

function redirectUrl() {
  return location.origin + location.pathname;
}
