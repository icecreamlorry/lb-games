// "Your turn" notifications for when the tab is backgrounded.
//
// This fires a local notification while the page is still alive in the
// background (e.g. you switched apps or locked the phone but the browser
// kept the tab running). It is not server push: if the browser itself is
// closed no notification is delivered, since the move arrives over the
// page's own websocket/polling. Notifications are shown through a service
// worker because Android Chrome does not support the `new Notification()`
// constructor.

import { VAPID_PUBLIC_KEY } from './config.js';
import { savePushSubscription, deletePushSubscription } from './net.js';

const MUTE_KEY = 'wurdz_notify_muted';
const TAG = 'wurdz-turn';

export function notificationsSupported() {
  return typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export function isMuted() {
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function setMuted(v) {
  localStorage.setItem(MUTE_KEY, v ? '1' : '0');
}

export function isEnabled() {
  return notificationsSupported() && Notification.permission === 'granted' && !isMuted();
}

export async function registerServiceWorker() {
  if (!notificationsSupported()) return;
  try {
    await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url));
  } catch {
    /* notifications just won't be available */
  }
}

export async function requestNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export async function showTurnNotification(body) {
  if (!isEnabled()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    await reg.showNotification("Wurdz — it's your turn", {
      body,
      tag: TAG,
      renotify: true,
      vibrate: [120, 60, 120],
    });
  } catch {
    /* ignore */
  }
}

export async function clearTurnNotification() {
  if (!notificationsSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const open = await reg.getNotifications({ tag: TAG });
    open.forEach((n) => n.close());
  } catch {
    /* ignore */
  }
}

// ---- Server (Web) Push ---------------------------------------------------

export function pushSupported() {
  return notificationsSupported() && 'PushManager' in window && !!VAPID_PUBLIC_KEY;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Subscribe this device to Web Push so the opponent's move can reach us even
// with the browser closed. No-ops unless notifications are enabled and a
// VAPID key is configured.
//
// Pass { userId } when signed in (one subscription notifies across all the
// account's games), or { roomCode, player } when anonymous (that seat only).
export async function subscribeToPush(route) {
  if (!pushSupported() || !isEnabled()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    await savePushSubscription(sub.toJSON(), route);
  } catch {
    /* push just won't be available on this device */
  }
}

export async function unsubscribeFromPush() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await deletePushSubscription(sub.endpoint).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch {
    /* ignore */
  }
}
