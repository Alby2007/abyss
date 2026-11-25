# Writing prompt packs

Every `.txt` file in this folder is a pack. The server reads them on start (or when you hit `POST /api/admin/reload`).

```
# pack: Geography            <- display name for the pack (optional)
# anything else starting with a single # is a comment

## countries | Name a country      <- "## id | prompt text". Ids must be unique across all packs.
hint: UN members plus a few extras  <- optional, shown under the prompt
gem: Tuvalu                        <- optional, the curated "Leviathan" answer (120 pts)
fact: Tuvalu earns money from .tv   <- optional, a fun fact shown when someone finds the gem
daily: no                          <- optional, keep this prompt out of the Daily Dive
1: France, Germany, United States / USA / US / America
2: Portugal, Greece
3: Slovenia
4: Moldova
5: Nauru
```

Tiers, from most obvious to most obscure:

| Line | Tier      | Points |
|------|-----------|--------|
| 1    | Surface   | 10     |
| 2    | Shallows  | 25     |
| 3    | Twilight  | 50     |
| 4    | Midnight  | 75     |
| 5    | Abyss     | 100    |
| gem  | Leviathan | 120    |

- Entries are comma separated. Use `/` for aliases: `United Kingdom / UK / Britain / Great Britain`.
- If a name has a comma in it, wrap it in brackets: `[Paris, Texas]`.
- Matching ignores case, accents, punctuation, spaces and a leading "the", and forgives 1 typo on 5-letter answers, 2 up to 9 letters and 3 on longer ones (counting letters with spaces removed). Short answers (4 letters or fewer) must be exact, so add short aliases deliberately.
- You can repeat a tier number on several lines; they just add up.
- Answers the host accepts in Mine Party, or that you accept through the admin API, are saved in the database and merged in automatically.

## The daily schedule: daily.txt

`daily.txt` in this folder is not a pack — it's the daily dive schedule. One prompt id per line, in the order they run. Each day serves the next 7 ids; when the list runs out it loops from the top. Everyone gets the same 7 on the same date.

- `#` lines are comments, blank lines are ignored.
- Unknown ids and prompts marked `daily: no` are skipped with a startup warning.
- Missing or shorter than 14 entries: the daily falls back to a seeded shuffle of every daily-eligible prompt.
- Edit after midnight, not mid-day, or late divers can see a different set than early ones.
- Nothing enters the daily unless it's in this file, so niche packs you add never dilute it — they're still in free dives and Mine Party.
