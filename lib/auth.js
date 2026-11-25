// Username + password accounts (no email), guest sessions, cookies.
const crypto = require('crypto');

const COOKIE = 'abyss_sid';
const SESSION_DAYS = 60;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const [kind, saltB64, hashB64] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const want = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

// a hash to compare against when the username doesn't exist, so timing doesn't leak which names are taken
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function tokenHash(t) { return crypto.createHash('sha256').update(t).digest('hex'); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, token) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}
function clearCookie(req) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}
function tokenFrom(req) { return parseCookies(req.headers.cookie)[COOKIE] || null; }

// Very small brute-force guard: per IP and per username, 10 failures per 15 minutes.
const fails = new Map();
const WINDOW = 15 * 60e3, LIMIT = 10;
function limited(key) {
  const f = fails.get(key);
  return f && f.n >= LIMIT && Date.now() - f.t < WINDOW;
}
function fail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.t > WINDOW) fails.set(key, { n: 1, t: Date.now() });
  else f.n++;
}
function clearFails(key) { fails.delete(key); }
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (now - f.t > WINDOW) fails.delete(k); }, 60e3).unref();

// X-Forwarded-For is only trustworthy when the immediate peer is a local proxy
// (Tailscale Serve, cloudflared) — otherwise clients can spoof it to rotate
// rate-limit buckets. Direct connections use the socket address.
function isLoopback(ip) {
  return ip === '::1' || ip === '::ffff:127.0.0.1' || String(ip || '').startsWith('127.');
}
function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  if (isLoopback(peer)) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return peer;
}

// Generic fixed-window rate limiter for abuse caps beyond password brute force
// (guest creation, room creation, log spam). Returns true once over the limit.
const buckets = new Map();
const BUCKET_CAP = 20000;
function tooMany(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t >= windowMs) {
    // unique-key spray defence, fail closed: sweep expired, then evict oldest —
    // never reset everyone at once, and never grow without bound
    if (buckets.size >= BUCKET_CAP) {
      for (const [k, x] of buckets) if (now - x.t > x.w) buckets.delete(k);
      while (buckets.size >= BUCKET_CAP) buckets.delete(buckets.keys().next().value);
    }
    b = { n: 0, t: now, w: windowMs };
    buckets.set(key, b);
  }
  return ++b.n > limit;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > b.w) buckets.delete(k); }, 60e3).unref();

module.exports = {
  COOKIE, SESSION_DAYS, USERNAME_RE, DUMMY_HASH,
  hashPassword, verifyPassword, newToken, tokenHash, tokenFrom,
  sessionCookie, clearCookie, limited, fail, clearFails, clientIp, tooMany,
};
