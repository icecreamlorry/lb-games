// Visible account bar for the LB Games landing page.
//
// Shows the signed-in account (project-wide — one login works across every
// game) or, for guests, a name field that syncs across all games via the
// shared guest-name key. Signing in here signs you in everywhere, because the
// Supabase session lives in this origin's localStorage, shared by every page
// under /lb-games/.

import {
  currentUser, onAuthChange, displayName,
  signUp, signInWithPassword, signInWithMagicLink, signOut,
} from './auth.js';
import { configReady } from './supabase-config.js';
import { getGuestName, setGuestName } from './guest-name.js';

const $ = id => document.getElementById(id);

let user = null;
let authMode = 'signin';

function injectHTML() {
  const bar = $('lb-account');
  if (bar) {
    bar.innerHTML = `
      <div id="lb-acct-guest" class="lb-acct-guest">
        <input id="lb-name" class="field" type="text" maxlength="20"
               placeholder="Your name" autocomplete="name">
        <button id="lb-login" class="btn-primary">LOG IN / SIGN UP</button>
      </div>
      <div id="lb-acct-user" class="lb-acct-user hidden">
        <span class="lb-acct-line">Signed in as <strong id="lb-acct-name"></strong></span>
        <button id="lb-logout" class="link-btn">LOG OUT</button>
      </div>
      <p id="lb-acct-hint" class="lb-acct-hint">
        Log in to play across devices, add friends and keep your scores — or just pick a guest name to get going.
      </p>
    `;
  }
  // Auth modal — same classes as the in-game modals (styled by shared.css).
  document.body.insertAdjacentHTML('beforeend', `
    <div id="auth-modal" class="modal hidden">
      <div class="modal-panel">
        <button id="auth-close" class="modal-close">✕</button>
        <div id="auth-title" class="modal-title">LOG IN</div>
        <p class="modal-intro">One account works across every LB Games title — no separate sign-up per game.</p>
        <div class="auth-tabs">
          <button id="auth-tab-signin" class="tab active">SIGN IN</button>
          <button id="auth-tab-signup" class="tab">CREATE</button>
        </div>
        <input id="auth-name"     class="field hidden" type="text"     maxlength="20" placeholder="Display name" autocomplete="name">
        <input id="auth-email"    class="field"        type="email"    placeholder="Email"    autocomplete="email">
        <input id="auth-password" class="field"        type="password" placeholder="Password" autocomplete="current-password">
        <button id="btn-auth-primary" class="btn-primary">SIGN IN</button>
        <div class="auth-or">OR</div>
        <button id="btn-auth-magic">EMAIL ME A SIGN-IN LINK</button>
        <p id="auth-status" class="status-line"></p>
      </div>
    </div>
  `);
}

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
  injectHTML();
  wire();
  render();
  if (!configReady()) return;
  try { user = await currentUser(); } catch {}
  render();
  onAuthChange(u => { user = u; render(); });
}

init();
