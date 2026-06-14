// Accounts: a thin, game-independent wrapper over Supabase Auth.
//
// Login is optional. Anonymous players never touch this module. When a
// player does sign in, their account lives at the Supabase *project* level,
// so the same login works across every game that shares the project — no
// separate account per game. Copy this file as-is into other projects.
//
// Two sign-in methods are supported:
//   • email + password (self-contained, works immediately)
//   • magic link       (passwordless; needs email sending configured)
//
// A user's chosen display name is kept in user_metadata.display_name so it
// is available everywhere without a separate profiles table.

import { supabase } from './supabaseClient.js';

// ---- Session ------------------------------------------------------------

export async function currentUser() {
  const { data } = await supabase().auth.getUser();
  return data?.user ?? null;
}

export async function currentSession() {
  const { data } = await supabase().auth.getSession();
  return data?.session ?? null;
}

// Fires whenever the user signs in or out (including magic-link return and
// token refreshes). Returns an unsubscribe function.
export function onAuthChange(cb) {
  const { data } = supabase().auth.onAuthStateChange((_event, session) => {
    cb(session?.user ?? null);
  });
  return () => data?.subscription?.unsubscribe();
}

// The friendly name to show / seat the player under. Falls back to the part
// of the email before the @ if no display name was set.
export function displayName(user) {
  if (!user) return null;
  return (
    user.user_metadata?.display_name?.trim() ||
    user.email?.split('@')[0] ||
    'Player'
  );
}

// ---- Sign up / in / out -------------------------------------------------

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
  // If email confirmation is required, session is null until they confirm.
  return { user: data.user, needsConfirmation: !data.session };
}

export async function signInWithPassword(email, password) {
  const { data, error } = await supabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

// Passwordless: emails a magic link (and/or code) that returns to this page.
export async function signInWithMagicLink(email, name) {
  const { error } = await supabase().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectUrl(),
      // Create the account on first magic-link sign-in, seeding the name.
      data: name?.trim() ? { display_name: name.trim() } : undefined,
    },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase().auth.signOut();
  if (error) throw error;
}

// Update the display name on the current account.
export async function setDisplayName(name) {
  const { error } = await supabase().auth.updateUser({ data: { display_name: name.trim() } });
  if (error) throw error;
}

// Where Supabase should send the user back to after a magic-link click.
// Must be added to the project's Auth → URL Configuration → Redirect URLs.
function redirectUrl() {
  return location.origin + location.pathname;
}
