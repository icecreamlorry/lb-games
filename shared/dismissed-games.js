// Shared "remove from My Games" support for every LB Games title.
//
// Removing a game hides it from THIS player's lobby on THIS device/account —
// the room still exists server-side and the other player keeps their own copy.
// Removals are stored locally per game + user, using the same localStorage key
// each game used before this was shared, so existing removals are preserved.
//
// Game slug comes from window.LB_CONFIG.gameSlug (set in each game's index.html).

const slug = () => (window.LB_CONFIG && window.LB_CONFIG.gameSlug) || 'lb';
const keyFor = (userId) => `${slug()}.dismissed.${userId}`;

export function getDismissed(userId) {
  try { return new Set(JSON.parse(localStorage.getItem(keyFor(userId)) || '[]')); }
  catch { return new Set(); }
}

export function dismissGame(userId, code) {
  const set = getDismissed(userId);
  set.add(code);
  try { localStorage.setItem(keyFor(userId), JSON.stringify([...set])); } catch {}
}

// Drops removed rooms from a fetched list before it's rendered in the lobby.
export function filterDismissed(userId, rooms) {
  const dismissed = getDismissed(userId);
  return rooms.filter((r) => r && !dismissed.has(r.code));
}

// Builds the × control for a lobby card. Clicking it removes the game and runs
// onRemoved() (e.g. to refresh the empty state). Append the returned node to
// the card; the card needs position: relative (the shared .lobby-dismiss CSS
// positions the × in its corner).
export function makeDismissControl({ userId, code, card, onRemoved }) {
  const x = document.createElement('span');
  x.className = 'lobby-dismiss';
  x.textContent = '×';
  x.title = 'Remove from your games';
  x.setAttribute('role', 'button');
  x.setAttribute('aria-label', 'Remove from your games');
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissGame(userId, code);
    card.remove();
    onRemoved && onRemoved();
  });
  return x;
}
