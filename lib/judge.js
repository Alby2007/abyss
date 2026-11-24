// Optional AI judge: refused guesses get a second opinion from Cloudflare
// Workers AI (free tier). Returns null whenever it's off, over the daily cap,
// or can't be parsed — callers then keep their normal reject behaviour.
const { compact } = require('./match');

const MODEL = process.env.CF_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
const TIMEOUT_MS = 1800;
const DAILY_CAP = 300; // hard stop so a bug or flood can't burn the free quota
const MIN_LEN = 3;

const verdicts = new Map(); // promptId|guess -> verdict | null
let day = '', calls = 0;

function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Returns { valid, name, tier } or null.
//   name — the answer to credit: a listed answer copied exactly when the guess
//   means one, otherwise the canonical name of a correct-but-missing answer.
//   tier — only meaningful when name isn't one of the listed answers.
async function judge(prompt, guess) {
  const account = process.env.CF_ACCOUNT_ID, token = process.env.CF_AI_TOKEN;
  if (!account || !token) return null;
  const g = compact(guess);
  if (g.length < MIN_LEN) return null;
  const key = prompt.id + '|' + g;
  if (verdicts.has(key)) return verdicts.get(key);
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; calls = 0; }
  if (calls >= DAILY_CAP) return null;
  calls++;
  const messages = [
    { role: 'system', content: [
      'You judge guesses in a rare-answer trivia game. Decide if the guess correctly answers the question. Accept alternate names, spellings, abbreviations, translations and partial answers (like surnames) a reasonable quiz host would accept.',
      'Reply with ONLY this JSON object, no other text:',
      '{"valid":true,"name":"...","tier":1}',
      'name: if the guess means one of the listed answers, copy that listed answer exactly. If it is correct but missing from the list, write the proper name of the answer.',
      'tier: only when the answer is valid and missing from the list — how obscure is it: 1 = everyone knows it, 5 = almost nobody.',
    ].join('\n') },
    { role: 'user', content: `Question: ${prompt.text}${prompt.hint ? `\nHint: ${prompt.hint}` : ''}\nListed answers: ${prompt.answers.map(a => a.name).join('; ')}\nGuess: ${JSON.stringify(String(guess).slice(0, 80))}` },
  ];
  let verdict = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: 60, temperature: 0 }),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));
    const data = await res.json().catch(() => null);
    // chat-completions models return result.choices[0].message.content and may
    // already parse JSON into result.response; text-gen models return a string there
    const r = data?.result;
    const v = (r?.response && typeof r.response === 'object') ? r.response
      : extractJson(r?.choices?.[0]?.message?.content ?? r?.response);
    if (v && typeof v.valid === 'boolean') {
      verdict = {
        valid: v.valid,
        name: String(v.name || guess).slice(0, 80),
        tier: Math.min(5, Math.max(1, Math.round(Number(v.tier) || 3))),
      };
    }
  } catch {}
  if (verdicts.size > 4000) verdicts.clear();
  verdicts.set(key, verdict);
  return verdict;
}

module.exports = { judge };
