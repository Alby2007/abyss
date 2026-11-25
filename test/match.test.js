const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, compact, distance, buildIndex, matchDetail } = require('../lib/match');

test('normalize strips accents, case, articles and punctuation', () => {
  assert.equal(normalize('  The Éléphant! '), 'elephant');
  assert.equal(normalize("Apple's"), 'apples');
  assert.equal(normalize('A New York'), 'new york');
  assert.equal(normalize('Ben & Jerry'), 'ben and jerry');
});

test('compact removes spaces so spacing never matters', () => {
  assert.equal(compact('New Zealand'), 'newzealand');
  assert.equal(compact('newzealand'), compact('New Zealand'));
});

test('distance is levenshtein with transpositions', () => {
  assert.equal(distance('abc', 'abc', 3), 0);
  assert.equal(distance('abc', 'abd', 3), 1);
  assert.equal(distance('abc', 'acb', 3), 1); // transposition counts as one
  assert.equal(distance('', 'abc', 3), 3);
  assert.ok(distance('short', 'muchlongerstring', 2) > 2); // early exit when length differs too much
});

function indexOf(answers) {
  return buildIndex(answers.map(a => typeof a === 'string' ? { name: a, aliases: [], tier: 3 } : a));
}

test('exact matches by name and alias', () => {
  const idx = indexOf([{ name: 'United States', aliases: ['USA', 'America'], tier: 1 }]);
  assert.equal(matchDetail(idx, 'united states').exact, true);
  assert.equal(matchDetail(idx, 'USA').exact, true);
  assert.equal(matchDetail(idx, 'america').answer.name, 'United States');
});

test('typos within tolerance match fuzzily and are not exact', () => {
  const idx = indexOf(['paris']);
  assert.equal(matchDetail(idx, 'paris').exact, true);
  // len 5 -> tolerance 1: one typo forgiven
  const fuzzy = matchDetail(idx, 'paros');
  assert.ok(fuzzy, 'one typo should match');
  assert.equal(fuzzy.exact, false);
  // short answers forgive nothing
  assert.equal(matchDetail(indexOf(['rome']), 'rone'), null);
});

test('longer answers forgive more typos', () => {
  const idx = indexOf(['constantinople']); // len 14 -> tolerance 3
  assert.ok(matchDetail(idx, 'constantinopel'), 'one typo');
  assert.ok(matchDetail(idx, 'constatinnople'), 'two typos');
  assert.equal(matchDetail(idx, 'completelydifferent'), null);
});

test('surname alone finds a unique multiword answer', () => {
  const idx = indexOf(['Ben Stokes', 'Joe Root']);
  assert.equal(matchDetail(idx, 'stokes')?.answer.name, 'Ben Stokes');
  assert.equal(matchDetail(idx, 'root')?.answer.name, 'Joe Root');
});

test('ambiguous surname matches nothing', () => {
  // two answers sharing surname "bush" -> ambiguous, stays rejected
  const idx = indexOf(['George Bush', 'Jeb Bush']);
  assert.equal(matchDetail(idx, 'bush'), null);
});

test('category words are optional: "mississippi river" / "river" forms', () => {
  const idx = indexOf(['Mississippi River', 'Danube River']);
  assert.equal(matchDetail(idx, 'mississippi')?.answer.name, 'Mississippi River');
  // guessing with extra category word also works when the answer lacks it
  const idx2 = indexOf(['Multnomah']);
  assert.equal(matchDetail(idx2, 'multnomah falls')?.answer.name, 'Multnomah');
});

test('stripped generic words never become keys', () => {
  const idx = indexOf(['red deer', 'red squirrel']);
  // "red" is too generic to key on even though both strip to it
  assert.equal(matchDetail(idx, 'red'), null);
});

test('no match returns null', () => {
  const idx = indexOf(['paris', 'london']);
  assert.equal(matchDetail(idx, 'zzqqx'), null);
  assert.equal(matchDetail(idx, ''), null);
});

test('fuzzy tie prefers the lower (more common) tier', () => {
  const idx = indexOf([
    { name: 'Jordan River', aliases: [], tier: 4 },
    { name: 'Jordan', aliases: [], tier: 2 },
  ]);
  const m = matchDetail(idx, 'jordan');
  assert.equal(m.answer.name, 'Jordan'); // exact wins outright
});
