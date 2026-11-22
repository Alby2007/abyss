# abyss.

A private rare-answer trivia game for you and your mates, inspired by krillion.io. Name something valid that nobody else would think of and you sink deeper.

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm run dev          # same, restarts when you edit server files
```

On Windows you can just double-click `start-abyss.bat`.

Environment variables:

| Var | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ADMIN_KEY` | (unset) | Turns on `/admin` and the admin API. Pick anything long. |
| `ANSWER_SECONDS` | `25` | Seconds per prompt in dives |
| `TZ_DAILY` | `Europe/London` | Timezone the daily dive rolls over in |

## Modes

- **Today's dive**: seven prompts picked from the date, so everyone gets the same set. One go per name per day. Each prompt has a 3 second countdown, then 25 seconds on the clock. Wrong answers say "no echo" and let you try again, and typo corrections ask you to confirm. Your answer then sinks past the tier lines to its depth. The end screen shows how you compare with your friends today, a dive log, your logbook, and "The Catch", where you can browse every valid answer per round.
- **Free dive**: seven random prompts, optionally from one pack. Unlimited, not scored on the board.
- **Mine Party** (`/room/CODE`): real-time hot potato over websockets. Whoever holds the mine names a valid answer that hasn't been used this round to pass it on. The fuse is hidden and random (10 to 30 s by default). Passing keeps the remaining time but never gives the next person less than 8 s. Holding it when it goes off costs a life; last diver standing wins, points (by rarity) break ties. The host can overrule the list with one click, which also saves the answer for next time.

## Scoring

| Tier | Points | Depth |
|---|---|---|
| Surface | 10 | 100 m |
| Shallows | 25 | 250 m |
| Twilight | 50 | 500 m |
| Midnight | 75 | 750 m |
| Abyss | 100 | 1,000 m |
| Leviathan (the one curated gem per prompt) | 120 | 1,200 m |

Tiers and points live at the top of `lib/packs.js`.

## Adding prompts

Prompts are plain text files in `packs/`. See `packs/README.md` for the format. It's quick to write: one line per tier, answers comma separated, aliases with `/`.

When someone types an answer that isn't on the list it gets logged. Open `/admin` (with `ADMIN_KEY` set) to see the most common misses and accept them at whatever tier you like. Accepted answers land in `data/additions.json`, so the pack files stay clean. `POST /api/admin/reload` with `{ "key": "..." }` reloads packs without a restart.

## Hosting it for your friends

It's one Node process with a JSON file for storage, so anything that runs Node and keeps a disk works:

- **A spare PC / Pi on your network** plus a Cloudflare Tunnel or Tailscale Funnel to give it a public URL. Free and the data stays with you.
- **Fly.io / Railway / Render** using the included `Dockerfile`. Mount a volume at `/app/data`, otherwise the leaderboard resets on every deploy.

Websockets need to pass through whatever proxy you put in front (Cloudflare Tunnel and the platforms above all handle this).

## Layout

```
server.js          HTTP + REST API for dives, static files
lib/match.js       answer normalising + fuzzy matching (typo tolerance)
lib/packs.js       pack parser, tiers, daily selection, additions
lib/store.js       JSON-file store (results, answer counts, misses)
lib/party.js       Mine Party rooms over ws
public/            the client: index.html, style.css, app.js (routing, home, board, party),
                   dive.js (the dive and end screen), scene.js (the ocean canvas), creatures.js
packs/*.txt        the content
data/              created at runtime, gitignored
```

## Ideas for next iterations

- Score rarity off what your group actually answers: `store.counts` already tracks it, so tiers could blend the hand-set tier with "how many friends said this".
- LLM fallback validation for misses ("is X a valid answer to Y?") before marking them wrong.
- Friend groups/leagues, streaks, and an archive of past dailies.
- Swap the JSON store for SQLite once there's real history.
