// Visible account bar for the LB Games landing page.
//
// Shows the signed-in account (project-wide — one login works across every
// game) or, for guests, a name field that syncs across all games via the
// shared guest-name key. Signing in here signs you in everywhere, because the
// Supabase session lives in this origin's localStorage, shared by every page
// under /lb-games/.

import {
  cachedUser, onAuthChange, displayName,
  signUp, signInWithPassword, signInWithMagicLink, signOut,
} from './auth.js';
import { configReady } from './supabase-config.js';
import { getGuestName, setGuestName } from './guest-name.js';

const $ = id => document.getElementById(id);

let user = null;
let authMode = 'signin';

function render() {
  const signedIn = !!user;
  $('lb-acct-guest')?.classList.toggle('hidden', signedIn);
  $('lb-acct-user')?.classList.toggle('hidden', !signedIn);
  $('lb-acct-hint')?.classList.toggle('hidden', signedIn);
  if (signedIn) {
    $('lb-acct-name').textContent = displayName(user);
  } else {
    const nameInput = $('lb-name');
    // Don't clobber what the player is mid-typing.
    if (nameInput && document.activeElement !== nameInput) nameInput.value = getGuestName();
  }
}

// ---- auth modal ----------------------------------------------------------

function openAuth(mode = 'signin') {
  setAuthMode(mode);
  authStatus('');
  $('auth-modal').classList.remove('hidden');
  $('auth-email').focus();
}
function closeAuth() { $('auth-modal').classList.add('hidden'); }

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('auth-title').textContent       = signup ? 'CREATE ACCOUNT' : 'LOG IN';
  $('btn-auth-primary').textContent = signup ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('auth-name').classList.toggle('hidden', !signup);
  $('auth-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('auth-tab-signin').classList.toggle('active', !signup);
  $('auth-tab-signup').classList.toggle('active',  signup);
}

function authStatus(msg) { $('auth-status').textContent = msg || ''; }

async function doAuthPrimary() {
  const email    = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const name     = $('auth-name').value.trim() || getGuestName();
  if (!email || !password) return authStatus('Enter your email and password.');
  if (authMode === 'signup' && !name) return authStatus('Choose a display name.');
  $('btn-auth-primary').disabled = true;
  authStatus('Working…');
  try {
    if (authMode === 'signup') {
      const { needsConfirmation } = await signUp(email, password, name);
      if (needsConfirmation) {
        authStatus('Account created — check your email to confirm, then sign in.');
        setAuthMode('signin');
        return;
      }
    } else {
      await signInWithPassword(email, password);
    }
    closeAuth(); // onAuthChange updates the bar
  } catch (e) {
    authStatus(e.message || 'Something went wrong.');
  } finally {
    $('btn-auth-primary').disabled = false;
  }
}

async function doAuthMagic() {
  const email = $('auth-email').value.trim();
  const name  = $('auth-name').value.trim() || getGuestName();
  if (!email) return authStatus('Enter your email first.');
  $('btn-auth-magic').disabled = true;
  authStatus('Sending…');
  try {
    await signInWithMagicLink(email, name);
    authStatus('Check your email for a sign-in link.');
  } catch (e) {
    authStatus(e.message || 'Could not send the link.');
  } finally {
    $('btn-auth-magic').disabled = false;
  }
}

function wire() {
  $('lb-login')?.addEventListener('click', () => openAuth('signin'));
  $('lb-logout')?.addEventListener('click', async () => { try { await signOut(); } catch {} });
  const nameInput = $('lb-name');
  if (nameInput) {
    nameInput.value = getGuestName();
    nameInput.addEventListener('input', () => setGuestName(nameInput.value));
  }

  $('auth-close')?.addEventListener('click', closeAuth);
  $('auth-tab-signin')?.addEventListener('click', () => setAuthMode('signin'));
  $('auth-tab-signup')?.addEventListener('click', () => setAuthMode('signup'));
  $('btn-auth-primary')?.addEventListener('click', doAuthPrimary);
  $('btn-auth-magic')?.addEventListener('click', doAuthMagic);
  $('auth-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doAuthPrimary(); });
  $('auth-modal')?.addEventListener('click', e => { if (e.target.id === 'auth-modal') closeAuth(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAuth(); });
}

async function init() {
  // Markup is already in the page, and an inline script has already swapped
  // the bar to the right variant pre-paint (via boot.js's data-auth stamp).
  // Seed from the same cached session so our first render agrees with it;
  // the authoritative session arrives via onAuthChange (INITIAL_SESSION).
  user = cachedUser();
  wire();
  render();
  if (!configReady()) return;
  onAuthChange(u => { user = u; render(); });
}

init();
