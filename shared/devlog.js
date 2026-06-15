// Shared in-app log buffer for LB Games.
//
// A tiny, DOM-free ring buffer that records errors/warnings so they can be
// inspected from inside the site itself (see devtools.js) — handy on phones
// where there's no DevTools console. Importing this module is enough to start
// capturing; it:
//   • patches console.error / console.warn (originals still fire), and
//   • listens for uncaught errors and unhandled promise rejections.
// Code can also record explicitly via logError() / logWarn() / logInfo().
//
// The buffer is persisted to localStorage so entries survive a page
// navigation or reload (e.g. landing → game, or a crash + refresh).

const STORE_KEY = 'lb_devlog';
const CAPACITY = 300;

const listeners = new Set();
let entries = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(-CAPACITY) : [];
  } catch {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or unavailable — keep the in-memory buffer either way */
  }
}

// Render any argument into a single readable string.
function fmt(arg) {
  if (arg instanceof Error) return arg.stack || (arg.name + ': ' + arg.message);
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function fmtAll(args) {
  return args.map(fmt).join(' ');
}

// Add an entry and notify any live viewers.
export function record(level, message) {
  const entry = { t: Date.now(), level, msg: String(message).slice(0, 4000) };
  entries.push(entry);
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
  persist();
  for (const fn of listeners) {
    try { fn(entry); } catch { /* a broken viewer must not break logging */ }
  }
  return entry;
}

export const logError = (...args) => record('error', fmtAll(args));
export const logWarn  = (...args) => record('warn',  fmtAll(args));
export const logInfo  = (...args) => record('info',  fmtAll(args));

export function getEntries() {
  return entries.slice();
}

export function clearEntries() {
  entries = [];
  persist();
  for (const fn of listeners) {
    try { fn(null); } catch { /* ignore */ }
  }
}

// Subscribe to new entries (or null on clear). Returns an unsubscribe fn.
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- automatic capture ----------------------------------------------------

let installed = false;

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn  = console.warn.bind(console);
  console.error = (...args) => { record('error', fmtAll(args)); origError(...args); };
  console.warn  = (...args) => { record('warn',  fmtAll(args)); origWarn(...args); };

  window.addEventListener('error', (e) => {
    if (e?.error) record('error', fmt(e.error));
    else record('error', (e?.message || 'Script error') + (e?.filename ? ` (${e.filename}:${e.lineno})` : ''));
  });

  window.addEventListener('unhandledrejection', (e) => {
    record('error', 'Unhandled promise rejection: ' + fmt(e?.reason));
  });
}

install();
