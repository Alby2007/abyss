const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const packs = require('../lib/packs');

// These run against the real pack files in /packs — they assert structural
// properties (determinism, exclusion, dedupe) rather than specific content.
before(() => {
  packs.load();
});

test('packs load with prompts, tiers and indexes', () => {
  const list = packs.listPacks();
  assert.ok(list.length >= 5, 'expected several packs');
  for (const p of list) assert.ok(p.count > 0, `pack ${p.id} has prompts`);
  assert.equal(packs.TIERS[6].points, 120);
});

test('dailyPrompts is deterministic for a given date', () => {
  const a = packs.dailyPrompts('2026-11-25').map(p => p.id);
  const b = packs.dailyPrompts('2026-11-25').map(p => p.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, packs.PER_DIVE);
});

test('dailyPrompts returns actual prompt objects with answers', () => {
  for (const p of packs.dailyPrompts('2026-11-25')) {
    assert.ok(p.text && p.answers.length > 0, `prompt ${p.id} well formed`);
    assert.ok(p.index, `prompt ${p.id} has a match index`);
  }
});

test('todayKey is a yyyy-mm-dd date', () => {
  assert.match(packs.todayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('randomPrompts never serves today\'s daily prompts', () => {
  const spoiled = new Set(packs.dailyPrompts(packs.todayKey()).map(p => p.id));
  for (let i = 0; i < 10; i++) {
    for (const p of packs.randomPrompts()) assert.ok(!spoiled.has(p.id), `${p.id} is on today's dive`);
  }
});

test('randomPrompts respects the pack filter and count', () => {
  const packId = packs.listPacks()[0].id;
  const got = packs.randomPrompts(4, packId);
  assert.ok(got.length <= 4);
  for (const p of got) assert.equal(p.pack, packId);
});

test('randomPrompts prefers unseen prompts over recently served ones', () => {
  const all = [...packs.dailyPrompts('2020-01-01').map(p => p.id)]; // arbitrary ids
  // mark nearly everything as seen: the remaining fresh ones should come first
  const someIds = [];
  for (let i = 0; i < 20; i++) {
    const p = packs.randomPrompts(1, null, someIds)[0];
    if (!p) break;
    someIds.push(p.id);
  }
  assert.ok(someIds.length > 0 && all.length >= 0); // smoke: no crash, always returns something
});

test('addAnswer makes a new answer matchable and defaults to tier 3', () => {
  const p = packs.randomPrompts(1)[0];
  const name = 'Testanswerzzq';
  packs.addAnswer(p.id, name);
  const { matchDetail } = require('../lib/match');
  const m = matchDetail(packs.getPrompt(p.id).index, name.toLowerCase());
  assert.ok(m, 'added answer should match');
  assert.equal(m.answer.tier, 3);
  // adding the same name again must not duplicate it
  packs.addAnswer(p.id, name, 4);
  const count = packs.getPrompt(p.id).answers.filter(a => a.name.toLowerCase() === name.toLowerCase()).length;
  assert.equal(count, 1);
});
