// Shared Supabase client — one instance for the whole app.
//
// This module is intentionally game-independent: it knows nothing about
// Chromagrid. Copy it (together with auth.js and config.js) into any other
// small game that points at the same Supabase project and the login/account
// layer works unchanged. The only per-project values live in config.js.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let client = null;

export function supabase() {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,      // keep the login across reloads
        autoRefreshToken: true,
        detectSessionInUrl: true,  // complete magic-link sign-in on return
      },
    });
  }
  return client;
}
