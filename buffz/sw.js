// Minimal service worker — exists only so the page can show "your turn"
// notifications (Android Chrome requires showNotification from a worker)
// and so tapping one focuses the game. No fetch handler, so it does not
// cache anything or interfere with deploys.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The page tells us which room it is currently showing (and whether it's
// visible) so a push for one game isn't swallowed while a different game is
// open. Keyed by client id; cleared when a tab hides or leaves the room.
const visibleRooms = new Map(); // clientId -> room code currently visible
self.addEventListener('message', (event) => {
  const id = event.source && event.source.id;
  if (!id || !event.data || event.data.type !== 'room-visible') return;
  if (event.data.visible && event.data.code) visibleRooms.set(id, event.data.code);
  else visibleRooms.delete(id);
});

// Web Push from the Edge Function. Skip the OS notification only when the
// player is already looking at THIS game's room; pushes for other games (or
// when nothing is visible) still come through.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { /* keep defaults */ }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const lookingAtThisGame = clients.some(
      (c) => c.visibilityState === 'visible' &&
        (!data.room_code || visibleRooms.get(c.id) === data.room_code),
    );
    if (lookingAtThisGame) return;
    await self.registration.showNotification(data.title || "Buffz — game on", {
      body: data.body || 'Your move!',
      tag: 'buffz-turn',
      renotify: true,
      vibrate: [120, 60, 120],
      data: { url: data.url || './' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
