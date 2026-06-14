// One guest display name, shared across every LB Games title.
//
// localStorage is scoped to the origin (not the path), so every game under
// /lb-games/ reads and writes the same key — set your name once (on the
// landing page or in any game) and it follows you everywhere. Signed-in
// players use their account display name instead of this.

const KEY = 'lbgames.name';

export const GUEST_NAME_KEY = KEY;

export function getGuestName() {
  return (localStorage.getItem(KEY) || '').trim();
}

// Trims + caps at 20 chars, stores it, and returns the stored value.
export function setGuestName(name) {
  const v = (name || '').trim().slice(0, 20);
  if (v) localStorage.setItem(KEY, v);
  else localStorage.removeItem(KEY);
  return v;
}
