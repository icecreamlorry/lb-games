# ATOMYX — periodic table guessing game: implementation plan

**Status: v1 implemented.**
Handoff spec — any agent (or human) can pick the work up from here. ATOMYX is the third
sibling in the Atlaz/Flagz family: same shared rooms/account layer, same two-stage
prestart, same race-everyone-simultaneously multiplayer, same end-of-game answer review
via player cards, same difficulty dimension as Flagz. What differs is the material — the
**periodic table itself is the map**. Its fixed 18-column grid is a gift: spatial modes
(Pinpoint, Build, Sweep) drop straight onto it with none of Atlaz's projection machinery.

## 1. What the game is

Pick a **set** (a slice of the table), a **mode** and a **difficulty**, then race up to
**5 players** in a room (1-player room = solo; no separate solo mode). Everyone gets the
same seeded questions.

### Sets (the region analog — a mix of exact chemical families and curated learning tiers)

Defined in `tools/build-data.mjs` (SETS). The family sets are the *exact* column
partition of the table (the 12-way split sums to 118); the curated sets are what a
beginner actually meets first.

| id | label | contents | count |
|----|-------|----------|-------|
| `all` | Whole Table | everything | 118 |
| `first20` | The First 20 | H → Ca, the set every curriculum starts with | 20 |
| `everyday` | Everyday 30 | curated well-known elements (H He C N O F Ne Na Mg Al Si P S Cl K Ca Ti Fe Ni Cu Zn Ag Sn I W Pt Au Hg Pb U) | 30 |
| `alkline` | Alkali & Alkaline | groups 1+2 without H (Li Na K Rb Cs Fr · Be Mg Ca Sr Ba Ra) | 12 |
| `salts` | Halogens & Nobles | group 17 + group 18 | 13 |
| `transition` | Transition Metals | 21–30, 39–48, 72–80, 104–112 (d-block incl. group 12; La/Ac live in the f-block rows) | 38 |
| `pblock` | Groups 13 to 16 | boron/carbon/pnictogen/chalcogen columns | 24 |
| `lanthanides` | Lanthanides | 57–71 | 15 |
| `actinides` | Actinides | 89–103 | 15 |

The full 12-family partition (each element's `fam`, stored for future modes/colouring):
hydrogen 1 · alkali 6 · alkaline 6 · transition 38 · lanthanide 15 · actinide 15 ·
boron 6 · carbon 6 · pnictogen 6 · chalcogen 6 · halogen 6 · noble 7 = **118**.

When a set is played, the WHOLE table is always drawn — set cells bright and tappable,
everything else dimmed context (`ctx`), so the spatial learning keeps its anchor.

### Modes (all playable solo or vs. others; same seeded rounds for every seat)

1. **PINPOINT** — an element *name* is shown; tap its cell on the table (symbols
   visible). Tap selects + shows CONFIRM (cells are small on phones — same deliberate
   two-step as Atlaz). Correct: cell fills green; wrong: your pick flashes, the correct
   cell fills red. Graded cells persist, so the table fills up as you go. 10 rounds.
2. **LINE-UP** — one big element tile (symbol + number + mass) is shown; pick its name
   from N options. 10 rounds.
3. **NAMEDROP** — same big tile; type the element's name (forgiving matching + alias
   table: sulphur, aluminum, cesium, wolfram, quicksilver…). 10 rounds.
4. **MASS** — N element cards (symbol + name shown, mass hidden); drag into atomic-mass
   order, lightest at the top, then confirm to reveal the masses. 5 rounds (1 round of
   everything on ALL). Deliberately surfaces the famous inversions (Ar > K, Co > Ni,
   Te > I).
5. **SWEEP** — a blank table and a text box: type every element in the set from memory —
   **names or symbols both count**. Each hit fills its cell. GIVE UP ends the run.
   Completers rank by time, quitters below them by count-then-time (the Flagz/Atlaz
   compareResults rule handles this for free: completers have max score).
6. **BUILD** — the set's cells are drawn *blank*; each round names one element
   (name + symbol shown), tap where it lives. The table fills progressively — the
   jigsaw analog, cheaper than Atlaz's because every element has exactly one cell.
   10 rounds.

### Difficulty (Flagz's dimension, same ids)

EASY 3 · MEDIUM 6 · HARD 9 · ALL — number of name options (LINE-UP) / cards per sorting
round (MASS). Ignored by the other modes (same as Flagz NAMEDROP ignoring it).

### Scoring / results

Identical to Flagz: pick/table modes +1 per correct; MASS +1 per card in the correct
slot with equal values interchangeable; rank = score desc, time asc; winner/tie via
`engine.winnerSeat`. `finishRoom` result stores set/mode/diff for Game History.

Outcome shapes (what the card-tap review renders):
- pinpoint / lineup / namedrop / build: `[{ id, pick, ok }]` per round;
- mass: `[{ ids: [player's order], ok: [bool per slot] }]` per round;
- sweep: `{ found: [ids in the order typed], gaveUp }` (review lists the whole set,
  found = green, missed = red **with the name shown** — that's the learning moment).

### Future modes (data already stored; cheap follow-ups)

- **MELTDOWN** (order by `melt`), **PULL** (order by `en`) — clones of MASS.
- **STATE** (solid/liquid/gas classify — `phase`; only Hg + Br liquid, 11 gases),
  **FAMILY** (which family? — `fam`), **METAL?** — a classify-mode family.
- **DISCOVERY** (order by year) needs a year-discovered source merged into the builder.

## 2. Data (checked in; no runtime fetching beyond the game's own files)

`tools/build-data.mjs` (plain node, no deps) generates `data/elements.json`:

- Source: **Bowserinator/Periodic-Table-JSON** (CC-BY-SA), fetched from
  raw.githubusercontent.com into the gitignored `tools/cache/`.
- Per element (keyed by lowercase symbol): `{ name, sym, num, mass, x, y, fam, cat,
  phase, melt?, en?, alt? }`.
  - `x`/`y` — grid position, **computed from the atomic number alone** (deterministic,
    no dataset quirks): 18 columns; rows 1–7 the main table; row 8 is a spacer; rows
    9/10 the lanthanide/actinide shelf at columns 3–17. Faint 57–71 / 89–103 marker
    cells sit in the main-table group-3 gaps.
  - `phase` is `s`/`l`/`g`, forced to `?` for elements ≥ 100 (never observed in bulk —
    the dataset's *predicted* phases, like liquid copernicium, shouldn't be taught as
    fact).
  - Spellings follow IUPAC (Aluminium, Caesium, Sulfur) with the other spelling as an
    alias; extra aliases for the classics (wolfram, quicksilver, natrium, kalium…).

## 3. Code layout (mirrors Flagz; copy-don't-reinvent applies)

```
atomyx/
  index.html         ← Flagz skeleton: landing/lobby mounts, two-stage prestart overlay
                       (SET + MODE + DIFFICULTY), countdown, results, help modal
  js/config.js       ← GAME_SLUG 'atomyx'
  js/net.js          ← createNet wrapper (verbatim pattern)
  js/notify.js, sw.js, manifest.webmanifest, icons/
  js/engine.js       ← PURE: seeded buildRounds (pick + order + sweep), orderKey/
                       expectedOrder/gradeOrder, normalize/aliases, ranking
  js/data.js         ← elements.json loader, set helpers, fmtMass
  js/table.js        ← the periodic-table grid component (CSS grid, container-query
                       sized, cell mark/reveal API used by every spatial mode)
  js/modes.js        ← tableMode (pinpoint/build) + tileMode (lineup/namedrop) +
                       orderMode (mass) + sweepMode + renderReview
  js/main.js         ← rooms/prestart/countdown/results glue — Flagz main.js adapted
  css/style.css      ← Flagz base + pt-grid / el-cell / big-el / order tiles
  data/elements.json ← generated (§2)
  test/engine.test.mjs
  tools/build-data.mjs
```

Multiplayer protocol identical to Atlaz/Flagz: host `start` move (index 0) carries
`{ set, mode, diff, startAt }`; per-seat sparse `result` move (index 10+seat) carries
`{ outcomes, score, total, ms }`.

## 4. Known judgement calls & phone lessons carried over

- **Scroll fixes from Flagz are load-bearing**: order rows keep the 56px right-hand
  scroll gutter + `touch-action: none` while draggable, and graded (`.good`/`.wrong`)
  rows go back to full width + `touch-action: auto` so grabbing them scrolls the page.
  Don't regress this.
- The table never truncates: symbols are 1–3 chars by nature; names appear in the
  prompt/status/review rows which wrap, never ellipsize (the Flagz rule).
- MASS shows the element names while dragging (the quiz is knowing masses, not
  identifying blind tiles — unlike Flagz A-TO-Z where hiding names IS the quiz).
- SWEEP accepts symbols as well as names on purpose: symbol recall is legitimate
  element knowledge, and rapid-firing `h he li be b…` is the fun of the mode.
- Element ids are lowercase symbols (`h`, `he`, …) — stable, readable, and unique.
- Confirm-step on table taps (Atlaz pattern) because 18 columns on a 360px phone means
  ~19px cells; a mis-tap must never grade.
