// Storage. Uses Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
// otherwise a local JSON file (handy for development or a quick LAN game).
// "How many people said X" counts are cached in memory so reads stay instant.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const counts = new Map(); // promptId -> Map(answer -> n)
function cached(promptId) { let m = counts.get(promptId); if (!m) counts.set(promptId, (m = new Map())); return m; }

// ---------------- Supabase ----------------
function supabaseBackend(url, key) {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = ({ data, error }) => { if (error) { const e = new Error(`[supabase] ${error.message}`); e.code = error.code; throw e; } return data; };

  // prune_storage() caps rejected_guesses, drops expired sessions and reaps dive-less
  // inactive guests. Called once at startup and occasionally on inserts — the odds are
  // low enough that the cost is noise, high enough that the tables never grow far.
  function pruneOccasionally(p = 0.02) {
    if (Math.random() >= p) return;
    sb.rpc('prune_storage').then(({ error }) => { if (error) console.error(`[supabase] prune: ${error.message}`); });
  }

  return {
    kind: 'supabase',
    async init() {
      // load all counts in pages of 1000
      for (let from = 0; ; from += 1000) {
        const rows = must(await sb.from('answer_counts').select('prompt_id,answer,n').range(from, from + 999));
        for (const r of rows) cached(r.prompt_id).set(r.answer, r.n);
        if (rows.length < 1000) break;
      }
      pruneOccasionally(1);
    },
    async createPlayer(p) {
      return must(await sb.from('players').insert({
        username: p.username || null, display_name: p.displayName, password_hash: p.passwordHash || null, is_guest: !!p.isGuest,
      }).select().single());
    },
    async playerByUsername(username) {
      return must(await sb.from('players').select('*').eq('username', username).maybeSingle());
    },
    async upgradeGuest(id, username, passwordHash) {
      return must(await sb.from('players').update({ username, display_name: username, password_hash: passwordHash, is_guest: false })
        .eq('id', id).eq('is_guest', true).select().single());
    },
    async createSession(playerId, hash, expiresAt) {
      must(await sb.from('sessions').insert({ token_hash: hash, player_id: playerId, expires_at: new Date(expiresAt).toISOString() }));
    },
    async sessionPlayer(hash) {
      const row = must(await sb.from('sessions').select('expires_at, players(*)').eq('token_hash', hash).maybeSingle());
      if (!row || new Date(row.expires_at) < new Date()) return null;
      return row.players;
    },
    async deleteSession(hash) { must(await sb.from('sessions').delete().eq('token_hash', hash)); },
    async touch(id) { await sb.from('players').update({ last_seen_at: new Date().toISOString() }).eq('id', id); },

    async dailyResult(playerId, date) {
      return must(await sb.from('dives').select('score,picks').eq('player_id', playerId).eq('mode', 'daily').eq('dive_date', date).maybeSingle());
    },
    async saveDive(d) {
      const { error } = await sb.from('dives').insert({ player_id: d.playerId, mode: d.mode, dive_date: d.date, score: d.score, picks: d.picks });
      if (error && error.code !== '23505') throw new Error(`[supabase] ${error.message}`); // 23505 = already saved today
    },
    async leaderboard(date) {
      const rows = must(await sb.from('dives').select('score,picks,player_id,players(display_name,is_guest)')
        .eq('mode', 'daily').eq('dive_date', date).order('score', { ascending: false }).limit(500));
      return rows.map(r => ({ playerId: r.player_id, name: r.players.display_name, guest: r.players.is_guest, score: r.score, picks: r.picks }));
    },
    async allTime() {
      const rows = must(await sb.rpc('all_time_board', { p_limit: 100 }));
      return rows.map(r => ({ name: r.display_name, guest: r.is_guest, total: Number(r.total), dives: Number(r.dives), best: r.best }));
    },
    async dailyHistory(playerId) {
      return must(await sb.from('dives').select('dive_date,score').eq('player_id', playerId).eq('mode', 'daily')
        .order('dive_date', { ascending: false }).limit(1000)).map(r => ({ date: r.dive_date, score: r.score }));
    },
    async freeDiveCount(playerId) {
      const { count, error } = await sb.from('dives').select('id', { count: 'exact', head: true }).eq('player_id', playerId).eq('mode', 'unlimited');
      if (error) throw new Error(`[supabase] ${error.message}`);
      return count || 0;
    },
    // prompt ids served to the player in finished dives over the last `days` days
    async recentPromptIds(playerId, days = 14, diveLimit = 100) {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = must(await sb.from('dives').select('picks').eq('player_id', playerId)
        .gte('created_at', since).order('id', { ascending: false }).limit(diveLimit));
      const served = await sb.from('seen_prompts').select('prompt_id').eq('player_id', playerId)
        .gte('created_at', since).order('id', { ascending: false }).limit(diveLimit * 7);
      if (served.error) console.error(`[supabase] seen_prompts: ${served.error.message}`);
      return [...rows.flatMap(r => (r.picks || []).map(p => p.promptId).filter(Boolean)), ...(served.data || []).map(r => r.prompt_id)];
    },
    async markSeen(playerId, promptIds) {
      must(await sb.from('seen_prompts').insert(promptIds.map(id => ({ player_id: playerId, prompt_id: id }))));
    },
    async bump(promptId, answer) {
      const n = must(await sb.rpc('bump_answer', { p_prompt: promptId, p_answer: answer }));
      cached(promptId).set(answer, n);
      return n;
    },
    async logRejected(promptId, guess, playerId) {
      await sb.from('rejected_guesses').insert({ prompt_id: promptId, guess, player_id: playerId || null });
      pruneOccasionally();
    },
    async rejected() {
      return must(await sb.from('rejected_guesses').select('prompt_id,guess').order('created_at', { ascending: false }).limit(5000))
        .map(r => ({ promptId: r.prompt_id, guess: r.guess }));
    },
    async logJudge(r) {
      await sb.from('judge_log').insert({ player_id: r.playerId || null, prompt_id: r.promptId, guess: r.guess,
        outcome: r.outcome, name: r.name || null, tier: r.tier || null, ms: r.ms || null, source: r.source || 'dive' });
    },
    async judged() {
      return must(await sb.from('judge_log').select('prompt_id,guess,outcome,name,tier,ms,source,created_at,players(display_name)')
        .order('created_at', { ascending: false }).limit(500))
        .map(r => ({ promptId: r.prompt_id, guess: r.guess, outcome: r.outcome, name: r.name, tier: r.tier, ms: r.ms,
          source: r.source, at: r.created_at, playerName: r.players?.display_name || '?' }));
    },
    async additions() {
      return must(await sb.from('accepted_answers').select('prompt_id,name,tier'));
    },
    async addAddition(promptId, name, tier) {
      must(await sb.from('accepted_answers').upsert({ prompt_id: promptId, name, tier }));
    },

    // ----- crews -----
    async createCrew({ code, name, ownerId }) { // throws code 23505 if the code is taken
      const c = must(await sb.from('crews').insert({ code, name, owner_id: ownerId }).select().single());
      must(await sb.from('crew_members').insert({ crew_id: c.id, player_id: ownerId }));
      return c;
    },
    async crewByCode(code) { return must(await sb.from('crews').select('*').eq('code', code).maybeSingle()); },
    async addCrewMember(crewId, playerId) { must(await sb.from('crew_members').upsert({ crew_id: crewId, player_id: playerId }, { ignoreDuplicates: true })); },
    async removeCrewMember(crewId, playerId) { must(await sb.from('crew_members').delete().eq('crew_id', crewId).eq('player_id', playerId)); },
    async deleteCrew(crewId) { must(await sb.from('crews').delete().eq('id', crewId)); },
    async crewsOf(playerId) {
      const rows = must(await sb.from('crew_members').select('crews(id,code,name,owner_id,created_at)').eq('player_id', playerId));
      return rows.map(r => r.crews).filter(Boolean).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    async crewMembers(crewId) {
      return must(await sb.from('crew_members').select('joined_at,players(id,display_name,is_guest)').eq('crew_id', crewId))
        .map(r => ({ id: r.players.id, name: r.players.display_name, guest: r.players.is_guest, joinedAt: r.joined_at }));
    },
    async crewMemberCount(crewId) {
      const { count, error } = await sb.from('crew_members').select('player_id', { count: 'exact', head: true }).eq('crew_id', crewId);
      if (error) throw new Error(`[supabase] ${error.message}`);
      return count || 0;
    },
    async dailyDivesOf(playerIds) {
      if (!playerIds.length) return [];
      return must(await sb.from('dives').select('player_id,dive_date,score,picks').eq('mode', 'daily').in('player_id', playerIds).limit(20000))
        .map(r => ({ playerId: r.player_id, date: r.dive_date, score: r.score, picks: r.picks }));
    },
  };
}

// ---------------- local JSON file ----------------
function jsonBackend(file) {
  let db = { players: [], sessions: {}, dives: [], counts: {}, rejected: [], additions: [], crews: [], crewMembers: [] };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  if (!Array.isArray(db.players)) db.players = [];
  if (!Array.isArray(db.dives)) db.dives = [];
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(db));
      fs.renameSync(file + '.tmp', file);
    }, 250);
  };
  const byId = id => db.players.find(p => p.id === id) || null;
  const lower = s => String(s || '').toLowerCase();

  return {
    kind: 'json',
    async init() {
      for (const [pid, m] of Object.entries(db.counts)) for (const [a, n] of Object.entries(m)) cached(pid).set(a, n);
      // same housekeeping as the supabase prune: expired sessions, dive-less guests idle 30+ days
      const now = Date.now();
      for (const [h, s] of Object.entries(db.sessions)) if (s.expiresAt < now) delete db.sessions[h];
      const hasDives = new Set(db.dives.map(d => d.playerId));
      const before = db.players.length;
      db.players = db.players.filter(p => !p.is_guest || hasDives.has(p.id)
        || new Date(p.last_seen_at || p.created_at).getTime() > now - 30 * 86400e3);
      if (db.players.length !== before) save();
    },
    async createPlayer(p) {
      if (p.username && db.players.some(x => lower(x.username) === lower(p.username))) {
        const e = new Error('taken'); e.code = '23505'; throw e;
      }
      const row = { id: crypto.randomUUID(), username: p.username || null, display_name: p.displayName, password_hash: p.passwordHash || null, is_guest: !!p.isGuest, created_at: new Date().toISOString() };
      db.players.push(row); save(); return row;
    },
    async playerByUsername(u) { return db.players.find(x => x.username && lower(x.username) === lower(u)) || null; },
    async upgradeGuest(id, username, passwordHash) {
      if (db.players.some(x => lower(x.username) === lower(username))) { const e = new Error('taken'); e.code = '23505'; throw e; }
      const p = byId(id); if (!p || !p.is_guest) throw new Error('not a guest');
      Object.assign(p, { username, display_name: username, password_hash: passwordHash, is_guest: false }); save(); return p;
    },
    async createSession(playerId, hash, expiresAt) { db.sessions[hash] = { playerId, expiresAt }; save(); },
    async sessionPlayer(hash) {
      const s = db.sessions[hash];
      if (!s || s.expiresAt < Date.now()) return null;
      return byId(s.playerId);
    },
    async deleteSession(hash) { delete db.sessions[hash]; save(); },
    async touch(id) { const p = byId(id); if (p) { p.last_seen_at = new Date().toISOString(); save(); } },

    async dailyResult(playerId, date) {
      return db.dives.find(d => d.playerId === playerId && d.mode === 'daily' && d.date === date) || null;
    },
    async saveDive(d) {
      if (d.mode === 'daily' && db.dives.some(x => x.playerId === d.playerId && x.mode === 'daily' && x.date === d.date)) return;
      db.dives.push({ ...d, at: Date.now() }); save();
    },
    async leaderboard(date) {
      return db.dives.filter(d => d.mode === 'daily' && d.date === date).sort((a, b) => b.score - a.score)
        .map(d => { const p = byId(d.playerId) || {}; return { playerId: d.playerId, name: p.display_name || '?', guest: !!p.is_guest, score: d.score, picks: d.picks }; });
    },
    async allTime() {
      const t = new Map();
      for (const d of db.dives) {
        if (d.mode !== 'daily') continue;
        const p = byId(d.playerId) || {};
        const r = t.get(d.playerId) || { name: p.display_name || '?', guest: !!p.is_guest, total: 0, dives: 0, best: 0 };
        r.total += d.score; r.dives++; r.best = Math.max(r.best, d.score); t.set(d.playerId, r);
      }
      return [...t.values()].sort((a, b) => b.total - a.total).slice(0, 100);
    },
    async dailyHistory(playerId) {
      return db.dives.filter(d => d.playerId === playerId && d.mode === 'daily').map(d => ({ date: d.date, score: d.score })).sort((a, b) => b.date.localeCompare(a.date));
    },
    async freeDiveCount(playerId) { return db.dives.filter(d => d.playerId === playerId && d.mode === 'unlimited').length; },
    async recentPromptIds(playerId, days = 14, diveLimit = 100) {
      const since = Date.now() - days * 86400000;
      return [
        ...db.dives.filter(d => d.playerId === playerId && (!d.at || d.at > since)).slice(-diveLimit)
          .flatMap(d => (d.picks || []).map(p => p.promptId).filter(Boolean)),
        ...(db.seen || []).filter(s => s.playerId === playerId && s.at > since).map(s => s.promptId),
      ];
    },
    async markSeen(playerId, promptIds) {
      db.seen ||= [];
      for (const promptId of promptIds) db.seen.push({ playerId, promptId, at: Date.now() });
      if (db.seen.length > 20000) db.seen.splice(0, db.seen.length - 20000);
      save();
    },
    async bump(promptId, answer) {
      const c = (db.counts[promptId] ||= {}); c[answer] = (c[answer] || 0) + 1; save();
      cached(promptId).set(answer, c[answer]); return c[answer];
    },
    async logRejected(promptId, guess, playerId) {
      db.rejected.push({ promptId, guess, playerId, at: Date.now() });
      if (db.rejected.length > 5000) db.rejected.splice(0, db.rejected.length - 5000);
      save();
    },
    async rejected() { return db.rejected.slice().reverse(); },
    async logJudge(r) {
      db.judgeLog ||= [];
      db.judgeLog.push({ ...r, at: Date.now() });
      if (db.judgeLog.length > 5000) db.judgeLog.splice(0, db.judgeLog.length - 5000);
      save();
    },
    async judged() {
      return (db.judgeLog || []).slice(-500).reverse()
        .map(r => ({ ...r, playerName: byId(r.playerId)?.display_name || '?' }));
    },
    async additions() { return db.additions.map(a => ({ prompt_id: a.promptId, name: a.name, tier: a.tier })); },
    async addAddition(promptId, name, tier) {
      const i = db.additions.findIndex(a => a.promptId === promptId && a.name.toLowerCase() === name.toLowerCase());
      if (i >= 0) db.additions[i].tier = tier; else db.additions.push({ promptId, name, tier });
      save();
    },

    // ----- crews -----
    async createCrew({ code, name, ownerId }) {
      if (db.crews.some(c => c.code === code)) { const e = new Error('taken'); e.code = '23505'; throw e; }
      const c = { id: crypto.randomUUID(), code, name, owner_id: ownerId, created_at: new Date().toISOString() };
      db.crews.push(c); db.crewMembers.push({ crewId: c.id, playerId: ownerId, joinedAt: c.created_at }); save(); return c;
    },
    async crewByCode(code) { return db.crews.find(c => c.code === code) || null; },
    async addCrewMember(crewId, playerId) {
      if (!db.crewMembers.some(m => m.crewId === crewId && m.playerId === playerId)) { db.crewMembers.push({ crewId, playerId, joinedAt: new Date().toISOString() }); save(); }
    },
    async removeCrewMember(crewId, playerId) { db.crewMembers = db.crewMembers.filter(m => !(m.crewId === crewId && m.playerId === playerId)); save(); },
    async deleteCrew(crewId) { db.crews = db.crews.filter(c => c.id !== crewId); db.crewMembers = db.crewMembers.filter(m => m.crewId !== crewId); save(); },
    async crewsOf(playerId) {
      const ids = new Set(db.crewMembers.filter(m => m.playerId === playerId).map(m => m.crewId));
      return db.crews.filter(c => ids.has(c.id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    async crewMembers(crewId) {
      return db.crewMembers.filter(m => m.crewId === crewId).map(m => { const p = byId(m.playerId) || {}; return { id: m.playerId, name: p.display_name || '?', guest: !!p.is_guest, joinedAt: m.joinedAt }; });
    },
    async crewMemberCount(crewId) { return db.crewMembers.filter(m => m.crewId === crewId).length; },
    async dailyDivesOf(playerIds) {
      const set = new Set(playerIds);
      return db.dives.filter(d => d.mode === 'daily' && set.has(d.playerId)).map(d => ({ playerId: d.playerId, date: d.date, score: d.score, picks: d.picks }));
    },
  };
}

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const backend = url && key ? supabaseBackend(url, key) : jsonBackend(path.join(__dirname, '..', 'data', 'db.json'));

module.exports = {
  ...backend,
  answerCount(promptId, answer) { return counts.get(promptId)?.get(answer) || 0; },
  topAnswers(promptId, n = 5) { return [...(counts.get(promptId) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, n); },

  // daily + all-time tables for one crew's members (members with no dives still show up)
  async crewBoards(crewId, date) {
    const members = await backend.crewMembers(crewId);
    const rows = await backend.dailyDivesOf(members.map(m => m.id));
    const daily = rows.filter(r => r.date === date).sort((a, b) => b.score - a.score)
      .map(r => ({ playerId: r.playerId, name: members.find(m => m.id === r.playerId)?.name, guest: members.find(m => m.id === r.playerId)?.guest, score: r.score, picks: r.picks }));
    const allTime = members.map(m => {
      const mine = rows.filter(r => r.playerId === m.id);
      return { playerId: m.id, name: m.name, guest: m.guest, dives: mine.length, best: mine.reduce((a, r) => Math.max(a, r.score), 0), total: mine.reduce((a, r) => a + r.score, 0) };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return { members, daily, allTime };
  },

  // streak / played / average / best from a player's daily history
  async stats(playerId, today) {
    const hist = await backend.dailyHistory(playerId);
    const dates = new Set(hist.map(h => h.date));
    let streak = 0;
    const cur = new Date(today + 'T12:00:00Z');
    if (!dates.has(today)) cur.setUTCDate(cur.getUTCDate() - 1); // streak is still alive until today ends
    while (dates.has(cur.toISOString().slice(0, 10))) { streak++; cur.setUTCDate(cur.getUTCDate() - 1); }
    const scores = hist.map(h => h.score);
    return {
      streak, played: hist.length,
      avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      best: scores.length ? Math.max(...scores) : 0,
      playedToday: dates.has(today),
      freeDives: await backend.freeDiveCount(playerId),
    };
  },
};
