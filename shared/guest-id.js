// A persistent per-device guest identity.
//
// Stored in localStorage so it survives page reloads AND full browser restarts.
// This is what lets a guest rejoin the room they were in — their seat on the
// room is matched by this id — so guest play is as seamless as signed-in play.
// (It used to live in sessionStorage, which the browser wipes on close: the
// returning guest got a fresh id, couldn't be matched to their seat, and hit
// "that room is already full" when trying to rejoin with the code.)
//
// It's per-device: two different browsers/devices are naturally different
// guests. Two tabs in the same browser share it (the same person), exactly like
// a signed-in account shared across tabs.

const KEY = 'lbgames.guestId';

export function getGuestId() {
  let id = null;
  // Prefer the persistent id; fall back to (and migrate) any older
  // sessionStorage id so a guest mid-session keeps the same identity.
  try { id = localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch { /* storage blocked */ }
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `g_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
  try { localStorage.setItem(KEY, id); }
  catch { try { sessionStorage.setItem(KEY, id); } catch { /* nothing more we can do */ } }
  return id;
}
