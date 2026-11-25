// abyss: a rare-answer trivia game for you and your friends.
require('./lib/env'); // loads .env if there is one
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const packs = require('./lib/packs');
const db = require('./lib/db');
const auth = require('./lib/auth');
const { matchDetail } = require('./lib/match');
const { judge } = require('./lib/judge');
const party = require('./lib/party');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ANSWER_SECONDS = Number(process.env.ANSWER_SECONDS || 25);
const GRACE_MS = 3000;
const COUNTDOWN = 3; // seconds of countdown the client shows before the clock starts
const PUBLIC = path.join(__dirname, 'public');

// ---------- helpers ----------
function cleanName(n) {
  return String(n || '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}
function publicPlayer(p) {
  return p ? { id: p.id, name: p.display_name, username: p.username || null, guest: !!p.is_guest } : null;
}
const pick = a => a[Math.floor(Math.random() * a.length)];

// ms timestamp of the next daily rollover in TZ_DAILY
function nextMidnight() {
  const tz = process.env.TZ_DAILY || 'Europe/London';
  const today = packs.todayKey(tz);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let t = Date.now(); t < Date.now() + 26 * 3600e3; t += 60e3) if (fmt.format(new Date(t)) !== today) return t - (t % 60e3);
  return Date.now() + 86400e3;
}

// Short-lived cache of session token -> player so every request isn't a DB round trip.
// Capped so a spray of unique bogus cookies can't grow memory without bound; misses
// (invalid tokens) are cached too but expire fast since they're the abuse vector.
const playerCache = new Map();
const PLAYER_CACHE_MAX = 5000;
async function currentPlayer(req) {
  const token = auth.tokenFrom(req);
  if (!token) return null;
  const hash = auth.tokenHash(token);
  const hit = playerCache.get(hash);
  if (hit && hit.t > Date.now() - (hit.p ? 60e3 : 10e3)) return hit.p;
  const p = await db.sessionPlayer(hash);
  playerCache.set(hash, { p, t: Date.now() });
  if (playerCache.size > PLAYER_CACHE_MAX) {
    let drop = playerCache.size - PLAYER_CACHE_MAX; // Map iterates oldest-first
    for (const k of playerCache.keys()) { playerCache.delete(k); if (!--drop) break; }
  }
  if (p) db.touch(p.id).catch(() => {});
  return p;
}
async function startSession(req, res, player) {
  const token = auth.newToken();
  await db.createSession(player.id, auth.tokenHash(token), Date.now() + auth.SESSION_DAYS * 86400e3);
  res.setHeader('Set-Cookie', auth.sessionCookie(req, token));
}

// ---------- dive sessions (daily + unlimited) ----------
const dives = new Map();
// Prompts served to each player in recent unlimited dives, so free dives
// don't keep re-dealing the same questions. In-memory only; a restart just
// forgets the history, which is harmless.
const recentByPlayer = new Map();
const RECENT_CAP = 84; // ~12 dives' worth
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600e3;
  for (const [id, s] of dives) if (s.createdAt < cutoff) dives.delete(id);
}, 600e3).unref();

function publicPrompt(s) {
  const p = packs.getPrompt(s.prompts[s.i]);
  return { i: s.i, total: s.prompts.length, text: p.text, hint: p.hint || null, pack: p.pack, seconds: ANSWER_SECONDS, countdown: COUNTDOWN };
}

function reveal(p) {
  const byTier = {};
  for (const a of p.answers) (byTier[a.tier] ||= []).push(a.name);
  const examples = [];
  for (let t = 1; t <= 5; t++) {
    const list = byTier[t];
    if (list?.length) examples.push({ tier: t, name: list[Math.floor(Math.random() * list.length)] });
  }
  const gem = p.answers.find(a => a.tier === 6)?.name || null;
  const friends = db.topAnswers(p.id, 3).map(([name, n]) => ({ name, n }));
  return { gem, examples, friends, totalAnswers: p.answers.length };
}

function scoreGuess(p, guess) {
  const m = guess ? matchDetail(p.index, guess) : null;
  if (!m) return { ok: false, guess, points: 0 };
  const ans = m.answer, tier = packs.TIERS[ans.tier];
  return { ok: true, exact: m.exact, guess, answer: ans.name, tier: tier.id, tierName: tier.name, points: tier.points, fact: ans.tier === 6 ? p.fact || null : null };
}

const FLAVOUR = {
  0: ['Nothing down there. The clock beat you.', 'Out of air.'],
  1: ['Everyone got that one. Surface water.', 'Safe, but shallow.'],
  2: ['A respectable paddle.', 'Swimming with the shoal.'],
  3: ['Below the light. Nice.', 'Fewer divers make it this far.'],
  4: ['Proper deep. The light is long gone.', 'Genuinely obscure.'],
  5: ['Hardly anyone goes this deep.', 'Absurdly obscure. Respect.'],
  6: ['The Leviathan. That was the one we were hiding.', 'You found the monster.'],
};

// Rejected guesses feed answer curation, but each one is a DB write — cap how
// many one player can log so a flood can't fill the table with junk.
function logRejected(promptId, guess, playerId) {
  if (auth.tooMany('rej:' + playerId, 30, 600e3)) return;
  db.logRejected(promptId, guess, playerId).catch(e => console.error(e.message));
}

function needPlayer(ctx) {
  if (!ctx.player) { const e = new Error('Log in or pick a guest name first'); e.status = 401; throw e; }
  return ctx.player;
}

// crews need a real account, not a one-off guest name
function needAccount(ctx) {
  const p = needPlayer(ctx);
  if (p.is_guest) { const e = new Error('Create an account to use crews'); e.status = 403; throw e; }
  return p;
}
const MAX_OWNED_CREWS = 5, MAX_CREW_MEMBERS = 50;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const crewCode = () => Array.from({ length: 5 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join('');

// ---------- API ----------
const api = {
  'GET /api/meta': () => ({
    today: packs.todayKey(),
    tiers: packs.TIERS.filter(Boolean),
    packs: packs.listPacks(),
    answerSeconds: ANSWER_SECONDS,
    storage: db.kind,
  }),

  // ----- accounts -----
  'GET /api/auth/me': (_b, _q, ctx) => ({ player: publicPlayer(ctx.player) }),

  'POST /api/auth/guest': async (body, _q, ctx) => {
    const name = cleanName(body.name);
    if (!name) return { error: 'Pick a name to play under' };
    // guests are throwaway rows, so cap how many one address can mint
    if (auth.tooMany('guest:' + auth.clientIp(ctx.req), 10, 3600e3)) return { error: 'Too many attempts. Try again in a few minutes.' };
    if (auth.USERNAME_RE.test(name) && await db.playerByUsername(name)) return { error: 'That name belongs to an account. Log in, or pick another name.' };
    const p = await db.createPlayer({ displayName: name, isGuest: true });
    await startSession(ctx.req, ctx.res, p);
    return { player: publicPlayer(p) };
  },

  'POST /api/auth/register': async (body, _q, ctx) => {
    const username = String(body.username || '').trim(), password = String(body.password || '');
    if (!auth.USERNAME_RE.test(username)) return { error: 'Usernames are 3 to 20 letters, numbers or underscores' };
    if (password.length < 6) return { error: 'Use at least 6 characters for your password' };
    if (password.length > 200) return { error: 'That password is too long' };
    const ip = auth.clientIp(ctx.req);
    if (auth.limited('reg:' + ip)) return { error: 'Too many attempts. Try again in a few minutes.' };
    auth.fail('reg:' + ip); // counts every registration from this IP against the limit
    const hash = auth.hashPassword(password);
    let p;
    try {
      // a guest who signs up keeps their stats
      p = ctx.player?.is_guest ? await db.upgradeGuest(ctx.player.id, username, hash)
                               : await db.createPlayer({ username, displayName: username, passwordHash: hash });
    } catch (e) {
      if (e.code === '23505') return { error: 'That username is taken' };
      throw e;
    }
    playerCache.clear();
    await startSession(ctx.req, ctx.res, p);
    return { player: publicPlayer(p) };
  },

  'POST /api/auth/login': async (body, _q, ctx) => {
    const username = String(body.username || '').trim(), password = String(body.password || '');
    const ip = auth.clientIp(ctx.req), uk = 'login:' + username.toLowerCase();
    if (auth.limited('ip:' + ip) || auth.limited(uk)) return { error: 'Too many attempts. Try again in a few minutes.' };
    const p = auth.USERNAME_RE.test(username) ? await db.playerByUsername(username) : null;
    const ok = auth.verifyPassword(password, p?.password_hash || auth.DUMMY_HASH) && p && !p.is_guest;
    if (!ok) { auth.fail('ip:' + ip); auth.fail(uk); return { error: 'Wrong username or password' }; }
    auth.clearFails(uk);
    await startSession(ctx.req, ctx.res, p);
    return { player: publicPlayer(p) };
  },

  'POST /api/auth/logout': async (_b, _q, ctx) => {
    const token = auth.tokenFrom(ctx.req);
    if (token) { const h = auth.tokenHash(token); playerCache.delete(h); await db.deleteSession(h); }
    ctx.res.setHeader('Set-Cookie', auth.clearCookie(ctx.req));
    return { ok: true };
  },

  // ----- dives -----
  'POST /api/dive/start': async (body, _q, ctx) => {
    const player = needPlayer(ctx);
    const mode = body.mode === 'daily' ? 'daily' : 'unlimited';
    const date = packs.todayKey();
    let list;
    if (mode === 'daily') {
      const done = await db.dailyResult(player.id, date);
      if (done) return { already: done, date };
      list = packs.dailyPrompts(date);
    } else {
      // remembered prompts: finished dives from the DB (survives restarts and
      // works across devices) plus this session's in-flight list
      const seenMem = recentByPlayer.get(player.id) || [];
      const seen = await db.recentPromptIds(player.id);
      list = packs.randomPrompts(packs.PER_DIVE, body.pack || null, [...seen, ...seenMem]);
      recentByPlayer.set(player.id, [...seenMem, ...list.map(p => p.id)].slice(-RECENT_CAP));
      db.markSeen(player.id, list.map(p => p.id)).catch(e => console.error(e.message));
    }
    if (!list.length) return { error: 'No prompts loaded' };
    const id = crypto.randomUUID();
    const s = { id, playerId: player.id, mode, date, prompts: list.map(p => p.id), i: 0, picks: [], createdAt: Date.now(), askedAt: Date.now() };
    dives.set(id, s);
    return { sessionId: id, mode, date, prompt: publicPrompt(s) };
  },

  'POST /api/dive/answer': async (body, _q, ctx) => {
    const s = dives.get(body.sessionId);
    if (!s || s.playerId !== ctx.player?.id) return { error: 'Session expired' };
    if (s.i >= s.prompts.length) return { error: 'Dive already finished' };
    // every wrong guess can trigger an AI judge call and a rejected-guess row
    if (auth.tooMany('ans:' + s.playerId, 30, 60e3)) return { error: 'Slow down a little' };
    const p = packs.getPrompt(s.prompts[s.i]);
    const late = Date.now() - s.askedAt > (ANSWER_SECONDS + COUNTDOWN) * 1000 + GRACE_MS;
    const giveUp = late || body.giveUp;
    const guess = late ? '' : String(body.guess || '').slice(0, 80).trim();
    let result = scoreGuess(p, guess);
    if (!giveUp) {
      // still on the clock: misses and typo-corrections don't end the prompt
      if (!result.ok) {
        if (guess) {
          // the AI judge gets a say before a guess is refused for real
          const t0 = Date.now();
          const verdict = await judge(p, guess, { playerId: s.playerId, source: 'dive' });
          s.askedAt += Date.now() - t0; // judging time is on us, not the player
          if (verdict?.valid) {
            const listed = matchDetail(p.index, verdict.name);
            if (!listed) {
              packs.addAnswer(p.id, verdict.name, verdict.tier);
              db.addAddition(p.id, verdict.name, verdict.tier).catch(e => console.error(e.message));
            }
            result = scoreGuess(p, listed ? listed.answer.name : verdict.name);
            if (result.ok) { result.judged = true; result.guess = guess; }
          }
        }
        if (!result.ok) {
          if (guess) logRejected(p.id, guess, s.playerId);
          return { retry: true, guess };
        }
      }
      if (!result.exact) { s.fromGuess = guess; return { confirm: { from: guess, to: result.answer } }; }
    } else if (!result.ok) {
      result = { ok: false, guess, points: 0 };
    }
    result.flavour = pick(FLAVOUR[result.ok ? result.tier : 0]);
    // keep the first thing they typed (before a typo-confirm resubmits the canonical name)
    if (s.fromGuess && s.fromGuess !== result.guess) result.typed = s.fromGuess;
    s.fromGuess = null;
    if (result.ok) {
      result.friendsSaid = db.answerCount(p.id, result.answer);
      if (s.mode === 'daily') db.bump(p.id, result.answer).catch(e => console.error(e.message));
    }
    s.picks.push({ prompt: p.text, promptId: p.id, ...result });
    s.i++;
    const out = { result, reveal: reveal(p) };
    if (s.i < s.prompts.length) {
      s.askedAt = Date.now();
      out.next = true;
    } else {
      const score = s.picks.reduce((t, x) => t + x.points, 0);
      out.final = { score, depth: score * 10, picks: s.picks, mode: s.mode, date: s.date };
      await db.saveDive({ playerId: s.playerId, mode: s.mode, date: s.date, score, picks: s.picks });
      dives.delete(s.id);
    }
    return out;
  },

  'POST /api/dive/next': (body, _q, ctx) => {
    const s = dives.get(body.sessionId);
    if (!s || s.playerId !== ctx.player?.id || s.i >= s.prompts.length) return { error: 'No next prompt' };
    s.askedAt = Date.now();
    return { prompt: publicPrompt(s) };
  },

  // Every valid answer for a prompt. Today's daily prompts only open up once you've finished today's dive.
  'GET /api/answers': async (_b, q, ctx) => {
    const p = packs.getPrompt(q.get('id') || '');
    if (!p) return { error: 'Unknown prompt' };
    const today = packs.todayKey();
    if (packs.dailyPrompts(today).some(x => x.id === p.id) && !(ctx.player && await db.dailyResult(ctx.player.id, today))) {
      return { error: 'Finish today’s dive first' };
    }
    return {
      id: p.id, text: p.text, fact: p.fact || null,
      answers: p.answers.map(a => ({ name: a.name, tier: a.tier, n: db.answerCount(p.id, a.name) }))
        .sort((a, b) => b.tier - a.tier || b.n - a.n || a.name.localeCompare(b.name)),
    };
  },

  'GET /api/me': async (_b, _q, ctx) => {
    const player = needPlayer(ctx);
    return { ...(await db.stats(player.id, packs.todayKey())), nextDiveAt: nextMidnight(), player: publicPlayer(player) };
  },

  'GET /api/leaderboard': async (_b, q, ctx) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : packs.todayKey();
    const [daily, allTime] = await Promise.all([db.leaderboard(date), db.allTime()]);
    return {
      date,
      daily: daily.map(r => ({ name: r.name, guest: r.guest, me: r.playerId === ctx.player?.id, score: r.score, picks: r.picks.map(p => p.tier || 0) })),
      allTime,
    };
  },

  // ----- crews: private leaderboards, accounts only -----
  'GET /api/crews': async (_b, _q, ctx) => {
    const p = needAccount(ctx);
    const list = await db.crewsOf(p.id);
    return { crews: await Promise.all(list.map(async c => ({ code: c.code, name: c.name, mine: c.owner_id === p.id, members: await db.crewMemberCount(c.id) }))) };
  },

  'POST /api/crews': async (body, _q, ctx) => {
    const p = needAccount(ctx);
    const name = cleanName(body.name);
    if (!name) return { error: 'Give your crew a name' };
    if ((await db.crewsOf(p.id)).filter(c => c.owner_id === p.id).length >= MAX_OWNED_CREWS) return { error: `You can run up to ${MAX_OWNED_CREWS} crews` };
    for (let i = 0; i < 8; i++) {
      try { const c = await db.createCrew({ code: crewCode(), name, ownerId: p.id }); return { crew: { code: c.code, name: c.name } }; }
      catch (e) { if (e.code !== '23505') throw e; }
    }
    return { error: 'Couldn’t make a code, try again' };
  },

  'POST /api/crews/join': async (body, _q, ctx) => {
    const p = needAccount(ctx);
    const c = await db.crewByCode(String(body.code || '').trim().toUpperCase());
    if (!c) return { error: 'No crew with that code' };
    if (await db.crewMemberCount(c.id) >= MAX_CREW_MEMBERS) return { error: 'That crew is full' };
    await db.addCrewMember(c.id, p.id);
    return { crew: { code: c.code, name: c.name } };
  },

  'GET /api/crews/board': async (_b, q, ctx) => {
    const p = needAccount(ctx);
    const c = await db.crewByCode(String(q.get('code') || '').trim().toUpperCase());
    if (!c) return { error: 'No crew with that code' };
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : packs.todayKey();
    const b = await db.crewBoards(c.id, date);
    if (!b.members.some(m => m.id === p.id)) return { error: 'You’re not in this crew', notMember: true, name: c.name };
    return {
      date, crew: { code: c.code, name: c.name, mine: c.owner_id === p.id, members: b.members.length },
      daily: b.daily.map(r => ({ name: r.name, guest: r.guest, me: r.playerId === p.id, score: r.score, picks: r.picks.map(x => x.tier || 0) })),
      allTime: b.allTime.map(r => ({ name: r.name, guest: r.guest, me: r.playerId === p.id, dives: r.dives, best: r.best, total: r.total })),
    };
  },

  'POST /api/crews/leave': async (body, _q, ctx) => {
    const p = needAccount(ctx);
    const c = await db.crewByCode(String(body.code || '').trim().toUpperCase());
    if (!c) return { error: 'No crew with that code' };
    if (c.owner_id === p.id) await db.deleteCrew(c.id); // the owner leaving closes the crew
    else await db.removeCrewMember(c.id, p.id);
    return { ok: true, closed: c.owner_id === p.id };
  },

  // ----- admin -----
  'GET /api/admin/rejected': async (_b, q) => {
    if (!ADMIN_KEY || q.get('key') !== ADMIN_KEY) return { error: 'Set ADMIN_KEY and pass ?key=' };
    const counts = {};
    for (const r of await db.rejected()) {
      const k = r.promptId + '||' + r.guess.toLowerCase();
      (counts[k] ||= { promptId: r.promptId, guess: r.guess, n: 0 }).n++;
    }
    return { rejected: Object.values(counts).sort((a, b) => b.n - a.n) };
  },

  'POST /api/admin/accept': async (body) => {
    if (!ADMIN_KEY || body.key !== ADMIN_KEY) return { error: 'Bad key' };
    if (!packs.getPrompt(body.promptId)) return { error: 'Unknown prompt' };
    const name = String(body.name).slice(0, 80), tier = Math.min(5, Math.max(1, Number(body.tier) || 3));
    await db.addAddition(body.promptId, name, tier);
    packs.addAnswer(body.promptId, name, tier);
    return { ok: true };
  },

  'GET /api/admin/judged': async (_b, q) => {
    if (!ADMIN_KEY || q.get('key') !== ADMIN_KEY) return { error: 'Bad key' };
    try { return { judged: await db.judged() }; }
    catch (e) { return { judged: [], note: e.message }; }
  },

  'POST /api/admin/reload': async (body) => {
    if (!ADMIN_KEY || body.key !== ADMIN_KEY) return { error: 'Bad key' };
    packs.setAdditions(await db.additions());
    packs.load();
    return { ok: true, packs: packs.listPacks() };
  },
};

// ---------- http ----------
// Behind a proxy (Tailscale Serve/Funnel, Cloudflare Tunnel) the Host header can be the local
// address, so also accept X-Forwarded-Host and PUBLIC_URL when checking a POST's Origin.
function sameSite(req) {
  let origin; try { origin = new URL(req.headers.origin).host; } catch { return false; }
  const ok = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',').map(s => s.trim())];
  if (process.env.PUBLIC_URL) try { ok.push(new URL(process.env.PUBLIC_URL).host); } catch {}
  return ok.filter(Boolean).includes(origin);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const handler = api[`${req.method} ${url.pathname}`];
  if (handler) {
    // cookies are SameSite=Lax; also refuse cross-site POSTs outright
    if (req.method === 'POST' && req.headers.origin && !sameSite(req)) {
      res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"Bad origin"}');
    }
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
      try { body = JSON.parse(raw || '{}'); } catch {}
    }
    let out, status = 200;
    try {
      const player = await currentPlayer(req);
      out = await handler(body, url.searchParams, { req, res, player });
      if (out?.error) status = 400;
    } catch (e) {
      status = e.status || 500;
      if (status === 500) console.error(e);
      out = { error: status === 500 ? 'Server error' : e.message };
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('{}'); }

  // static files; unknown paths fall back to index.html (so /room/ABCD works)
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch {
    res.writeHead(400); return res.end('Bad request');
  }
  const file = path.normalize(path.join(PUBLIC, pathname));
  // real containment check: rel escapes PUBLIC if it climbs out or lands on another drive
  const rel = path.relative(PUBLIC, file);
  if (file.includes('\0') || rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    const target = (err || st.isDirectory()) ? path.join(PUBLIC, 'index.html') : file;
    fs.readFile(target, (err2, data) => {
      if (err2) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

party.attach(server, { cleanName, scoreGuess, currentPlayer, db, logRejected, sameSite });

(async () => {
  await db.init();
  packs.setAdditions(await db.additions());
  packs.load();
  server.listen(PORT, () => console.log(`abyss running on http://localhost:${PORT} (storage: ${db.kind})`));
})().catch(e => { console.error('Failed to start:', e.message); process.exit(1); });
