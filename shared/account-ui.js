// Shared account UI for LB Games.
//
// Injects the hamburger menu, all auth/name/leaderboard/profile modals into
// the document, then wires up all the event handlers. Each game configures
// this via window.LB_CONFIG before loading this module:
//
//   window.LB_CONFIG = {
//     gameSlug:      'mygame',
//     gameName:      'My Game',
//     gameoverEvent: 'mygame:gameover',   // detail.score expected
//     guestIdKey:    'mygame.guestId',    // localStorage key for guest id
//   };
//
// The guest display name is NOT per-game — it lives in one shared key
// (see guest-name.js) so it syncs across every title and the landing page.
//
// The game's HTML must include the elements account-ui writes into:
//   #gameover-overlay, #lb-panel, #lb-status, #lb-list, #lb-actions,
//   #lb-set-name, #lb-login, #go-score  (for in-game leaderboard panel)
//   #account-bar > #account-line, #btn-set-name, #btn-login, #btn-logout
//   (for the start-screen account bar)
// All of those are accessed with null-guards so future games can omit them.

import {
  currentUser, onAuthChange, displayName,
  signUp, signInWithPassword, signInWithMagicLink, signOut, setDisplayName,
  resetPasswordForEmail, updatePassword, onPasswordRecovery,
} from './auth.js';
import { submitScore, topScores, friendScores, playerKey } from './leaderboard.js';
import {
  ensureProfile, addFriendByCode, addFriendMessage,
  listFriends, listFriendRequests, respondToRequest, removeFriend,
} from './friends.js';
import { configReady } from './supabase-config.js';
import { getGuestName, setGuestName } from './guest-name.js';
import { openHistory } from './history.js';

// ---- config helpers -------------------------------------------------------

function cfg() { return window.LB_CONFIG || {}; }

// ---- inject shared HTML ---------------------------------------------------

function injectHTML() {
  document.body.insertAdjacentHTML('beforeend', `
    <button id="btn-menu" title="Menu" aria-haspopup="true" aria-expanded="false">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <line x1="2.5" y1="4"  x2="13.5" y2="4"/>
        <line x1="2.5" y1="8"  x2="13.5" y2="8"/>
        <line x1="2.5" y1="12" x2="13.5" y2="12"/>
      </svg>
      <span id="profile-badge" class="hidden"></span>
    </button>

    <div id="app-menu" class="hidden">
      <button class="menu-item" id="help-btn" title="How to play">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="8" r="6.5"/>
          <path d="M6.1 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3"/>
          <line x1="8" y1="11.4" x2="8" y2="11.5"/>
        </svg>
        <span>How to play</span>
      </button>
      <button class="menu-item" id="btn-profile" title="Profile">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8" cy="5" r="3"/>
          <path d="M2.5 14a5.5 5.5 0 0 1 11 0"/>
        </svg>
        <span>Profile</span>
      </button>
      <a class="menu-item menu-sep" href="../" title="Back to all games">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2" width="5" height="5" rx="1"/>
          <rect x="9" y="2" width="5" height="5" rx="1"/>
          <rect x="2" y="9" width="5" height="5" rx="1"/>
          <rect x="9" y="9" width="5" height="5" rx="1"/>
        </svg>
        <span>More Games</span>
      </a>
    </div>

    <div id="auth-modal" class="modal hidden">
      <div class="modal-panel">
        <button id="auth-close" class="modal-close">✕</button>
        <div id="auth-title" class="modal-title">LOG IN</div>
        <p id="auth-intro" class="modal-intro">One account works across every LB Games title — no separate sign-up per game.</p>
        <div id="auth-tabs" class="auth-tabs">
          <button id="auth-tab-signin" class="tab active">SIGN IN</button>
          <button id="auth-tab-signup" class="tab">CREATE</button>
        </div>
        <input id="auth-name"     class="field hidden" type="text"     maxlength="20" placeholder="Display name" autocomplete="name">
        <input id="auth-email"    class="field"        type="email"    placeholder="Email"    autocomplete="email">
        <input id="auth-password" class="field"        type="password" placeholder="Password" autocomplete="current-password">
        <button id="btn-auth-forgot" class="link-btn">Forgot password?</button>
        <button id="btn-auth-back"   class="link-btn hidden">← Back to sign in</button>
        <button id="btn-auth-primary" class="btn-primary">SIGN IN</button>
        <div id="auth-or" class="auth-or">OR</div>
        <button id="btn-auth-magic">EMAIL ME A SIGN-IN LINK</button>
        <p id="auth-status" class="status-line"></p>
      </div>
    </div>

    <div id="name-modal" class="modal hidden">
      <div class="modal-panel">
        <button id="name-close" class="modal-close">✕</button>
        <div class="modal-title">YOUR NAME</div>
        <p class="modal-intro">Pick a name to appear on the leaderboard. No account needed.</p>
        <input id="name-input" class="field" type="text" maxlength="20" placeholder="Display name" autocomplete="name">
        <button id="btn-name-save" class="btn-primary">SAVE</button>
        <p id="name-status" class="status-line"></p>
      </div>
    </div>

    <div id="lb-modal" class="modal hidden">
      <div class="modal-panel">
        <button id="lb-modal-close" class="modal-close">✕</button>
        <div class="modal-title">LEADERBOARD</div>
        <div class="auth-tabs lb-tabs">
          <button id="lb-tab-global"  class="tab active">GLOBAL</button>
          <button id="lb-tab-friends" class="tab">FRIENDS</button>
        </div>
        <ul id="lb-modal-list" class="lb-list"></ul>
      </div>
    </div>

    <div id="confirm-modal" class="modal hidden" style="z-index:960">
      <div class="modal-panel">
        <div id="confirm-title" class="modal-title">ARE YOU SURE?</div>
        <p id="confirm-message" class="modal-intro"></p>
        <div class="confirm-actions">
          <button id="confirm-cancel" class="link-btn">CANCEL</button>
          <button id="confirm-ok" class="btn-primary">CONFIRM</button>
        </div>
      </div>
    </div>

    <div id="profile-modal" class="modal hidden">
      <div class="modal-panel">
        <button id="profile-close" class="modal-close">✕</button>
        <div class="modal-title">PROFILE</div>

        <div id="profile-signedout">
          <p class="modal-intro">Log in to set a display name and add friends across every LB Games title.</p>
          <button id="profile-login" class="btn-primary">LOG IN</button>
        </div>

        <div id="profile-signedin" class="hidden">
          <div id="profile-line">Signed in as <strong id="profile-name"></strong></div>
          <div class="account-actions">
            <button id="profile-change-name" class="link-btn">CHANGE NAME</button>
            <button id="profile-signout"     class="link-btn">SIGN OUT</button>
          </div>

          <div class="profile-block">
            <div class="profile-label">YOUR FRIEND CODE</div>
            <div class="profile-code-row">
              <code id="profile-code">––––––––</code>
              <button id="profile-copy-code" class="link-btn">COPY</button>
            </div>
            <p class="modal-intro" style="text-align:left">Share this so friends can add you.</p>
          </div>

          <div class="profile-block">
            <div class="profile-label">ADD A FRIEND</div>
            <div class="profile-add-row">
              <input id="friend-code-input" class="field" type="text" maxlength="8"
                     placeholder="Friend code" autocomplete="off" autocapitalize="characters">
              <button id="btn-add-friend" class="btn-primary">ADD</button>
            </div>
            <p id="friend-add-status" class="status-line"></p>
          </div>

          <div id="friend-requests-block" class="profile-block hidden">
            <div class="profile-label">REQUESTS</div>
            <ul id="friend-requests" class="friend-list"></ul>
          </div>

          <div class="profile-block">
            <div class="profile-label">FRIENDS</div>
            <ul id="friend-list" class="friend-list"></ul>
          </div>
        </div>
      </div>
    </div>
  `);
}

// ---- state ----------------------------------------------------------------

const $ = id => document.getElementById(id);

const app = {
  user: null,
  name: '',
  profile: null,
  requestCount: 0,
};
let lastGameoverScore = null;
let lbTab = 'global';

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

// ---- confirm dialog -------------------------------------------------------
// Themed replacement for window.confirm. Layers above all other modals.

let confirmResolver = null;

function confirmDialog({ title, message, confirmText = 'CONFIRM', danger = false }) {
  $('confirm-title').textContent   = title;
  $('confirm-message').textContent = message;
  const okBtn = $('confirm-ok');
  okBtn.textContent = confirmText;
  okBtn.classList.toggle('btn-danger',   danger);
  okBtn.classList.toggle('btn-primary', !danger);
  $('confirm-modal').classList.remove('hidden');
  return new Promise(resolve => { confirmResolver = resolve; });
}

function settleConfirm(value) {
  if (!confirmResolver) return;
  $('confirm-modal').classList.add('hidden');
  const resolve = confirmResolver;
  confirmResolver = null;
  resolve(value);
}

function confirmOpen() { return !$('confirm-modal').classList.contains('hidden'); }

// ---- account bar (start screen) ------------------------------------------

function renderAccount() {
  const name    = currentName();
  const signedIn = !!app.user;
  const line    = $('account-line');
  if (line) {
    if (signedIn)    line.innerHTML = 'Signed in as <strong>' + esc(name) + '</strong>';
    else if (name)   line.innerHTML = 'Playing as <strong>' + esc(name) + '</strong>';
    else             line.textContent = 'Playing as a guest';
  }
  const btnName = $('btn-set-name');
  if (btnName) {
    btnName.textContent = (name && !signedIn) ? 'CHANGE NAME' : 'SET NAME';
    btnName.classList.toggle('hidden', signedIn);
  }
  $('btn-login')?.classList.toggle('hidden', signedIn);
  $('btn-logout')?.classList.toggle('hidden', !signedIn);
}

// ---- auth modal -----------------------------------------------------------

let authMode = 'signin';

function openAuth(mode = 'signin') {
  setAuthMode(mode);
  authStatus('');
  $('auth-modal').classList.remove('hidden');
  (mode === 'newpassword' ? $('auth-password') : $('auth-email')).focus();
}
function closeAuth() { $('auth-modal').classList.add('hidden'); }

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  const signin = mode === 'signin';
  const reset  = mode === 'reset';
  const newpw  = mode === 'newpassword';
  $('auth-title').textContent = reset ? 'RESET PASSWORD' : newpw ? 'SET NEW PASSWORD' : signup ? 'CREATE ACCOUNT' : 'LOG IN';
  $('btn-auth-primary').textContent = reset ? 'SEND RESET EMAIL' : newpw ? 'SET PASSWORD' : signup ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('auth-name').classList.toggle('hidden', !signup);
  $('auth-email').classList.toggle('hidden', newpw);
  $('auth-password').classList.toggle('hidden', reset);
  $('auth-password').setAttribute('autocomplete', signup || newpw ? 'new-password' : 'current-password');
  $('auth-tabs').classList.toggle('hidden', reset || newpw);
  $('auth-tab-signin').classList.toggle('active', signin);
  $('auth-tab-signup').classList.toggle('active', signup);
  $('auth-intro').classList.toggle('hidden', reset || newpw);
  $('btn-auth-forgot').classList.toggle('hidden', !signin);
  $('btn-auth-back').classList.toggle('hidden', !reset);
  $('auth-or').classList.toggle('hidden', reset || newpw);
  $('btn-auth-magic').classList.toggle('hidden', reset || newpw);
}

function authStatus(msg) { $('auth-status').textContent = msg || ''; }

async function doAuthPrimary() {
  if (authMode === 'reset')       { await doAuthForgot();      return; }
  if (authMode === 'newpassword') { await doAuthSetPassword(); return; }
  const email    = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const name     = $('auth-name').value.trim() || app.name;
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
    closeAuth();
  } catch (e) {
    authStatus(e.message || 'Something went wrong.');
  } finally {
    $('btn-auth-primary').disabled = false;
  }
}

async function doAuthMagic() {
  const email = $('auth-email').value.trim();
  const name  = $('auth-name').value.trim() || app.name;
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

async function doAuthForgot() {
  const email = $('auth-email').value.trim();
  if (!email) return authStatus('Enter your email address.');
  $('btn-auth-primary').disabled = true;
  authStatus('Sending…');
  try {
    await resetPasswordForEmail(email);
    authStatus('Check your email for a password reset link.');
  } catch (e) {
    authStatus(e.message || 'Could not send reset email.');
  } finally {
    $('btn-auth-primary').disabled = false;
  }
}

async function doAuthSetPassword() {
  const pw = $('auth-password').value;
  if (!pw || pw.length < 6) return authStatus('Choose a password (at least 6 characters).');
  $('btn-auth-primary').disabled = true;
  authStatus('Saving…');
  try {
    await updatePassword(pw);
    authStatus('Password updated — you\'re signed in!');
    setTimeout(closeAuth, 1800);
  } catch (e) {
    authStatus(e.message || 'Could not update password.');
  } finally {
    $('btn-auth-primary').disabled = false;
  }
}

// ---- name modal -----------------------------------------------------------

function openName() {
  $('name-input').value        = app.name || '';
  $('name-status').textContent = '';
  $('name-modal').classList.remove('hidden');
  $('name-input').focus();
}
function closeName() { $('name-modal').classList.add('hidden'); }

async function saveName() {
  const v = $('name-input').value.trim().slice(0, 20);
  if (!v) { $('name-status').textContent = 'Enter a name.'; return; }
  app.name = v;
  setGuestName(v);
  if (app.user) {
    try { await setDisplayName(v); } catch { /* keep local */ }
    try { app.profile = await ensureProfile(v); } catch {}
    if (!$('profile-modal').classList.contains('hidden')) renderProfile();
  }
  renderAccount();
  closeName();
  if (gameoverVisible() && lastGameoverScore != null) showLeaderboard(lastGameoverScore);
}

// ---- leaderboard ----------------------------------------------------------

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
      '<span class="lb-rank">'  + (i + 1) + '</span>' +
      '<span class="lb-name">'  + esc(r.name) + '</span>' +
      '<span class="lb-score">' + Number(r.score).toLocaleString() + '</span>';
    el.appendChild(li);
  });
}

async function showLeaderboard(score) {
  lastGameoverScore = score;
  const panel    = $('lb-panel');
  const statusEl = $('lb-status');
  const listEl   = $('lb-list');
  if (!panel || !statusEl || !listEl) return;

  panel.classList.remove('hidden');
  $('lb-actions')?.classList.toggle('hidden', !!app.user);

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

async function openLeaderboardModal() {
  $('lb-modal').classList.remove('hidden');
  setLbTab(lbTab);
}

function setLbTab(tab) {
  lbTab = tab;
  $('lb-tab-global').classList.toggle('active',  tab === 'global');
  $('lb-tab-friends').classList.toggle('active', tab === 'friends');
  loadLbTab();
}

async function loadLbTab() {
  const listEl = $('lb-modal-list');
  if (lbTab === 'friends' && !app.user) {
    listEl.innerHTML = '<li class="lb-empty">Log in and add friends to see this board.</li>';
    return;
  }
  listEl.innerHTML = '<li class="lb-empty">Loading…</li>';
  try {
    const rows = lbTab === 'friends' ? await friendScores(50) : await topScores(20);
    renderList(listEl, rows);
    if (lbTab === 'friends' && !rows.length) {
      listEl.innerHTML = '<li class="lb-empty">No friend scores yet — add friends from your profile.</li>';
    }
  } catch {
    listEl.innerHTML = '<li class="lb-empty">Leaderboard unavailable.</li>';
  }
}

// ---- profile / friends ----------------------------------------------------

function openProfile() {
  $('profile-modal').classList.remove('hidden');
  renderProfile();
}
function closeProfile() { $('profile-modal').classList.add('hidden'); }

function renderProfile() {
  const signedIn = !!app.user;
  $('profile-signedout').classList.toggle('hidden',  signedIn);
  $('profile-signedin').classList.toggle('hidden',  !signedIn);
  if (!signedIn) return;
  $('profile-name').textContent       = currentName();
  $('profile-code').textContent       = app.profile?.friend_code || '––––––––';
  $('friend-add-status').textContent  = '';
  loadFriends();
}

async function loadFriends() {
  if (!app.profile) {
    try {
      app.profile = await ensureProfile(currentName());
      $('profile-code').textContent = app.profile.friend_code;
    } catch {}
  }
  try {
    const [friends, requests] = await Promise.all([listFriends(), listFriendRequests()]);
    renderRequests(requests);
    renderFriendList(friends);
    setRequestCount(requests.length);
  } catch {
    $('friend-list').innerHTML = '<li class="friend-item empty">Could not load friends.</li>';
  }
}

function renderFriendList(friends) {
  const el = $('friend-list');
  el.innerHTML = '';
  if (!friends.length) {
    el.innerHTML = '<li class="friend-item empty">No friends yet — add one with their code.</li>';
    return;
  }
  const showHistory = !!cfg().history;
  for (const f of friends) {
    const li = document.createElement('li');
    li.className = 'friend-item';
    li.innerHTML =
      '<span class="friend-name">' + esc(f.display_name || 'Player') + '</span>' +
      '<span class="friend-actions">' +
      (showHistory ? '<button class="link-btn" data-history="' + f.id + '">HISTORY</button>' : '') +
      '<button class="link-btn" data-remove="' + f.id + '">REMOVE</button></span>';
    li.querySelector('[data-history]')?.addEventListener('click', () => {
      closeProfile();
      openHistory({ userId: app.user?.id, gameSlug: cfg().gameSlug, friendId: f.id, friendName: f.display_name });
    });
    li.querySelector('[data-remove]').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title:       'REMOVE FRIEND?',
        message:     'Remove ' + (f.display_name || 'this player') + ' from your friends? You can add them again later with their friend code.',
        confirmText: 'REMOVE',
        danger:      true,
      });
      if (!ok) return;
      try { await removeFriend(f.id); await loadFriends(); } catch {}
    });
    el.appendChild(li);
  }
}

function renderRequests(requests) {
  const block = $('friend-requests-block');
  const el    = $('friend-requests');
  block.classList.toggle('hidden', !requests.length);
  el.innerHTML = '';
  for (const r of requests) {
    const li = document.createElement('li');
    li.className = 'friend-item';
    li.innerHTML =
      '<span class="friend-name">' + esc(r.display_name || 'Player') + '</span>' +
      '<span class="friend-actions">' +
      '<button class="link-btn" data-accept="'  + r.id + '">ACCEPT</button>' +
      '<button class="link-btn" data-decline="' + r.id + '">DECLINE</button>' +
      '</span>';
    el.appendChild(li);
  }
  el.querySelectorAll('[data-accept]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await respondToRequest(btn.dataset.accept, true); await loadFriends(); } catch {}
    });
  });
  el.querySelectorAll('[data-decline]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await respondToRequest(btn.dataset.decline, false); await loadFriends(); } catch {}
    });
  });
}

async function doAddFriend() {
  const input = $('friend-code-input');
  const code  = input.value.trim();
  if (!code) return;
  $('btn-add-friend').disabled       = true;
  $('friend-add-status').textContent = 'Working…';
  try {
    const result = await addFriendByCode(code);
    $('friend-add-status').textContent = addFriendMessage(result);
    if (result === 'requested' || result === 'accepted') input.value = '';
    await loadFriends();
  } catch (e) {
    $('friend-add-status').textContent = e.message || 'Could not add friend.';
  } finally {
    $('btn-add-friend').disabled = false;
  }
}

async function copyFriendCode() {
  const code = app.profile?.friend_code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    $('profile-copy-code').textContent = 'COPIED';
    setTimeout(() => $('profile-copy-code').textContent = 'COPY', 1500);
  } catch {}
}

function setRequestCount(n) {
  app.requestCount = n;
  const badge = $('profile-badge');
  badge.textContent = n > 0 ? String(n) : '';
  badge.classList.toggle('hidden', !n);
}

async function refreshRequestBadge() {
  if (!app.user) { setRequestCount(0); return; }
  try { setRequestCount((await listFriendRequests()).length); } catch {}
}

// ---- auth state -----------------------------------------------------------

async function onUser(user) {
  app.user = user;
  if (user) app.name = displayName(user);
  else      { app.profile = null; setRequestCount(0); }
  renderAccount();
  if (gameoverVisible() && lastGameoverScore != null) showLeaderboard(lastGameoverScore);
  if (user) {
    try { app.profile = await ensureProfile(displayName(user)); } catch {}
    refreshRequestBadge();
    if (!$('profile-modal').classList.contains('hidden')) renderProfile();
    if (!$('lb-modal').classList.contains('hidden') && lbTab === 'friends') loadLbTab();
  }
}

// ---- hamburger menu wiring ------------------------------------------------

function wireMenu() {
  const btnMenu = $('btn-menu');
  const menu    = $('app-menu');

  function closeMenu() {
    menu.classList.add('hidden');
    btnMenu.setAttribute('aria-expanded', 'false');
  }
  _closeMenu = closeMenu;

  btnMenu.addEventListener('click', e => {
    e.stopPropagation();
    const nowOpen = !menu.classList.toggle('hidden');
    btnMenu.setAttribute('aria-expanded', String(nowOpen));
  });
  // Close when clicking outside or when any menu item is clicked.
  menu.addEventListener('click', closeMenu);
  document.addEventListener('click', e => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btnMenu) {
      closeMenu();
    }
  });

  // Wire help button to show the game's help modal (convention: #help-modal).
  $('help-btn')?.addEventListener('click', () => {
    closeMenu();
    $('help-modal')?.classList.remove('hidden');
  });

  // Wire help modal close buttons so the game doesn't have to.
  const helpModal = $('help-modal');
  if (helpModal) {
    $('help-close')?.addEventListener('click',  () => helpModal.classList.add('hidden'));
    $('help-got-it')?.addEventListener('click', () => helpModal.classList.add('hidden'));
    helpModal.addEventListener('click', e => { if (e.target === helpModal) helpModal.classList.add('hidden'); });
  }
}

// ---- full wiring ----------------------------------------------------------

let _closeMenu = null; // set by wireMenu so wire() can call it on Escape

function closeAllModals() {
  ['auth-modal', 'name-modal', 'lb-modal', 'profile-modal', 'help-modal'].forEach(id =>
    $(id)?.classList.add('hidden')
  );
  _closeMenu?.();
}

function wire() {
  wireMenu();

  $('btn-login')?.addEventListener('click',    () => openAuth('signin'));
  $('btn-logout')?.addEventListener('click',   async () => { try { await signOut(); } catch {} });
  $('btn-set-name')?.addEventListener('click', openName);

  $('auth-close').addEventListener('click',      closeAuth);
  $('auth-tab-signin').addEventListener('click', () => { authStatus(''); setAuthMode('signin'); });
  $('auth-tab-signup').addEventListener('click', () => { authStatus(''); setAuthMode('signup'); });
  $('btn-auth-primary').addEventListener('click', doAuthPrimary);
  $('btn-auth-magic').addEventListener('click',   doAuthMagic);
  $('btn-auth-forgot').addEventListener('click',  () => { authStatus(''); setAuthMode('reset'); $('auth-email').focus(); });
  $('btn-auth-back').addEventListener('click',    () => { authStatus(''); setAuthMode('signin'); $('auth-email').focus(); });
  $('auth-email').addEventListener('keydown',     e => { if (e.key === 'Enter') doAuthPrimary(); });
  $('auth-password').addEventListener('keydown',  e => { if (e.key === 'Enter') doAuthPrimary(); });

  $('name-close').addEventListener('click',    closeName);
  $('btn-name-save').addEventListener('click', saveName);
  $('name-input').addEventListener('keydown',  e => { if (e.key === 'Enter') saveName(); });

  $('btn-leaderboard')?.addEventListener('click', openLeaderboardModal);
  $('lb-modal-close').addEventListener('click',   () => $('lb-modal').classList.add('hidden'));
  $('lb-set-name')?.addEventListener('click',     openName);
  $('lb-login')?.addEventListener('click',        () => openAuth('signin'));
  $('lb-tab-global').addEventListener('click',    () => setLbTab('global'));
  $('lb-tab-friends').addEventListener('click',   () => setLbTab('friends'));

  $('btn-profile').addEventListener('click',       () => { app.user ? openProfile() : openAuth('signin'); });
  $('profile-close').addEventListener('click',     closeProfile);
  $('profile-login').addEventListener('click',     () => { closeProfile(); openAuth('signin'); });
  $('profile-signout').addEventListener('click',   async () => { try { await signOut(); } catch {} closeProfile(); });
  $('profile-change-name').addEventListener('click', openName);
  $('profile-copy-code').addEventListener('click', copyFriendCode);
  $('btn-add-friend').addEventListener('click',    doAddFriend);
  $('friend-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') doAddFriend(); });

  for (const id of ['auth-modal', 'name-modal', 'lb-modal', 'profile-modal']) {
    const m = $(id);
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  }

  // Confirm dialog (sits above the other modals).
  $('confirm-ok').addEventListener('click',     () => settleConfirm(true));
  $('confirm-cancel').addEventListener('click', () => settleConfirm(false));
  $('confirm-modal').addEventListener('click',  e => { if (e.target.id === 'confirm-modal') settleConfirm(false); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (confirmOpen()) { settleConfirm(false); return; } // cancel confirm, leave modal behind it open
    closeAllModals();
  });

  // Listen for the game's gameover event.
  const eventName = cfg().gameoverEvent || (cfg().gameSlug + ':gameover');
  window.addEventListener(eventName, e => showLeaderboard(e.detail?.score ?? 0));
}

// ---- init -----------------------------------------------------------------

async function init() {
  injectHTML();

  // Seed name from the shared guest-name key (before we know if signed in).
  app.name = getGuestName();

  // Stamp the auth intro with this game's name.
  const intro = $('auth-intro');
  if (intro && cfg().gameName) {
    intro.textContent =
      'One account works across ' + cfg().gameName + ' and every other LB Games title — no separate sign-up.';
  }

  wire();
  renderAccount();

  try { app.user = await currentUser(); } catch {}
  renderAccount();

  if (app.user) {
    try { app.profile = await ensureProfile(displayName(app.user)); } catch {}
    refreshRequestBadge();
  }

  onAuthChange(onUser);
  onPasswordRecovery(() => { closeAllModals(); openAuth('newpassword'); });
}

init();
