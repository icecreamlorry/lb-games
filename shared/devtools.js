// Shared in-app dev tools panel for LB Games.
//
// Drop-in for any game: add ONE line to the page after the menu exists, e.g.
//   <script type="module" src="../shared/devtools.js"></script>
//
// It adds a "Dev tools" item to the existing hamburger menu (#app-menu) and
// opens a self-styled panel with:
//   • a scrollable, live log of recent errors/warnings (from devlog.js), and
//   • a feature-flags section games can populate at runtime.
//
// Everything here is game-agnostic: the panel brings its own styles (scoped to
// .lbdev-*) so it looks the same and needs no per-game CSS, and it attaches to
// whatever menu the game injects, whenever that happens.
//
// Feature flags API (for gating experimental gameplay):
//   import { registerFlag, flagEnabled, onFlagChange } from '../shared/devtools.js';
//   registerFlag({ key: 'fastTimer', label: 'Fast timer', default: false });
//   if (flagEnabled('fastTimer')) { ... }
// or via the global: window.LBDevtools.flagEnabled('fastTimer')

import { getEntries, clearEntries, subscribe } from './devlog.js';

const FLAGS_KEY = 'lb_devflags';
const $ = (id) => document.getElementById(id);

// ---- feature flags --------------------------------------------------------

const flagDefs = new Map();       // key -> { key, label, description, default }
const flagListeners = new Set();  // (key, value) -> void

function readFlags() {
  try { return JSON.parse(localStorage.getItem(FLAGS_KEY)) || {}; }
  catch { return {}; }
}
function writeFlags(obj) {
  try { localStorage.setItem(FLAGS_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

export function registerFlag({ key, label, description = '', default: def = false }) {
  if (!key) return;
  flagDefs.set(key, { key, label: label || key, description, default: !!def });
  renderFlags();
}

export function flagEnabled(key) {
  const flags = readFlags();
  if (key in flags) return !!flags[key];
  return !!flagDefs.get(key)?.default;
}

export function setFlag(key, value) {
  const flags = readFlags();
  flags[key] = !!value;
  writeFlags(flags);
  for (const fn of flagListeners) { try { fn(key, !!value); } catch { /* ignore */ } }
  renderFlags();
}

export function onFlagChange(fn) {
  flagListeners.add(fn);
  return () => flagListeners.delete(fn);
}

// ---- styles ---------------------------------------------------------------

function injectStyles() {
  if ($('lbdev-styles')) return;
  const style = document.createElement('style');
  style.id = 'lbdev-styles';
  style.textContent = `
    #lbdev-modal {
      position: fixed; inset: 0; z-index: 980;
      display: none; align-items: center; justify-content: center;
      background: rgba(2,2,8,0.82);
      -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
      padding: 16px; font-family: 'Share Tech Mono', ui-monospace, monospace;
    }
    #lbdev-modal.lbdev-open { display: flex; }
    .lbdev-panel {
      width: 100%; max-width: 680px; max-height: 88vh;
      display: flex; flex-direction: column;
      background: #07071a;
      border: 1px solid rgba(0,245,255,0.28);
      border-radius: 6px;
      box-shadow: 0 0 40px rgba(0,245,255,0.08), inset 0 0 60px rgba(0,0,0,0.5);
      color: #cfe9ee;
    }
    .lbdev-head {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px; border-bottom: 1px solid rgba(0,245,255,0.18);
    }
    .lbdev-title {
      flex: 1; font-family: 'Orbitron', monospace; font-weight: 800;
      font-size: 0.74rem; letter-spacing: 0.22em; color: #00f5ff;
      text-shadow: 0 0 10px rgba(0,245,255,0.6); text-transform: uppercase;
    }
    .lbdev-btn {
      background: transparent; color: #00f5ff;
      border: 1px solid rgba(0,245,255,0.4); border-radius: 3px;
      padding: 5px 10px; font-family: inherit; font-size: 0.62rem;
      letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .lbdev-btn:hover { background: rgba(0,245,255,0.12); color: #fff; }
    .lbdev-btn.lbdev-x { border-color: rgba(255,0,200,0.5); color: #ff5ad8; }
    .lbdev-btn.lbdev-x:hover { background: rgba(255,0,200,0.14); color: #fff; }
    .lbdev-body { overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
    .lbdev-section-label {
      font-family: 'Orbitron', monospace; font-size: 0.5rem; letter-spacing: 0.18em;
      color: rgba(255,0,200,0.75); text-transform: uppercase; margin-bottom: 6px;
    }
    .lbdev-log {
      list-style: none; margin: 0; padding: 0;
      display: flex; flex-direction: column; gap: 1px;
      font-size: 0.68rem; line-height: 1.45;
    }
    .lbdev-row {
      display: grid; grid-template-columns: 58px 44px 1fr; gap: 8px;
      padding: 4px 6px; border-radius: 2px;
      border-left: 2px solid transparent; white-space: pre-wrap; word-break: break-word;
    }
    .lbdev-row .lbdev-time { color: rgba(0,245,255,0.4); font-variant-numeric: tabular-nums; }
    .lbdev-row .lbdev-lvl  { font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.56rem; }
    .lbdev-row.error { background: rgba(255,40,80,0.06); border-left-color: #ff3b5c; }
    .lbdev-row.error .lbdev-lvl { color: #ff6a85; }
    .lbdev-row.warn  { background: rgba(255,210,0,0.05); border-left-color: #ffd23b; }
    .lbdev-row.warn  .lbdev-lvl { color: #ffe06a; }
    .lbdev-row.info  .lbdev-lvl { color: rgba(0,245,255,0.7); }
    .lbdev-row .lbdev-msg { color: #d6eef2; }
    .lbdev-empty { padding: 18px 6px; text-align: center; color: rgba(0,245,255,0.4); font-size: 0.7rem; }
    .lbdev-flags { display: flex; flex-direction: column; gap: 6px; }
    .lbdev-flag {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px; border-radius: 3px;
      background: rgba(0,245,255,0.04); border: 1px solid rgba(0,245,255,0.12);
    }
    .lbdev-flag-text { flex: 1; }
    .lbdev-flag-label { font-size: 0.72rem; color: #d6eef2; }
    .lbdev-flag-desc  { font-size: 0.58rem; color: rgba(0,245,255,0.45); margin-top: 2px; }
    .lbdev-toggle {
      flex-shrink: 0; width: 40px; height: 22px; border-radius: 11px; cursor: pointer;
      border: 1px solid rgba(0,245,255,0.4); background: rgba(0,245,255,0.06);
      position: relative; transition: background 0.15s, border-color 0.15s;
    }
    .lbdev-toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 16px; height: 16px; border-radius: 50%;
      background: rgba(0,245,255,0.6); transition: transform 0.15s, background 0.15s;
    }
    .lbdev-toggle.on { background: rgba(0,245,255,0.25); border-color: #00f5ff; }
    .lbdev-toggle.on::after { transform: translateX(18px); background: #00f5ff; }
    .lbdev-empty-flags { font-size: 0.62rem; color: rgba(0,245,255,0.4); padding: 4px 2px; }
  `;
  document.head.appendChild(style);
}

// ---- panel ----------------------------------------------------------------

function buildPanel() {
  if ($('lbdev-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'lbdev-modal';
  modal.innerHTML = `
    <div class="lbdev-panel">
      <div class="lbdev-head">
        <span class="lbdev-title">Dev Tools</span>
        <button class="lbdev-btn" id="lbdev-copy">Copy</button>
        <button class="lbdev-btn" id="lbdev-clear">Clear</button>
        <button class="lbdev-btn lbdev-x" id="lbdev-close">Close</button>
      </div>
      <div class="lbdev-body">
        <div>
          <div class="lbdev-section-label">Feature flags</div>
          <div class="lbdev-flags" id="lbdev-flags"></div>
        </div>
        <div>
          <div class="lbdev-section-label">Recent log</div>
          <ul class="lbdev-log" id="lbdev-log"></ul>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => { if (e.target === modal) closePanel(); });
  $('lbdev-close').addEventListener('click', closePanel);
  $('lbdev-clear').addEventListener('click', () => { clearEntries(); renderLog(); });
  $('lbdev-copy').addEventListener('click', copyLog);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closePanel();
  });
}

function fmtTime(t) {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}

function renderLog() {
  const el = $('lbdev-log');
  if (!el) return;
  const rows = getEntries();
  if (!rows.length) {
    el.innerHTML = '<li class="lbdev-empty">No log entries yet.</li>';
    return;
  }
  el.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'lbdev-row ' + r.level;
    const time = document.createElement('span'); time.className = 'lbdev-time'; time.textContent = fmtTime(r.t);
    const lvl  = document.createElement('span'); lvl.className  = 'lbdev-lvl';  lvl.textContent  = r.level;
    const msg  = document.createElement('span'); msg.className  = 'lbdev-msg';  msg.textContent  = r.msg;
    li.append(time, lvl, msg);
    el.appendChild(li);
  }
  // Keep the newest entries in view.
  const body = el.closest('.lbdev-body');
  if (body) body.scrollTop = body.scrollHeight;
}

function renderFlags() {
  const el = $('lbdev-flags');
  if (!el) return;
  if (!flagDefs.size) {
    el.innerHTML = '<div class="lbdev-empty-flags">No feature flags registered.</div>';
    return;
  }
  el.innerHTML = '';
  for (const def of flagDefs.values()) {
    const on = flagEnabled(def.key);
    const row = document.createElement('div');
    row.className = 'lbdev-flag';
    row.innerHTML =
      '<div class="lbdev-flag-text">' +
        '<div class="lbdev-flag-label"></div>' +
        (def.description ? '<div class="lbdev-flag-desc"></div>' : '') +
      '</div>' +
      '<div class="lbdev-toggle' + (on ? ' on' : '') + '" role="switch"></div>';
    row.querySelector('.lbdev-flag-label').textContent = def.label;
    if (def.description) row.querySelector('.lbdev-flag-desc').textContent = def.description;
    const toggle = row.querySelector('.lbdev-toggle');
    toggle.setAttribute('aria-checked', String(on));
    toggle.addEventListener('click', () => setFlag(def.key, !flagEnabled(def.key)));
    el.appendChild(row);
  }
}

async function copyLog() {
  const text = getEntries().map(r => `${fmtTime(r.t)} [${r.level}] ${r.msg}`).join('\n');
  const btn = $('lbdev-copy');
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1400); }
  } catch {
    if (btn) { btn.textContent = 'Failed'; setTimeout(() => { btn.textContent = 'Copy'; }, 1400); }
  }
}

function isOpen() { return $('lbdev-modal')?.classList.contains('lbdev-open'); }

export function openPanel() {
  buildPanel();
  renderFlags();
  renderLog();
  $('lbdev-modal').classList.add('lbdev-open');
  $('app-menu')?.classList.add('hidden'); // dismiss the hamburger if it's open
}

function closePanel() { $('lbdev-modal')?.classList.remove('lbdev-open'); }

// Live-update the log while the panel is open.
subscribe(() => { if (isOpen()) renderLog(); });

// ---- menu item ------------------------------------------------------------

function makeMenuItem() {
  const btn = document.createElement('button');
  btn.className = 'menu-item menu-sep';
  btn.id = 'lbdev-menu-item';
  btn.title = 'Dev tools';
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6.5 2.5 3 6l3.5 3.5"/><path d="M9.5 6.5 13 10l-3.5 3.5"/>' +
    '</svg><span>Dev tools</span>';
  btn.addEventListener('click', openPanel);
  return btn;
}

// Attach to #app-menu now, or as soon as the game injects it.
function attachMenuItem() {
  const menu = $('app-menu');
  if (menu && !$('lbdev-menu-item')) {
    menu.appendChild(makeMenuItem());
    return true;
  }
  return false;
}

function init() {
  injectStyles();
  if (attachMenuItem()) return;
  // The menu may be injected later (e.g. by account-ui.js). Watch for it.
  const observer = new MutationObserver(() => {
    if (attachMenuItem()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose a small global so non-module game code can use flags / open the panel.
window.LBDevtools = { registerFlag, flagEnabled, setFlag, onFlagChange, openPanel };
