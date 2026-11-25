# Agent notes for abyss

## Verify

- `npm test` — node:test runner, no extra deps. Pure-logic tests in `test/` (match, packs).
- Manual smoke: `PORT=3100 node server.js` then curl. **Warning**: tests that exercise dive answers hit the real Cloudflare AI judge and write real rows to Supabase when `.env` is present — prefer unit tests, or clean up afterwards.

## Constraints

- Node 22+ required (Supabase client).
- No build step, no framework — vanilla JS frontend in `public/`, CommonJS backend.
- Storage: Supabase when `.env` has the keys, else `data/db.json`. Apply all files in `supabase/migrations/` oldest-first for manual installs.
- Websocket (`ws`) usage must always attach an `error` handler — unhandled errors (e.g. maxPayload violations) crash the process.
- Rate limiting: use `auth.tooMany(key, limit, windowMs)` for new abuse-sensitive endpoints.
