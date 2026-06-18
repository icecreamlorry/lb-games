// Shared "My Games" chrome — injects the lobby screen and the landing
// account bar so every game shares one copy of that markup. Add a lobby
// button (or an account action) here once and it appears in every game.
//
// Behaviour stays in each game's main.js / the shared account-ui.js, which
// wire the elements by id; this module only owns the structure. It runs at
// import time and MUST load before those wirers (see each index.html), so the
// elements exist when they attach handlers.
//
// Per-game bits come from window.LB_CONFIG:
//   gameName  — shown as the lobby logo (upper-cased to match the landing hero)
//   daily     — when true, the lobby gets a ☀ DAILY button (btn-lobby-daily)
//
// Each game's index.html provides empty mount points:
//   <div id="account-bar"></div>
//   <section id="screen-lobby" class="screen hidden"></section>

const cfg = window.LB_CONFIG || {};
const NAME = (cfg.gameName || 'LB GAMES').toUpperCase();

const accountBar = document.getElementById('account-bar');
if (accountBar) {
  accountBar.innerHTML = `
    <div id="account-line">Playing as a guest</div>
    <div class="account-actions">
      <button id="btn-set-name" class="link-btn">SET NAME</button>
      <button id="btn-login" class="link-btn">LOG IN</button>
      <button id="btn-logout" class="link-btn hidden">LOG OUT</button>
      <button id="btn-go-lobby" class="link-btn hidden">MY GAMES</button>
    </div>
    <p class="hint">Log in to keep several games going and get notified when one starts.</p>`;
}

const lobby = document.getElementById('screen-lobby');
if (lobby) {
  const dailyBtn = cfg.daily
    ? '<button id="btn-lobby-daily" class="btn-daily">☀ DAILY</button>'
    : '';
  lobby.innerHTML = `
    <div class="card wide">
      <header class="bar">
        <span class="logo small">${NAME}</span>
        <span class="grow muted">Hi, <strong id="lobby-name"></strong></span>
        <button id="btn-notify-lobby" class="chip hidden" title="Notify me when a game starts">🔔</button>
        <button id="btn-logout-lobby" class="chip">LOG OUT</button>
      </header>
      <h2 class="card-title">Your games</h2>
      <div class="row">
        <button id="btn-lobby-new" class="btn-primary">NEW GAME</button>
        ${dailyBtn}
        <button id="btn-lobby-challenge" class="btn-ghost">CHALLENGE</button>
        <button id="btn-lobby-join" class="btn-ghost">JOIN BY CODE</button>
        <button id="btn-lobby-history" class="btn-ghost">HISTORY</button>
        <button id="btn-lobby-refresh" class="btn-ghost" title="Refresh">↻</button>
      </div>
      <div id="lobby-join-box" class="row hidden">
        <input id="lobby-code-input" class="field" type="text" maxlength="6" placeholder="ROOM CODE" autocomplete="off" autocapitalize="characters">
        <button id="btn-lobby-join-go" class="btn-primary">JOIN</button>
      </div>
      <p id="lobby-error" class="status-line"></p>
      <div id="lobby-list" class="lobby-list"></div>
    </div>`;
}
