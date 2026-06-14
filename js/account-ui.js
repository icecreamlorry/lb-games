// Wires the game-agnostic account layer + leaderboard into Chromagrid's UI.
//
// Runs as a module alongside the game's classic inline script. The two talk
// through one event: the game dispatches `chromagrid:gameover` with the final
// score, and this module records it and shows the leaderboard. Everything
// else here is self-contained DOM wiring, so the game logic stays untouched.

import { GAME_NAME, configReady } from './config.js';
import {
  currentUser, onAuthChange, displayName,
  signUp, signInWithPassword, signInWithMagicLink, signOut, setDisplayName,
} from './auth.js';
import { submitScore, topScores, playerKey } from './leaderboard.js';

const $ = id => document.getElementById(id);
const NAME_KEY = 'chromagrid.name';

const app = {
  user: null,
  name: (localStorage.getItem(NAME_KEY) || '').trim(),
};
let lastGameoverScore = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function currentName() {
  return app.user ? displayName(app.user) : app.name;
}

function gameoverVisible() {
  const go = $('gameover-overlay');
  return go && !go.classList.contains('hidden');
}

// ---- account bar (start screen) -----------------------------------------

function renderAccount() {
  const name = currentName();
  const signedIn = !!app.user;
  const line = $('account-line');
  if (signedIn) line.innerHTML = 'Signed in as <strong>' + esc(name) + '</strong>';
  else if (name) line.innerHTML = 'Playing as <strong>' + esc(name) + '</strong>';
  else line.textContent = 'Playing as a guest';

  $('btn-set-name').textContent = (name && !signedIn) ? 'CHANGE NAME' : 'SET NAME';
  $('btn-set-name').classList.toggle('hidden', signedIn);
  $('btn-login').classList.toggle('hidden', signedIn);
  $('btn-logout').classList.toggle('hidden', !signedIn);
}

// ---- login / sign-up modal ----------------------------------------------

let authMode = 'signin';

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
  $('auth-title').textContent = signup ? 'CREATE ACCOUNT' : 'LOG IN';
  $('btn-auth-primary').textContent = signup ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('auth-name').classList.toggle('hidden', !signup);
  $('auth-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('auth-tab-signin').classList.toggle('active', !signup);
  $('auth-tab-signup').classList.toggle('active', signup);
}

function authStatus(msg) { $('auth-status').textContent = msg || ''; }

async function doAuthPrimary() {
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const name = $('auth-name').value.trim() || app.name;
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
    closeAuth(); // onAuthChange routes the rest
  } catch (e) {
    authStatus(e.message || 'Something went wrong.');
  } finally {
    $('btn-auth-primary').disabled = false;
  }
}

async function doAuthMagic() {
  const email = $('auth-email').value.trim();
  const name = $('auth-name').value.trim() || app.name;
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

// ---- guest name modal ---------------------------------------------------

function openName() {
  $('name-input').value = app.name || '';
  $('name-status').textContent = '';
  $('name-modal').classList.remove('hidden');
  $('name-input').focus();
}
function closeName() { $('name-modal').classList.add('hidden'); }

async function saveName() {
  const v = $('name-input').value.trim().slice(0, 20);
  if (!v) { $('name-status').textContent = 'Enter a name.'; return; }
  app.name = v;
  localStorage.setItem(NAME_KEY, v);
  if (app.user) { try { await setDisplayName(v); } catch { /* keep local */ } }
  renderAccount();
  closeName();
  if (gameoverVisible() && lastGameoverScore != null) showLeaderboard(lastGameoverScore);
}

// ---- leaderboard --------------------------------------------------------

function renderList(el, rows) {
  el.innerHTML = '';
  if (!rows.length) {
    el.innerHTML = '<li class="lb-empty">No scores yet — be the first.</li>';
    return;
  }
  const myKey = playerKey(app.user);
  rows.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'lb-item' + (r.player_key === myKey ? ' lb-me' : '');
    li.innerHTML =
      '<span class="lb-rank">' + (i + 1) + '</span>' +
      '<span class="lb-name">' + esc(r.name) + '</span>' +
      '<span class="lb-score">' + Number(r.score).toLocaleString() + '</span>';
    el.appendChild(li);
  });
}

// Game-over panel: record the run, then show the table with the player's row.
async function showLeaderboard(score) {
  lastGameoverScore = score;
  const panel = $('lb-panel');
  panel.classList.remove('hidden');
  const statusEl = $('lb-status');
  const listEl = $('lb-list');
  $('lb-actions').classList.toggle('hidden', !!app.user);

  if (!configReady()) { statusEl.textContent = 'Leaderboard offline.'; listEl.innerHTML = ''; return; }

  const name = currentName();
  listEl.innerHTML = '';
  statusEl.textContent = 'Saving…';
  try {
    let best = score;
    if (score > 0) best = await submitScore({ score, name, user: app.user });
    const rows = await topScores(10);
    renderList(listEl, rows);
    const rank = rows.findIndex(r => r.player_key === playerKey(app.user));
    if (!name) {
      statusEl.innerHTML = 'Saved as <strong>Player</strong> — set a name to claim it.';
    } else if (rank >= 0) {
      statusEl.innerHTML = 'Your best <strong>' + Number(best).toLocaleString() + '</strong> · rank #' + (rank + 1);
    } else {
      statusEl.innerHTML = 'Your best <strong>' + Number(best).toLocaleString() + '</strong>';
    }
  } catch {
    statusEl.textContent = 'Could not reach the leaderboard.';
  }
}

// Standalone view, openable any time from the trophy button.
async function openLeaderboardModal() {
  $('lb-modal').classList.remove('hidden');
  const listEl = $('lb-modal-list');
  listEl.innerHTML = '<li class="lb-empty">Loading…</li>';
  try {
    renderList(listEl, await topScores(20));
  } catch {
    listEl.innerHTML = '<li class="lb-empty">Leaderboard unavailable.</li>';
  }
}

// ---- auth state ---------------------------------------------------------

function onUser(user) {
  app.user = user;
  if (user) app.name = displayName(user);
  renderAccount();
  if (gameoverVisible() && lastGameoverScore != null) showLeaderboard(lastGameoverScore);
}

// ---- wiring -------------------------------------------------------------

function closeAllModals() {
  ['auth-modal', 'name-modal', 'lb-modal'].forEach(id => $(id).classList.add('hidden'));
}

function wire() {
  $('btn-login').addEventListener('click', () => openAuth('signin'));
  $('btn-logout').addEventListener('click', async () => { try { await signOut(); } catch {} });
  $('btn-set-name').addEventListener('click', openName);

  $('auth-close').addEventListener('click', closeAuth);
  $('auth-tab-signin').addEventListener('click', () => setAuthMode('signin'));
  $('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));
  $('btn-auth-primary').addEventListener('click', doAuthPrimary);
  $('btn-auth-magic').addEventListener('click', doAuthMagic);
  $('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') doAuthPrimary(); });

  $('name-close').addEventListener('click', closeName);
  $('btn-name-save').addEventListener('click', saveName);
  $('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveName(); });

  $('btn-leaderboard').addEventListener('click', openLeaderboardModal);
  $('lb-modal-close').addEventListener('click', () => $('lb-modal').classList.add('hidden'));
  $('lb-set-name').addEventListener('click', openName);
  $('lb-login').addEventListener('click', () => openAuth('signin'));

  for (const id of ['auth-modal', 'name-modal', 'lb-modal']) {
    const m = $(id);
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllModals(); });

  window.addEventListener('chromagrid:gameover', e => showLeaderboard(e.detail?.score ?? 0));
}

async function init() {
  // Stamp the shared-login intro line with this game's name.
  const intro = $('auth-intro');
  if (intro) intro.textContent = 'One account works across ' + GAME_NAME + ' and the other games on this project — no separate sign-up.';
  wire();
  renderAccount();
  try { app.user = await currentUser(); } catch {}
  onAuthChange(onUser);
  renderAccount();
}

init();
