// Answer normalisation and fuzzy matching.

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ')
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

// Compact form used for comparison: no spaces, so "new zealand" == "newzealand"
function compact(s) {
  return normalize(s).replace(/ /g, '');
}

// Classic Soundex: catches phonetic misspellings ("riggotoni" -> "rigatoni")
function soundex(s) {
  const c = compact(s);
  if (!c || !/[a-z]/.test(c[0])) return '';
  const map = { b: 1, p: 1, f: 1, v: 1, c: 2, s: 2, k: 2, g: 2, j: 2, q: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };
  let out = c[0], prev = map[c[0]] || 0;
  for (let i = 1; i < c.length && out.length < 4; i++) {
    const ch = c[i];
    if (ch === 'h' || ch === 'w') continue;
    const d = map[ch] || 0;
    if (!d) { prev = 0; continue; }
    if (d !== prev) out += d;
    prev = d;
  }
  return (out + '000').slice(0, 4);
}

// Words players naturally append/prepend to answers ("Mississippi River", "Pineal gland").
const CAT_WORDS = new Set([
  'river', 'lake', 'loch', 'mount', 'mountain', 'mt', 'sea', 'ocean', 'island', 'isle', 'isles',
  'city', 'town', 'county', 'state', 'park', 'forest', 'desert', 'canal', 'channel', 'strait',
  'bay', 'gulf', 'cape', 'valley', 'falls', 'waterfall', 'volcano', 'peninsula', 'reef', 'range',
  'peak', 'rio', 'port', 'creek', 'springs', 'canyon', 'glacier', 'delta', 'fjord', 'bridge',
  'castle', 'cathedral', 'stadium', 'gland', 'bone', 'muscle', 'nerve', 'artery', 'vein', 'organ',
  'process', 'shark', 'whale', 'dolphin', 'fish', 'cat', 'dog', 'deer', 'bear', 'bird', 'snake',
  'frog', 'toad', 'spider', 'turtle', 'tortoise', 'crab', 'ray', 'eel', 'trout', 'salmon', 'hawk',
  'eagle', 'owl', 'duck', 'goose', 'swan', 'beetle', 'moth', 'butterfly', 'ant', 'bee', 'wasp',
  'squid', 'octopus', 'jellyfish', 'starfish', 'urchin', 'shrimp', 'lobster', 'oyster', 'clam',
  'mussel', 'scallop', 'lizard', 'gecko', 'iguana', 'python', 'cobra', 'viper', 'gazelle',
  'antelope', 'buffalo', 'bison', 'moose', 'elk', 'caribou', 'reindeer', 'goat', 'sheep', 'pig',
  'boar', 'donkey', 'mule', 'pony', 'horse', 'stallion', 'mare', 'wolf', 'fox', 'rat', 'mouse',
  'rabbit', 'hare', 'squirrel', 'monkey', 'ape', 'lemur', 'panda', 'koala', 'tree', 'oak', 'pine',
  'flower', 'rose', 'lily', 'fern', 'moss', 'grass', 'bush', 'shrub', 'vine', 'fungus', 'mushroom',
  'revolution', 'war', 'battle', 'siege', 'treaty', 'dynasty', 'emperor', 'king', 'queen',
  'pharaoh', 'saint', 'pope', 'bishop', 'cardinal', 'duke', 'earl', 'baron', 'count', 'prince',
  'princess', 'sir', 'lord', 'lady', 'captain', 'admiral', 'general', 'president', 'minister',
  'film', 'movie', 'show', 'series', 'season', 'episode', 'album', 'song', 'band', 'novel',
  'book', 'play', 'poem', 'opera', 'ballet', 'musical', 'game', 'sport', 'team', 'club',
]);
// Results of stripping that are too generic to become keys ("red" from "red deer")
const STRIP_STOP = new Set([
  'great', 'lesser', 'little', 'big', 'old', 'new', 'common', 'giant', 'dwarf', 'pygmy', 'false',
  'true', 'northern', 'southern', 'eastern', 'western', 'central', 'american', 'european',
  'african', 'asian', 'british', 'english', 'wild', 'domestic', 'red', 'black', 'white', 'blue',
  'green', 'grey', 'gray', 'brown', 'yellow', 'golden', 'spotted', 'striped', 'long', 'short',
  'royal', 'grand', 'high', 'low', 'upper', 'lower', 'inner', 'outer', 'civil', 'first', 'second',
  'third', 'french', 'english', 'spanish', 'russian', 'chinese', 'indian', 'holy', 'sacred',
]);
// Forms of the guess with a leading/trailing category word removed.
function variants(guess) {
  const words = normalize(guess).split(' ').filter(Boolean);
  if (words.length < 2) return [];
  const out = [];
  if (CAT_WORDS.has(words[words.length - 1])) out.push(words.slice(0, -1).join(''));
  if (CAT_WORDS.has(words[0])) out.push(words.slice(1).join(''));
  return out.filter(v => v.length >= 3 && v !== compact(guess));
}

// Optimal string alignment distance (Levenshtein + adjacent transpositions)
function distance(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null, prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur; cur = new Array(lb + 1);
  }
  return prev[lb];
}

// How many typos we forgive, by length of the target
function tolerance(len) {
  if (len <= 4) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

// Build a lookup index for a prompt's answers.
// answers: [{ name, aliases: [], tier }]
// Words that are never a person's surname / a usable last-word key
const NON_SURNAME = new Set([
  'city', 'town', 'island', 'isle', 'river', 'sea', 'lake', 'mount', 'mountain', 'war',
  'revolution', 'battle', 'cup', 'show', 'series', 'club', 'park', 'street', 'bridge',
  'castle', 'palace', 'church', 'school', 'army', 'navy', 'force', 'empire', 'kingdom',
  'republic', 'state', 'county', 'north', 'south', 'east', 'west', 'united', 'brothers',
  'sisters', 'boys', 'girls', 'band', 'company', 'crew', 'gang', 'squad', 'team',
]);
function buildIndex(answers) {
  const keys = []; // { key, answer }
  const exact = new Map();
  const phon = new Map(); // soundex -> [{ key, answer }]
  const addKey = (key, answer, exactKey) => {
    keys.push({ key, answer });
    if (exactKey && !exact.has(key)) exact.set(key, answer);
    const sx = soundex(key);
    if (sx) {
      if (!phon.has(sx)) phon.set(sx, []);
      phon.get(sx).push({ key, answer });
    }
  };
  for (const ans of answers) {
    for (const form of [ans.name, ...(ans.aliases || [])]) addKey(compact(form), ans, true);
  }
  // Surname keys: "Stokes" should find "Ben Stokes". Only when the surname is unique
  // within this prompt — with two Bushes listed, "bush" stays ambiguous and rejected.
  const byLast = new Map(); // lastWord -> answer|null (null = claimed by >1 answer)
  for (const ans of answers) {
    const words = normalize(ans.name).split(' ').filter(Boolean);
    if (words.length < 2) continue;
    const last = words[words.length - 1];
    if (last.length < 4 || NON_SURNAME.has(last)) continue;
    if (exact.has(last)) continue;
    if (byLast.get(last) === undefined) byLast.set(last, ans);
    else if (byLast.get(last) !== ans) byLast.set(last, null);
  }
  for (const [last, ans] of byLast) {
    if (ans) addKey(last, ans, true);
  }
  // Answer-side category stripping: "Pineal gland" -> "pineal", "Multnomah Falls" ->
  // "multnomah", "Epaulette shark" -> "epaulette". Same uniqueness rule — a stripped
  // form claimed by two different answers stays out.
  const byVar = new Map();
  for (const ans of answers) {
    const words = normalize(ans.name).split(' ').filter(Boolean);
    if (words.length < 2) continue;
    for (const pos of [0, words.length - 1]) {
      if (!CAT_WORDS.has(words[pos])) continue;
      const v = words.filter((_, i) => i !== pos).join('');
      if (v.length < 4 || STRIP_STOP.has(v) || exact.has(v)) continue;
      if (byVar.get(v) === undefined) byVar.set(v, ans);
      else if (byVar.get(v) !== ans) byVar.set(v, null);
    }
  }
  for (const [v, ans] of byVar) {
    if (ans) addKey(v, ans, true);
  }
  return { keys, exact, phon };
}

function fuzzyBest(keys, g) {
  let best = null, bestD = Infinity;
  for (const { key, answer } of keys) {
    const tol = tolerance(Math.min(key.length, g.length));
    if (tol === 0) continue;
    const d = distance(g, key, tol);
    if (d <= tol && (d < bestD || (d === bestD && answer.tier < best.tier))) {
      best = answer; bestD = d;
    }
  }
  return best;
}

// Returns { answer, exact } or null. exact = typed form matches a name or alias exactly.
function matchDetail(index, guess) {
  const g = compact(guess);
  if (!g) return null;
  if (index.exact.has(g)) return { answer: index.exact.get(g), exact: true };
  let best = fuzzyBest(index.keys, g);
  if (best) return { answer: best, exact: false };
  // "Mississippi River" -> try "mississippi"; "Lake Windermere" -> "windermere"
  for (const v of variants(guess)) {
    if (index.exact.has(v)) return { answer: index.exact.get(v), exact: false };
    best = fuzzyBest(index.keys, v);
    if (best) return { answer: best, exact: false };
  }
  // Phonetic fallback: guess sounds like a listed answer, but only accept when the
  // spelling is plausibly close too — a bare soundex hit would map "stag" to "sitka"
  const cands = g.length >= 5 ? index.phon.get(soundex(g)) : null;
  if (cands) {
    let bestD = Infinity;
    for (const c of cands) {
      const d = distance(g, c.key, 2);
      if (d <= 2 && (d < bestD || (d === bestD && c.answer.tier < best.tier))) { best = c.answer; bestD = d; }
    }
    if (best) return { answer: best, exact: false };
  }
  return null;
}

function match(index, guess) { return matchDetail(index, guess)?.answer || null; }

module.exports = { normalize, compact, distance, buildIndex, match, matchDetail };
