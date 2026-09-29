// Client for the LB Games Worker API (worker/src/index.js) + the local session.
//
// The signed-in session is { token, user } in localStorage under SESSION_KEY.
// user has the same shape supabase-js used ({ id, email, user_metadata:
// { display_name } }), so callers didn't need to change. shared/boot.js reads
// the same key in classic-script form for pre-paint routing — keep in sync.

import { API_BASE } from './api-config.js';

export const SESSION_KEY = 'lb.auth';

// ---- session ----------------------------------------------------------------

let session = readStored();
const listeners = new Set();

function readStored() {
  try {
    // Sessions from the old Supabase backend can't be carried over: drop them
    // so nobody looks signed in with a token the new API won't accept.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (/^sb-.+-auth-token$/.test(k)) localStorage.removeItem(k);
    }
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s?.token && s?.user ? s : null;
  } catch {
    return null;
  }
}

export function getSession() { return session; }

export function setSession(next, event = next ? 'SIGNED_IN' : 'SIGNED_OUT') {
  const prevId = session?.user?.id ?? null;
  session = next?.token && next?.user ? { token: next.token, user: next.user } : null;
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
  const changed = prevId !== (session?.user?.id ?? null) || event === 'USER_UPDATED';
  if (changed || event === 'PASSWORD_RECOVERY') emit(event);
}

function emit(event) {
  for (const cb of [...listeners]) {
    try { cb(event, session); } catch (e) { console.error(e); }
  }
}

// cb(event, session) on sign-in / sign-out / profile update / recovery.
export function onSessionChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Another tab signed in or out.
try {
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_KEY) return;
    const prevId = session?.user?.id ?? null;
    session = readStored();
    if (prevId !== (session?.user?.id ?? null)) emit(session ? 'SIGNED_IN' : 'SIGNED_OUT');
  });
} catch {}

// ---- requests -------------------------------------------------------------

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// api('/rooms/ABC') → parsed JSON. Throws ApiError on a non-2xx (404 from GET
// endpoints that return null bodies resolves to null instead, see allow404).
export async function api(path, { method = 'GET', body, allow404 = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('Network error — check your connection.', 0, 'network');
  }
  if (res.status === 404 && allow404) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    // A token the server no longer accepts means we're really signed out.
    if (res.status === 401 && session && path !== '/auth/login') setSession(null);
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.code);
  }
  return data;
}

// WebSocket URL for a room's live channel.
export function wsUrl(path) {
  return API_BASE.replace(/^http/, 'ws') + path;
}

// ---- session validation + email-link redemption (once per page) ----------

let validated = null;

// Resolves once the stored session has been checked with the server (and its
// token refreshed) and any #lb_auth= email link in the URL has been redeemed.
export function sessionReady() {
  if (validated) return validated;
  validated = (async () => {
    const m = /[#&]lb_auth=([A-Za-z0-9_-]+)/.exec(location.hash || '');
    if (m) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch {}
      try {
        const r = await api('/auth/redeem', { method: 'POST', body: { token: m[1] } });
        setSession(r);
        if (r.kind === 'reset') setTimeout(() => emit('PASSWORD_RECOVERY'), 0);
        return;
      } catch (e) {
        console.warn('Sign-in link failed:', e.message);
      }
    }
    if (!session) return;
    try {
      const r = await api('/auth/me');
      setSession(r, 'TOKEN_REFRESHED');
    } catch {
      // 401 already cleared the session; a network error keeps it (offline).
    }
  })();
  return validated;
}
