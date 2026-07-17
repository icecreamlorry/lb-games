# FLAGZ — flag guessing game: implementation plan

**Status: v1 implemented (see checklist §7).**
Handoff spec — any agent (or human) can pick the work up from here. FLAGZ is Atlaz's sibling:
same shared rooms/account layer, same two-stage prestart, same race-everyone-simultaneously
multiplayer, same end-of-game answer review via player cards. What differs is the material
(flags instead of map shapes), a **difficulty** dimension, and three **ordering** modes
powered by population/area data.

## 1. What the game is

Pick a **region**, a **mode** and a **difficulty**, then race up to **5 players** in a room
(1-player room = solo; no separate solo mode). Difficulty scales the challenge to fit each
mode via two knobs per tier (`{ n, q }`): `n` = flags/options juggled at once (EASY 3 ·
MEDIUM 6 · HARD 9 · ALL whole region) for Spotter/Line-up and the sorting modes; `q` = the
question count (EASY 5 · MEDIUM 10 · HARD 15 · ALL whole region) for **Namedrop**, the one
mode with nothing to juggle, so its difficulty scales the run length instead. Spotter/Line-up
keep a fixed 10 questions. The prestart spells out the concrete effect (`engine.roundsFor()`)
so the dial is never silently inert.

### Regions (countries only; ~25–35 each, plus the whole world)

Defined in `tools/build-data.mjs` (REGIONS). Atlaz's areas, split further to hit the size
target: Europe → West (22) / East (25), Africa → North (28) / South (26), the Americas
combined (35), Asia (30), Middle East (20), Oceania & Pacific (14), **Whole World (197)**.
Transcontinentals (TR, CY, EG…) appear in every region they border.

### Modes (all playable solo or vs. others; same seeded rounds for every seat)

1. **SPOTTER** — a country name + N flags; tap the right flag. 10 rounds.
2. **LINE-UP** — one flag + N country names; pick the right name. 10 rounds.
3. **NAMEDROP** — one flag; type the country (forgiving matching + aliases). Difficulty sets
   the number of questions: EASY 5 · MEDIUM 10 · HARD 15 · ALL the region.
4. **A TO Z** — N flags, names hidden; drag into alphabetical order, CONFIRM, then names +
   results reveal. 5 rounds (1 round of everything on ALL).
5. **HEADCOUNT** — same, but order by population (smallest at the top).
6. **LANDMASS** — same, but order by country area.

Ordering scoring: +1 per flag in the correct **slot**; equal values are interchangeable
(ties never punished). After confirm, wrong rows show the "#n" slot they belonged in plus
the country's population/area. Pick-mode scoring: +1 per correct answer. Ranking: score
desc, time asc; winner/tie via `engine.winnerSeat`.

## 2. Data (all checked in; no runtime fetching beyond the game's own files)

`tools/build-data.mjs` (node, needs `d3-geo`; `npm i` inside tools/) generates:

- `data/countries.json` — regions + per-country `{ name, alt, pop, area }`.
  - **Population**: Natural Earth `POP_EST` (50m admin0; reuses Atlaz's cached download).
  - **Area**: computed **geodesically** from NE geometry (`d3.geoArea` × R²) so islands and
    overseas parts count consistently. Spot-checked within ~1–2% of official figures.
  - NE traps handled: multiple features share one ISO code (Ashmore & Cartier is also
    `AU`) — keep the most populous; Somaliland/N. Cyprus folded into Somalia/Cyprus
    (ABSORB), matching the Atlaz maps.
- `data/flags/<cc>.svg` — 197 four-by-three flags from **flag-icons** (MIT), pulled as an
  npm tarball (registry.npmjs.org is reachable from the dev env; most of the web is not).
  ~1.3 MB total. Credit shown in the help modal.

The extra fields exist precisely so future games can lean on them (the user asked for
population + area to be stored for "additional games").

## 3. Code layout (mirrors Atlaz; copy-don't-reinvent applies)

```
flagz/
  index.html         ← Atlaz skeleton: landing/lobby mounts, two-stage prestart overlay
                       (+ third cfg group: DIFFICULTY), countdown, results, help modal
  js/config.js       ← GAME_SLUG 'flagz'
  js/net.js          ← createNet wrapper (verbatim pattern)
  js/notify.js, sw.js, manifest.webmanifest, icons/
  js/engine.js       ← PURE: seeded buildRounds (pick + order variants), orderKey/
                       expectedOrder/gradeOrder, normalize/aliases, ranking
  js/data.js         ← countries.json loader, flagUrl(), fmtBig()
  js/modes.js        ← pickMode (spotter/lineup/namedrop) + orderMode (drag-reorder list,
                       confirm→reveal→next) + renderReview (end-of-game answers)
  js/main.js         ← rooms/prestart/countdown/results glue — Atlaz's main.js adapted
                       (diff in cfgSel + start payload; review renders lists, not a map)
  css/style.css      ← Atlaz base + flag-grid / big-flag / order-list / review styles
  data/…             ← generated (§2)
  test/engine.test.mjs
  tools/build-data.mjs
```

Multiplayer protocol identical to Atlaz: host `start` move (index 0) carries
`{ region, mode, diff, startAt }`; per-seat sparse `result` move (index 10+seat) carries
`{ outcomes, score, total, ms }`; `finishRoom` result also stores region/mode/diff so Game
History (via `LB_CONFIG.historyDetail`) shows "Region · MODE · DIFF".

Outcome shapes (what the card-tap review renders):
- pick modes: `[{ id, pick, ok }]` per round;
- order modes: `[{ ids: [player's order], ok: [bool per slot] }]` per round.

## 4. Known judgement calls

- Taiwan is included (common quiz flag). Kosovo included. Western Sahara is not (disputed,
  no universally recognised flag entry in our source set — and it's scenery in Atlaz too).
- The drag-reorder list is pointer-based live DOM reordering (`touch-action: none` rows) —
  same feel as Splitz tile dragging; tested with Playwright mouse drags.
- `enterRoom` is re-entry-safe from day one (the Chromagrid loop lesson): same-room no-op,
  no await before the connection is assigned.

## 5. Verification

- `node flagz/test/engine.test.mjs` — 1,310 assertions: seeded round determinism/shape per
  mode+difficulty, ordering grades incl. ties, alias matching, ranking, and full data
  sanity (every country has name/pop/area/flag file; regions within size targets; known
  orderings like CN > DE population hold).
- Playwright smoke: all six modes played end-to-end at phone size (drag reorder included),
  results overlay + ranking verified, zero console errors.

## 7. Checklist

- [x] Data pipeline: flags (flag-icons MIT), pop (NE), area (geodesic), 9 regions + world
- [x] Engine + tests green
- [x] All six modes implemented + difficulty
- [x] Multiplayer glue (start payload, result moves, waiting/final results, card-tap review, rematch)
- [x] Help modal + credits
- [x] Landing page card (GAME 07 → FLAGZ, GAME 08 placeholder)
- [x] Playwright smoke of all modes
- [ ] Real-device pass (drag feel on Android, flag rendering, keyboard behaviour in NAMEDROP)

Future ideas parked: use pop/area data for more games (higher/lower duels, closest-guess),
capital cities dataset, flag "hard mode" using similar-flag distractor pools (LR/MY, RO/TD,
NL/LU…) instead of random ones.
