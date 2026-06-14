// A per-session guest identity, so each browser tab is a distinct player even
// when guests share a display name (the cross-game guest name is the same
// across tabs, so name alone can't tell two guests apart).
//
// Stored in sessionStorage: it survives reloads of the SAME tab — so a guest
// who refreshes resumes their seat — but is unique per tab/session, so two
// tabs (or two devices) never collide on the same seat.

const KEY = 'lbgames.guestId';

export function getGuestId() {
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `g_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(KEY, id);
  }
  return id;
}
