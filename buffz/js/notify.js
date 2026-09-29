// Background notifications for Buffz (e.g. "a game started" / "your opponent
// peeled"). Local notifications fire while the tab is alive in the background;
// server push (when configured) delivers even with the browser closed. Shown
// through a service worker because Android Chrome can't use `new Notification`.

import { VAPID_PUBLIC_KEY } from './config.js';
import { savePushSubscription, deletePushSubscription } from './net.js';

const MUTE_KEY = 'buffz_notify_muted';
const TAG = 'buffz-turn';

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

export async function showLocalNotification(title, body) {
  if (!isEnabled()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    await reg.showNotification(title, { body, tag: TAG, renotify: true, vibrate: [120, 60, 120] });
  } catch {
    /* ignore */
  }
}

// ---- Server (Web) Push ----------------------------------------------------

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

function sameServerKey(buf, base64) {
  if (!buf) return true; // browser doesn't expose it — assume it matches
  const a = new Uint8Array(buf);
  const b = urlBase64ToUint8Array(base64);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function subscribeToPush(route) {
  if (!pushSupported() || !isEnabled()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // A subscription made under a different server key (e.g. before the move
    // to the Cloudflare backend) can never be pushed to again — replace it.
    if (sub && !sameServerKey(sub.options?.applicationServerKey, VAPID_PUBLIC_KEY)) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
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
