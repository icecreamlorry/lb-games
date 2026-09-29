// Web Push for the LB Games Worker — WebCrypto only (no web-push package).
//   • RFC 8292 VAPID: an ES256 JWT proving we own the application server key.
//   • RFC 8291 message encryption with the aes128gcm content coding (RFC 8188).
//
// The VAPID private key is the VAPID_PRIVATE_JWK secret (a P-256 JWK with
// d/x/y). The matching public key, 0x04‖x‖y as base64url, is what clients pass
// to pushManager.subscribe({ applicationServerKey }) — see shared/api-config.js.

import { b64u, unb64u, concat, randomBytes } from './crypto.js';

const enc = new TextEncoder();

let vapidCache = null;
async function vapidKeys(env) {
  if (vapidCache && vapidCache.src === env.VAPID_PRIVATE_JWK) return vapidCache;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const privateKey = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const publicRaw = concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y));
  vapidCache = { src: env.VAPID_PRIVATE_JWK, privateKey, publicB64: b64u(publicRaw) };
  return vapidCache;
}

export async function vapidPublicKey(env) {
  return (await vapidKeys(env)).publicB64;
}

async function vapidHeader(env, endpoint) {
  const { privateKey, publicB64 } = await vapidKeys(env);
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  })));
  // WebCrypto ECDSA signatures are already the raw r‖s form JOSE wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicB64}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

// Encrypt `plaintext` (string) for one subscription → the aes128gcm body.
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);

  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = randomBytes(16);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096, big-endian
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Send one push. Resolves to the push service's HTTP status (201 = queued;
// 404/410 = the subscription is gone and should be deleted).
export async function sendPush(env, subscription, payload) {
  const body = await encryptPayload(subscription, payload);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(env, subscription.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}
