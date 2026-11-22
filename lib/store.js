// Tiny JSON-file store. Fine for a friend group; swap for SQLite if it grows.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'store.json');
let db = { results: {}, counts: {}, rejected: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(FILE + '.tmp', FILE);
  }, 300);
}

function getResult(date, name) { return db.results[date]?.[name.toLowerCase()] || null; }
function putResult(date, name, result) {
  (db.results[date] ||= {})[name.toLowerCase()] = { name, ...result, at: Date.now() };
  save();
}
function leaderboard(date) {
  return Object.values(db.results[date] || {}).sort((a, b) => b.score - a.score);
}
function allTime() {
  const totals = {};
  for (const day of Object.values(db.results)) {
    for (const r of Object.values(day)) {
      const t = (totals[r.name.toLowerCase()] ||= { name: r.name, total: 0, dives: 0, best: 0 });
      t.total += r.score; t.dives++; t.best = Math.max(t.best, r.score);
    }
  }
  return Object.values(totals).sort((a, b) => b.total - a.total);
}
// streak / played / average / best for one diver
function stats(name, today) {
  const key = name.toLowerCase();
  const days = Object.keys(db.results).filter(d => db.results[d][key]).sort();
  const scores = days.map(d => db.results[d][key].score);
  let streak = 0;
  const cur = new Date(today + 'T12:00:00Z');
  if (!db.results[today]?.[key]) cur.setUTCDate(cur.getUTCDate() - 1); // streak still alive if today isn't played yet
  while (db.results[cur.toISOString().slice(0, 10)]?.[key]) { streak++; cur.setUTCDate(cur.getUTCDate() - 1); }
  return {
    streak, played: days.length,
    avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    best: scores.length ? Math.max(...scores) : 0,
    playedToday: !!db.results[today]?.[key],
  };
}
function countAnswer(promptId, answer) {
  const c = (db.counts[promptId] ||= {});
  c[answer] = (c[answer] || 0) + 1;
  save();
  return c[answer];
}
function answerCount(promptId, answer) { return db.counts[promptId]?.[answer] || 0; }
function topAnswers(promptId, n = 5) {
  return Object.entries(db.counts[promptId] || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
}
function logRejected(promptId, guess, by) {
  db.rejected.push({ promptId, guess, by, at: Date.now() });
  if (db.rejected.length > 5000) db.rejected.splice(0, db.rejected.length - 5000);
  save();
}
function rejected() { return db.rejected; }

module.exports = { stats, getResult, putResult, leaderboard, allTime, countAnswer, answerCount, topAnswers, logRejected, rejected };
