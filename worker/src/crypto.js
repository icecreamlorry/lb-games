// Crypto helpers for the LB Games Worker — all WebCrypto, no dependencies.
//   • base64url encode/decode
//   • HS256 JWT sign/verify (session tokens)
//   • PBKDF2-SHA256 password hashing
//   • random ids / codes

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function uuid() {
  return crypto.randomUUID();
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export function randomCode(len) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time byte comparison.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- JWT (HS256) ----------------------------------------------------------

const keyCache = new Map();
async function hmacKey(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, k);
  }
  return k;
}

export async function signJwt(payload, secret) {
  const head = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

export async function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64u(parts[1])));
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Passwords (PBKDF2-SHA256) ---------------------------------------------
// Stored as pbkdf2_sha256$<iterations>$<salt b64u>$<hash b64u>. The iteration
// count travels with the hash, so it can be raised later: verifyPassword tells
// the caller when a stored hash is below the current target so it can rehash.

export const PBKDF2_ITERATIONS = 50000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64u(salt)}$${b64u(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return { ok: false };
  const [scheme, iterStr, saltStr, hashStr] = stored.split('$');
  if (scheme !== 'pbkdf2_sha256') return { ok: false };
  const iterations = parseInt(iterStr, 10);
  const got = await pbkdf2(password, unb64u(saltStr), iterations);
  const ok = timingSafeEqual(got, unb64u(hashStr));
  return { ok, rehash: ok && iterations < PBKDF2_ITERATIONS };
}
