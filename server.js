// Abyss: a rare-answer trivia game for you and your friends.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const packs = require('./lib/packs');
const store = require('./lib/store');
const { matchDetail } = require('./lib/match');
const party = require('./lib/party');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ANSWER_SECONDS = Number(process.env.ANSWER_SECONDS || 25);
const GRACE_MS = 3000;
const COUNTDOWN = 3; // seconds of countdown the client shows before the clock starts
const PUBLIC = path.join(__dirname, 'public');

packs.load();

// ---------- dive sessions (daily + unlimited) ----------
const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600e3;
  for (const [id, s] of sessions) if (s.createdAt < cutoff) sessions.delete(id);
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
  const friends = store.topAnswers(p.id, 3).map(([name, n]) => ({ name, n }));
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
const pick = a => a[Math.floor(Math.random() * a.length)];

const api = {
  'GET /api/meta': () => ({
    today: packs.todayKey(),
    tiers: packs.TIERS.filter(Boolean),
    packs: packs.listPacks(),
    answerSeconds: ANSWER_SECONDS,
  }),

  'POST /api/dive/start': (body) => {
    const name = cleanName(body.name);
    if (!name) return { error: 'Pick a name first' };
    const mode = body.mode === 'daily' ? 'daily' : 'unlimited';
    const date = packs.todayKey();
    let list;
    if (mode === 'daily') {
      const done = store.getResult(date, name);
      if (done) return { already: done, date };
      list = packs.dailyPrompts(date);
    } else {
      list = packs.randomPrompts(packs.PER_DIVE, body.pack || null);
    }
    if (!list.length) return { error: 'No prompts loaded' };
    const id = crypto.randomUUID();
    const s = { id, name, mode, date, prompts: list.map(p => p.id), i: 0, picks: [], createdAt: Date.now(), askedAt: Date.now() };
    sessions.set(id, s);
    return { sessionId: id, mode, date, prompt: publicPrompt(s) };
  },

  'POST /api/dive/answer': (body) => {
    const s = sessions.get(body.sessionId);
    if (!s) return { error: 'Session expired' };
    if (s.i >= s.prompts.length) return { error: 'Dive already finished' };
    const p = packs.getPrompt(s.prompts[s.i]);
    const late = Date.now() - s.askedAt > (ANSWER_SECONDS + COUNTDOWN) * 1000 + GRACE_MS;
    const giveUp = late || body.giveUp;
    const guess = late ? '' : String(body.guess || '').slice(0, 80).trim();
    let result = scoreGuess(p, guess);
    if (!giveUp) {
      // still on the clock: misses and typo-corrections don't end the prompt
      if (!result.ok) {
        if (guess) store.logRejected(p.id, guess, s.name);
        return { retry: true, guess };
      }
      if (!result.exact) return { confirm: { from: guess, to: result.answer } };
    } else if (!result.ok) {
      result = { ok: false, guess, points: 0 }; // time ran out
    }
    result.flavour = pick(FLAVOUR[result.ok ? result.tier : 0]);
    if (result.ok) result.friendsSaid = store.answerCount(p.id, result.answer);
    if (result.ok && s.mode === 'daily') store.countAnswer(p.id, result.answer);
    s.picks.push({ prompt: p.text, promptId: p.id, ...result });
    s.i++;
    const out = { result, reveal: reveal(p) };
    if (s.i < s.prompts.length) {
      s.askedAt = Date.now();
      out.next = true;
    } else {
      const score = s.picks.reduce((t, x) => t + x.points, 0);
      out.final = { score, depth: score * 10, picks: s.picks, mode: s.mode, date: s.date };
      s.finished = true;
      if (s.mode === 'daily') store.putResult(s.date, s.name, { score, picks: s.picks });
    }
    return out;
  },

  // Client calls this when it's ready to show the next prompt (starts the clock)
  'POST /api/dive/next': (body) => {
    const s = sessions.get(body.sessionId);
    if (!s || s.i >= s.prompts.length) return { error: 'No next prompt' };
    s.askedAt = Date.now();
    return { prompt: publicPrompt(s) };
  },

  // Every valid answer for a prompt, for the end-of-dive browser. Today's daily prompts
  // are only revealed to someone who has already finished today's dive.
  'GET /api/answers': (_b, q) => {
    const p = packs.getPrompt(q.get('id') || '');
    if (!p) return { error: 'Unknown prompt' };
    const today = packs.todayKey();
    const inDaily = packs.dailyPrompts(today).some(x => x.id === p.id);
    const name = cleanName(q.get('name'));
    if (inDaily && !(name && store.getResult(today, name))) return { error: 'Finish today\'s dive first' };
    return {
      id: p.id, text: p.text, fact: p.fact || null,
      answers: p.answers.map(a => ({ name: a.name, tier: a.tier, n: store.answerCount(p.id, a.name) }))
        .sort((a, b) => b.tier - a.tier || b.n - a.n || a.name.localeCompare(b.name)),
    };
  },

  'GET /api/me': (_b, q) => {
    const name = cleanName(q.get('name'));
    if (!name) return { error: 'No name' };
    return { ...store.stats(name, packs.todayKey()), nextDiveAt: nextMidnight() };
  },

  'GET /api/leaderboard': (_b, q) => {
    const date = q.get('date') || packs.todayKey();
    return { date, daily: store.leaderboard(date).map(r => ({ name: r.name, score: r.score, picks: r.picks.map(p => p.tier || 0) })), allTime: store.allTime() };
  },

  'GET /api/admin/rejected': (_b, q) => {
    if (!ADMIN_KEY || q.get('key') !== ADMIN_KEY) return { error: 'Set ADMIN_KEY and pass ?key=' };
    const counts = {};
    for (const r of store.rejected()) {
      const k = r.promptId + '||' + r.guess.toLowerCase();
      (counts[k] ||= { promptId: r.promptId, guess: r.guess, n: 0 }).n++;
    }
    return { rejected: Object.values(counts).sort((a, b) => b.n - a.n) };
  },

  'POST /api/admin/accept': (body) => {
    if (!ADMIN_KEY || body.key !== ADMIN_KEY) return { error: 'Bad key' };
    if (!packs.getPrompt(body.promptId)) return { error: 'Unknown prompt' };
    packs.addAnswer(body.promptId, String(body.name).slice(0, 80), Math.min(5, Math.max(1, Number(body.tier) || 3)));
    return { ok: true };
  },

  'POST /api/admin/reload': (body) => {
    if (!ADMIN_KEY || body.key !== ADMIN_KEY) return { error: 'Bad key' };
    packs.load();
    return { ok: true, packs: packs.listPacks() };
  },
};

// ms timestamp of the next daily rollover in TZ_DAILY
function nextMidnight() {
  const tz = process.env.TZ_DAILY || 'Europe/London';
  const now = Date.now();
  const today = packs.todayKey(tz);
  for (let t = now; t < now + 26 * 3600e3; t += 60e3) {
    if (new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)) !== today) return t - (t % 60e3);
  }
  return now + 86400e3;
}

function cleanName(n) {
  return String(n || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 20);
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const handler = api[`${req.method} ${url.pathname}`];
  if (handler) {
    let body = {};
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
      try { body = JSON.parse(raw || '{}'); } catch {}
    }
    let out;
    try { out = handler(body, url.searchParams); } catch (e) { console.error(e); out = { error: 'Server error' }; }
    res.writeHead(out?.error ? 400 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('{}'); }

  // static files; any unknown path falls back to index.html (so /room/ABCD works)
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) file = path.join(PUBLIC, 'index.html');
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

party.attach(server, { cleanName, scoreGuess, store });

server.listen(PORT, () => console.log(`Abyss running on http://localhost:${PORT}`));
