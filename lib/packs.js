// Loads prompt packs from /packs/*.txt (see packs/README.md for the format)
const fs = require('fs');
const path = require('path');
const { buildIndex, compact } = require('./match');

const PACK_DIR = path.join(__dirname, '..', 'packs');

// Tier 1 is the most obvious, 5 the most obscure. The gem gets a bonus tier.
const TIERS = [
  null,
  { id: 1, name: 'Surface', points: 10 },
  { id: 2, name: 'Shallows', points: 25 },
  { id: 3, name: 'Twilight', points: 50 },
  { id: 4, name: 'Midnight', points: 75 },
  { id: 5, name: 'Abyss', points: 100 },
  { id: 6, name: 'Leviathan', points: 120 }, // the curated gem answer
];

function splitEntries(line) {
  // comma separated, but commas inside [...] are ignored
  const out = []; let depth = 0, cur = '';
  for (const ch of line) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function parseEntry(raw, tier) {
  // "United States / USA / America"  -> name + aliases
  const parts = raw.split('/').map(s => s.replace(/[\[\]]/g, '').trim()).filter(Boolean);
  return { name: parts[0], aliases: parts.slice(1), tier };
}

function parsePack(text, file) {
  const pack = { id: path.basename(file, '.txt'), name: path.basename(file, '.txt'), prompts: [] };
  let cur = null;
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('## ')) {
      const [id, ...rest] = line.slice(3).split('|');
      cur = { id: id.trim(), text: rest.join('|').trim(), answers: [], gem: null, pack: pack.id, daily: true };
      pack.prompts.push(cur);
      continue;
    }
    if (line.startsWith('#')) {
      const m = line.match(/^#\s*pack:\s*(.+)$/i);
      if (m) pack.name = m[1].trim();
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(/^gem:\s*(.+)$/i))) { cur.gem = m[1].trim(); continue; }
    if ((m = line.match(/^hint:\s*(.+)$/i))) { cur.hint = m[1].trim(); continue; }
    if ((m = line.match(/^fact:\s*(.+)$/i))) { cur.fact = m[1].trim(); continue; }
    if ((m = line.match(/^daily:\s*(no|false|0)$/i))) { cur.daily = false; continue; }
    if ((m = line.match(/^([1-5]):\s*(.*)$/))) {
      const tier = Number(m[1]);
      for (const e of splitEntries(m[2])) cur.answers.push(parseEntry(e, tier));
    }
  }
  return pack;
}

let state = { packs: [], prompts: new Map() };

// answers accepted by the host/admin, stored in the database: { promptId: [{ name, tier }] }
let extra = {};
function setAdditions(rows) {
  extra = {};
  for (const r of rows) (extra[r.prompt_id] ||= []).push({ name: r.name, tier: r.tier });
}
function readAdditions() { return extra; }

function finalize(prompt, additions) {
  // collapse repeated names: keep the lowest tier, merge aliases
  const byKey = new Map();
  for (const a of prompt.answers) {
    const k = compact(a.name);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, a); continue; }
    prev.tier = Math.min(prev.tier, a.tier);
    prev.aliases = [...new Set([...prev.aliases, ...a.aliases])];
  }
  prompt.answers = [...byKey.values()];
  const extra = additions[prompt.id] || [];
  const seen = new Set(prompt.answers.map(a => compact(a.name)));
  for (const a of extra) {
    if (!seen.has(compact(a.name))) { prompt.answers.push({ name: a.name, aliases: a.aliases || [], tier: a.tier || 3, added: true }); seen.add(compact(a.name)); }
  }
  if (prompt.gem) {
    const g = prompt.answers.find(a => compact(a.name) === compact(prompt.gem));
    if (g) g.tier = 6; else prompt.answers.push({ name: prompt.gem, aliases: [], tier: 6 });
  }
  prompt.index = buildIndex(prompt.answers);
}

function load() {
  const additions = readAdditions();
  const packs = [];
  const prompts = new Map();
  for (const f of fs.readdirSync(PACK_DIR).filter(f => f.endsWith('.txt')).sort()) {
    const pack = parsePack(fs.readFileSync(path.join(PACK_DIR, f), 'utf8'), f);
    for (const p of pack.prompts) {
      if (prompts.has(p.id)) console.warn(`[packs] duplicate prompt id "${p.id}" in ${f}`);
      finalize(p, additions);
      prompts.set(p.id, p);
    }
    packs.push(pack);
  }
  state = { packs, prompts };
  console.log(`[packs] loaded ${packs.length} packs, ${prompts.size} prompts`);
  return state;
}

// in-memory only; the caller persists it with db.addAddition
function addAnswer(promptId, name, tier = 3) {
  (extra[promptId] ||= []).push({ name, tier });
  const p = state.prompts.get(promptId);
  if (p) finalize(p, { [promptId]: [{ name, tier }] });
}

// ---- deterministic daily selection ----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function todayKey(tz = process.env.TZ_DAILY || 'Europe/London') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const PER_DIVE = 7;
// Walk through a fixed shuffle of the pool so no prompt repeats until the whole pool is used.
function dailyPrompts(dateKey) {
  const pool = [...state.prompts.values()].filter(p => p.daily).sort((a, b) => a.id.localeCompare(b.id));
  if (!pool.length) return [];
  const day = Math.floor(Date.parse(dateKey + 'T00:00:00Z') / 86400000);
  const per = Math.min(PER_DIVE, pool.length);
  const cycleLen = Math.floor(pool.length / per) || 1;
  const cycle = Math.floor(day / cycleLen), slot = day % cycleLen;
  const order = shuffle(pool, mulberry32(cycle * 7919 + 17));
  return order.slice(slot * per, slot * per + per);
}

function addDays(key, d) {
  const t = new Date(key + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

// Free dives stay clear of yesterday's and the next week of Daily Dive prompts
const DAILY_LOOKBEHIND = 1, DAILY_LOOKAHEAD = 7;

// Random prompts, keeping today's Daily Dive prompts out so nothing gets spoiled.
// Order of preference: unseen, then seen lately (recentIds), then nearby dailies
// (yesterday and the coming week), which only come back when nothing else is left.
// With no pack chosen, each dive draws from as many different packs as it can.
function randomPrompts(n = PER_DIVE, packId = null, recentIds = null) {
  let pool = [...state.prompts.values()];
  if (packId) pool = pool.filter(p => p.pack === packId);
  const today = todayKey();
  const todays = new Set(dailyPrompts(today).map(p => p.id));
  const nearby = new Set();
  for (let d = -DAILY_LOOKBEHIND; d <= DAILY_LOOKAHEAD; d++) if (d) for (const p of dailyPrompts(addDays(today, d))) nearby.add(p.id);
  const recent = new Set(recentIds || []);
  const fresh = [], seen = [], held = [];
  for (const p of pool) if (!todays.has(p.id)) (nearby.has(p.id) ? held : recent.has(p.id) ? seen : fresh).push(p);
  const ordered = shuffle(fresh, Math.random).concat(shuffle(seen, Math.random), shuffle(held, Math.random));
  if (packId) return ordered.slice(0, n);
  const out = [], packsUsed = new Set();
  for (const p of ordered) if (out.length < n && !packsUsed.has(p.pack)) { out.push(p); packsUsed.add(p.pack); }
  for (const p of ordered) if (out.length < n && !out.includes(p)) out.push(p);
  return out;
}

function getPrompt(id) { return state.prompts.get(id); }
function listPacks() { return state.packs.map(p => ({ id: p.id, name: p.name, count: p.prompts.length })); }

module.exports = { TIERS, load, setAdditions, addAnswer, dailyPrompts, randomPrompts, getPrompt, listPacks, todayKey, PER_DIVE };
