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
    .replace(/^(the|a|an) /, '')
    .trim();
}

// Compact form used for comparison: no spaces, so "new zealand" == "newzealand"
function compact(s) {
  return normalize(s).replace(/ /g, '');
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
  if (len <= 8) return 1;
  return 2;
}

// Build a lookup index for a prompt's answers.
// answers: [{ name, aliases: [], tier }]
function buildIndex(answers) {
  const keys = []; // { key, answer }
  const exact = new Map();
  for (const ans of answers) {
    for (const form of [ans.name, ...(ans.aliases || [])]) {
      const key = compact(form);
      if (!key) continue;
      keys.push({ key, answer: ans });
      if (!exact.has(key)) exact.set(key, ans);
    }
  }
  return { keys, exact };
}

// Returns { answer, exact } or null. exact = typed form matches a name or alias exactly.
function matchDetail(index, guess) {
  const g = compact(guess);
  if (!g) return null;
  if (index.exact.has(g)) return { answer: index.exact.get(g), exact: true };
  let best = null, bestD = Infinity;
  for (const { key, answer } of index.keys) {
    const tol = tolerance(Math.min(key.length, g.length));
    if (tol === 0) continue;
    const d = distance(g, key, tol);
    if (d <= tol && (d < bestD || (d === bestD && answer.tier < best.tier))) {
      best = answer; bestD = d;
    }
  }
  return best ? { answer: best, exact: false } : null;
}

function match(index, guess) { return matchDetail(index, guess)?.answer || null; }

module.exports = { normalize, compact, distance, buildIndex, match, matchDetail };
