# BUFFZ — movies & TV trivia game: implementation plan

**Status: v1 implemented against SAMPLE data — see §2 for the one manual step
(running the TMDb grab) needed before real play.**
Handoff spec — any agent (or human) can pick the work up from here. BUFFZ is the fourth
sibling in the Atlaz/Flagz/Atomyx family: same shared rooms/account layer, two-stage
prestart, race-everyone-simultaneously multiplayer (up to 5), end-of-game review via
player cards, and the `{ n, q }` difficulty convention. What differs is the material
(movie/TV facts) and the **filter model**: there is no fixed "set" list — the host
narrows the pool with three dropdowns instead.

## 1. What the game is

Filter the pool of ~1,000 well-known movies & TV shows with three dropdowns —
**TYPE** (All / Movies / TV), **DECADE** (All / 1950s…2020s) and **GENRE** (All /
Action / Comedy / …) — pick a **mode** and a **difficulty**, then race. The prestart
shows a live "N titles in play" count as filters change; below **12** titles START is
disabled ("loosen the filters"). Every seat derives identical seeded questions, so the
filters ride in the host's start move: `{ f: { type, decade, genre }, mode, diff,
startAt }`.

### Modes

Pick modes show one question card + option buttons (everything is multiple-choice —
free-typing movie titles/actor names would make grading miserable); order modes reuse
the Flagz/Atomyx drag list (scroll fixes included).

1. **MIXED** — every round draws a random question category from the full bank below.
   The flagship mode ("mix and match the question types within a round").
2. **PLOTLINES** — taglines & one-line plots → pick the title. Plot text masks any
   occurrence of the title ("___") so it never gives itself away.
3. **CASTING** — people: who directed X / which film did Y direct / who stars in X /
   which film stars Y / who created X (TV). Cross-reference questions too: which of
   these films by/with a person came out first / most recently (distinct years, so the
   extremum is unambiguous), and which film directed by X *also* stars Y (options all
   share the director; only one shares the star) plus its reverse (options all share the
   star; only one shares the director). Reverse lookups exclude distractor titles that
   also feature the person.
4. **DETAILS** — release year, runtime, genre tags, studio/network, country (non-US
   titles only — "which country is Avengers from" is not a question), original title
   (foreign titles only), seasons (TV), highest-rated pick, biggest-box-office pick.
5. **TIMELINE** — drag titles into release-year order, oldest at the top (order mode;
   equal years interchangeable, the usual tie rule).
6. **RANKED** — drag titles into TMDb-rating order, lowest at the top. Chosen over a
   box-office sort because it works for TV too.

### Difficulty (`{ n, q }` convention; no ALL — meaningless over a 1,000 pool)

| tier | q (questions) | n (options / sort size) |
|------|---------------|-------------------------|
| EASY | 5 | 3 |
| MEDIUM | 10 | 4 |
| HARD | 15 | 6 |
| MARATHON | 25 | 8 |

Order modes: `n` titles per round, up to `ORDER_ROUNDS` (5) non-overlapping rounds.
The prestart spells out the effect via `engine.roundsFor()` ("10 questions · 4 options
each", "Sort 4 at a time · 5 rounds") — the dial is never silently inert.

### Scoring / results / review

Identical to the siblings: +1 per correct answer / per correct slot, ties
interchangeable in order modes; rank = score desc, time asc; winner via
`engine.winnerSeat`. Pick outcomes are stored as `[{ pick, ok }]` — tiny on the wire —
because **rounds are deterministic**: the review regenerates them from the room seed +
start config and shows each prompt, the correct answer and the player's pick. Order
outcomes are `[{ ids, ok }]` as usual. `finishRoom` result stores `f`/mode/diff for
Game History ("Movies · 1990s · Action · MIXED · HARD").

## 2. Data (checked in; the game never fetches at runtime)

`data/titles.json` — `{ credit, sample?, genres: [...], items: { id: {...} } }`, where
each item is:

```
{ t: 'm'|'v',            // movie | tv
  title, orig?,           // orig only when different (foreign titles)
  year, decade,           // decade = "1990s"
  runtime?,               // minutes (movies; TV = typical episode length)
  tagline?, plot?,        // plot is ONE sentence
  genres: [...],          // normalized names (TV "Sci-Fi & Fantasy" → Science Fiction/Fantasy…)
  cast: [up to 3],
  director? / creator?,
  studio?,                // production company / network
  country?,               // omit for US titles (only used for the country question)
  rating, votes,          // TMDb vote_average / vote_count
  revenue?,               // movies, when > 0
  seasons? }              // tv
```

Decades are bucketed by `decadeOf(year)`: "1930s".."2020s", with everything earlier
pooled into one **"Pre-1930"** silent-era bucket (individual pre-1930 decades don't
have enough well-known films to play; the pipeline pulls ~`PRE1930_QUOTA` of them
together). `decadeList()` only offers decades with `MIN_POOL`+ titles, so a thin
bucket never shows as an unplayable dropdown row.

The `sample` flag (when present) puts a "sample data" note in the prestart; the real
dataset built by the pipeline omits it. To (re)build:

1. Get a free TMDb API key (themoviedb.org → Settings → API — v3 key or v4 token).
2. On a machine with normal internet (api.themoviedb.org is blocked from the dev
   sandbox — verified, proxy 403):
   `TMDB_API_KEY=xxx node buffz/tools/build-data.mjs`
3. Commit the regenerated `buffz/data/titles.json`.

**Stratified pull (why the pipeline isn't one query).** A single `vote_count.desc`
pull is recency-biased — vote count tracks how many *current* TMDb users rated a
title — so old decades and niche genres starve (the first real pull had 1 film in the
1930s and 3 documentaries). Instead the builder runs a **separate `vote_count.desc`
query per decade and per genre**, takes the top ~QUOTA of each (`DECADE_QUOTA` 115,
`GENRE_QUOTA` 130), and unions them with a `GLOBAL_MOVIES` (600) popularity backbone.
The top-100-by-votes *within the 1970s* is that decade's best-known set even though
those films trail a modern blockbuster globally — so every decade and genre clears
~100 movies. TV stays a single 350 pull (the coverage ask was about movies). The
builder prints a per-decade / per-genre coverage table and flags any bucket that TMDb
can't fill to 100 (the 1930s genuinely doesn't have 100 films most people know).
Tunable trade-off: filling old/niche buckets pulls in less-famous titles, so the
unfiltered pool skews a little deeper — turn the QUOTA constants down to tighten it.

**Deepen existing directors (for the casting cross-reference questions).** The
"which film directed by X also stars Y" / "which of X's films came out first"
questions need 3+ films by one director in play. After the first details pass (which
yields each film's director + TMDb person-id), `collectDirectorFilms()` pulls the full
directing catalogue of every director already holding `DEEPEN_TRIGGER` (2) pool films
and folds in their other movies — but only ones clearing `DEEPEN_MIN_VOTES` (400) votes,
up to `DEEPEN_CAP` (8) films each. The vote floor is the obscurity gate: a famous
director's whole catalogue clears it (so almost all their well-known films come in),
while a one-hit director's deep cuts don't, so the pool isn't padded with unknowns. The
report prints a "deepened: +N films across M directors" line — dial the floor up (fewer,
more famous additions) or the trigger/cap around from there. This only deepens directors
already vetted by the stratified pull; it never introduces new people.

Then per title: one `append_to_response=credits` details call (~1,500 requests ≈ a
minute at TMDb's free ~50 req/s; the tier costs nothing, attribution required — shown
in the help modal). It normalizes TV genres, trims casts to 3, keeps overviews to
their first sentence, drops `country` for US titles and `orig` when it matches the
display title, and **drops titles with no quiz-worthy genre** (pure Reality/News/Talk
shows, or movies left with only "TV Movie").

**Title disambiguation.** Same-title remakes ("The Lion King" 1994 vs 2019, "The
Mummy" 1999 vs 2017) would produce duplicate option buttons and ambiguous prompts
("Who directed The Mummy?"). `disambiguate()` appends the year to every member of a
title collision → "The Lion King (1994)" / "The Lion King (2019)"; exact title+year
dups keep the higher-voted one. It needs only the year (already in the data), so it
also runs as a one-time fixer on existing data without re-fetching. `tools/
build-data.test.mjs` mock-tests the stratification + disambiguation logic (TMDb is
unreachable from the sandbox, so the pull itself can't be run here).

## 3. Code layout (mirrors Atomyx; copy-don't-reinvent applies)

```
buffz/
  index.html         ← family skeleton; prestart has 3 <select> filters + live count
  js/config.js       ← GAME_SLUG 'buffz'
  js/net.js, js/notify.js, sw.js, manifest.webmanifest, icons/
  js/engine.js       ← PURE: seeded question GENERATOR (13 categories, per-item
                       applicability, distractor construction), order grading,
                       DIFFS/roundsFor, ranking. The generator is the novel part —
                       see its header comment for the determinism contract.
  js/data.js         ← titles.json loader, filterIds(), decade/genre lists, fmt helpers
  js/modes.js        ← pickMode (question card + option buttons) + orderMode (drag
                       list — Flagz scroll fixes verbatim) + renderReview
  js/main.js         ← rooms/prestart/countdown/results glue (Atomyx main.js adapted:
                       cfgSel carries filters, not a set id)
  css/style.css      ← family base + question card + filter row styles
  data/titles.json   ← generated (§2) — currently the sample
  test/engine.test.mjs
  tools/build-data.mjs
```

## 4. Known judgement calls & phone lessons carried over

- **All-MCQ on purpose**: typing "Miss Congeniality 2: Armed and Fabulous" or grading
  "Leo DiCaprio" against "Leonardo DiCaprio" is misery; options keep grading exact and
  rounds fast with friends.
- **Determinism contract**: the generator must produce identical rounds for every seat
  from (data, filters, mode, diff, seed) — so it only uses the seeded RNG, iterates
  the pool in sorted-id order before shuffling, and never reads `Date`/`Math.random`.
- Question quality guards: rating/revenue picks require a clear margin between the
  answer and every distractor (no coin-flips); numeric distractors (year/runtime/
  seasons) are generated near the truth but never equal; a title never repeats within
  a game; reverse people-lookups exclude titles sharing the person.
- Order rows keep the 56px drag gutter + `touch-action: none` while draggable and go
  full-width + `touch-action: auto` once graded; option/question text wraps, never
  ellipsizes.
- Posters/trailers deliberately out (user call): no images, no copyright questions,
  nothing to hotlink.
- TMDb attribution in the help modal: "This product uses the TMDB API but is not
  endorsed or certified by TMDB."
