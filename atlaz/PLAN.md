# ATLAZ — map guessing game: implementation plan

**Status: v1 + first phone-feedback round implemented (see checklist §10).**
This document is the handoff spec: any agent (or human) should be able to pick up the work
from here. Update the checklist at the bottom as pieces land.

## 1. What the game is

ATLAZ (GAME 06) is a map-based country/state guessing game. You pick a **region**, then a
**game mode**, and race up to **5 players** in a room (a 1-player room IS solo play — there
is deliberately no separate solo mode). All modes are a simultaneous race over the *same*
seeded question order — nobody waits for turns. At the end everyone's attempts are
reviewable by tapping their player card at the top (exactly like Splitz's end-of-game board
spectating). Prestart is two-stage for the host: pick map+mode → NEXT → a READY card with
player count + share code + START, so starting is always a deliberate, separate tap.

Every region file also carries two non-playable layers: **ctx** (neighbouring land from
other regions, drawn dimmed and cropped by the frame — no Türkiye-shaped hole in Europe)
and **lakes** (Natural Earth 50m lakes ≥ ~0.18 deg², so the Great Lakes read as water).
Transcontinental countries are playable in BOTH of their regions: Türkiye (europe +
w-asia) and Egypt (africa + w-asia).

### Regions

Two groups, one picker (two tabs / sections):

**Countries** (source: Natural Earth 50m `admin_0_countries`, filtered by curated ISO lists):

| id | label | contents (ISO a2) |
|----|-------|-------------------|
| `africa` | Africa | DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW (54) |
| `europe` | Europe | AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA TR (47; Russia and Türkiye drawn but clipped at the frame edge, microstates get min-hit-area treatment) |
| `se-asia` | South East Asia | BN KH ID LA MY MM PH SG TH TL VN (11) |
| `w-asia` | Western Asia | AM AZ BH CY GE IL IQ IR JO KW LB OM PS QA SA SY TR AE YE EG (20; Iran included deliberately even though UN M49 calls it Southern Asia — the map reads wrong without it) |
| `oceania` | Australasia & Polynesia | AU NZ PG FJ SB VU WS TO KI FM MH PW NR TV (14; island micro-states rendered with a minimum marker size — see §4) |
| `c-america` | Central America | BZ CR SV GT HN NI PA (7) |
| `s-america` | South America | AR BO BR CL CO EC GY PY PE SR UY VE (12) |
| `n-america` | North America & Caribbean | CA US MX BS CU JM HT DO KN AG DM LC VC GD BB TT (16; Caribbean states included so the region isn't a 3-country map) |

**States & counties** (source: Natural Earth 10m `admin_1_states_provinces`):

| id | label | contents |
|----|-------|----------|
| `usa` | USA | 50 states + DC (51). Project with `geoAlbersUsa` (built-in AK/HI insets). |
| `england` | England | 47 ceremonial counties (dissolved from NE's ~150 LAD-level units via a hand-written mapping table; City of London folded into Greater London). |
| `scotland` | Scotland | 32 council areas (NE typos fixed; Eilean Siar shown as Outer Hebrides). |
| `wales` | Wales | 22 principal areas (Rhondda Cynon Taf renamed from NE's comma form). |
| `northern-ireland` | Northern Ireland | NE's 26 districts dissolved to the 6 traditional counties (approximate — modern district boundaries don't follow the counties exactly). |
| `ireland` | Ireland | 26 counties of the Republic. NE splits Dublin (4) and Cork (2) into sub-units — dissolve back to the traditional counties. NI appears as ctx land. (32-county island version = possible future upgrade.) |
| `canada` | Canada | 13 provinces & territories. |
| `brazil` | Brazil | 27 states (incl. DF). |
| `australia` | Australia | 6 states + NT + ACT (8; drop NE's Jervis Bay / external territories). |
| `japan` | Japan | 47 prefectures. |

### Game modes (each playable solo or vs. others)

1. **PINPOINT** — the name is shown; tap the right place on the map. Tapping outlines the
   candidate (name NOT revealed) + shows a CONFIRM button; you can re-tap to change. Correct:
   name label appears over it, fills green, +1. Wrong: your pick flashes, the *correct* one
   fills red with its name shown. Runs through the whole region (seeded shuffle); final score
   at the end.
2. **LINE-UP** — one territory is highlighted; pick its name from a list of all *remaining*
   names in the region (list shrinks as you go). Same green/red reveal + scoring as Pinpoint.
3. **NAMEDROP** — one territory is highlighted; type its name into a text box. Accent/case/
   punctuation-insensitive matching + alias table (§5). One guess per item: submit = graded.
4. **JIGSAW** — the region is drawn **borderless** (single silhouette). Each turn one piece
   (its shape + name) sits in a tray below; drag it onto the map. Drop within tolerance =
   snaps into place, green, +1; outside tolerance = snaps into place red. Placed pieces
   define the borders progressively. Tolerance is generous for phones (§4).
5. **SWEEP** — a text box and the clock. Type every name in the region from memory; each hit
   fills in + labels that territory. GIVE UP button ends the run. Scoreboard: everyone who
   finished 100% ranks by time (fastest first); everyone who gave up ranks below them by
   count-then-time.

### Scoring / results

- Modes 1–4: score = correct count, tiebreak = total elapsed ms (lower wins).
- Sweep: rank = (completed ? [0, ms] : [1, -found, ms]) lexicographic — completers always above quitters.
- `finishRoom(code, { scores, winner, reason })` like other games; winner `'tie'` when shared.
- End screen: ranked list + player cards stay tappable to load each player's attempt map
  (their green/red outcomes rendered on the map) — from their published `result` move.

## 2. Where the code lives, what to copy

New top-level dir `atlaz/`, structured like `splitz/` + `scramblr/` (these two are the
references — they already solved the UI problems; **copy, don't reinvent**):

```
atlaz/
  index.html            ← copy splitz/index.html skeleton (screens, help modal, script order)
  manifest.webmanifest  ← copy + rename (name ATLAZ, theme color)
  sw.js                 ← copy scramblr/sw.js (cache-first shell), bump cache name 'atlaz-v1'
  icons/                ← icon.svg (map-pin motif) + 192/512 PNGs + apple-touch (copy sizes)
  css/style.css         ← start from splitz style.css (players-strip, overlays, bars) + scramblr results css
  js/config.js          ← copy splitz/js/config.js, GAME_SLUG 'atlaz', GAME_NAME 'Atlaz'
  js/net.js             ← copy splitz/js/net.js verbatim (thin createNet wrapper)
  js/notify.js          ← copy splitz/js/notify.js (service worker + push)
  js/regions.js         ← region registry: [{id, label, kind:'countries'|'states', file, count}]
  js/engine.js          ← PURE logic, no DOM (testable): seeded shuffle (mulberry32), answer
                          normalization + aliases, jigsaw tolerance, sweep ranking, standings
  js/map.js             ← the SVG map component: render region JSON, pan/pinch-zoom, tap vs drag
                          discrimination, min-hit-area selection, labels, fill/outline states
  js/modes.js           ← the five mode controllers driving map.js + DOM panels
  js/main.js            ← screens/lobby/rooms/multiplayer glue — copy splitz/scramblr main.js flow
  data/maps/*.json      ← 15 generated region files (checked in; see §3)
  test/engine.test.mjs  ← node test, run like the other games (node test/engine.test.mjs)
  tools/build-maps.mjs  ← node build script that (re)generates data/maps (§3)
  tools/cache/          ← gitignored download cache
  PLAN.md               ← this file
```

**UI problems already solved elsewhere — reuse the exact patterns:**

- `<meta name="viewport" ... maximum-scale=1.0, user-scalable=no>` and `touch-action` handling
  (browser pinch-zoom must stay OFF; the map does its own pinch).
- Shared chrome injection order in index.html: `lobby-ui.js` then `account-ui.js` then game
  `main.js` then `devtools.js`; `window.LB_CONFIG = { gameSlug, gameName, history: true, defaultTheme }`.
- `#account-bar` + `#screen-lobby` mount points; `btn-go-lobby`, lobby buttons all wired by id
  (see splitz main.js — copy the landing/lobby/join/challenge/history handlers wholesale).
- `players-strip` / `.pchip` (dot + name + score) with `me` / `viewing` classes — Splitz.
- Prestart overlay-card in the play area (`WAITING FOR PLAYERS` / host-only START) — both games.
- Game-over overlay with ✕-to-look-around + REMATCH (shared `createRematch`) — Splitz.
- Header `.bar` with room-code chip (tap = copy) + leave icon button — Splitz.
- Status line `#status-line` for transient feedback; `esc()` helper for any interpolated names.
- `filterDismissed` / `makeDismissControl` on lobby cards; session resume via sessionStorage.
- Theme tokens only (`var(--cyan)` etc.) — no hard-coded colours; test all 3 themes.

## 3. Map data pipeline (the part that needed research)

**Network reality of the dev environment:** most of the web is blocked. Reachable:
`raw.githubusercontent.com` and `registry.npmjs.org` (direct). amCharts/simplemaps/Wikimedia/
jsdelivr/unpkg are NOT reachable. This dictated the source choice — and it's a good one anyway:

- **Source data: Natural Earth** (public domain, includes borders, ISO codes, English names):
  - `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson` (~3 MB)
  - `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson` (~40 MB — 10m is required: 50m admin1 lacks UK/Ireland/Japan)
- **Build deps from npm:** `d3-geo` (projections), `topojson-server` + `topojson-client`
  (topology + `merge` for dissolving without internal borders), `topojson-simplify`.

`tools/build-maps.mjs` (run: `node atlaz/tools/build-maps.mjs [regionId …]`, needs node 18+):

1. Download the two GeoJSONs into `tools/cache/` (skip if present).
2. Per region: filter features (ISO lists above; admin1 by `admin` property). Dissolves:
   - Britain: group England features by the LAD→ceremonial-county table (in the script),
     Wales/Scotland pass through; build a topology, `topojson.merge` each group (kills the
     internal borders properly), emit one MultiPolygon per county.
   - Ireland: same trick for the Dublin/Cork sub-units.
   - Europe: clip Russia at 60°E (or use a fitExtent that just crops it) so the map isn't 70% Siberia.
3. Project: `geoAlbersUsa` for `usa`; `geoConicConformal` fitted for `europe`/`canada`;
   `geoMercator().fitSize([1000, H], regionFC)` elsewhere. H chosen per region aspect.
4. Simplify (topojson presimplify/quantile) to keep each output ≲ ~120 KB.
5. Emit `data/maps/<id>.json`:

```json
{ "id": "europe", "label": "Europe", "kind": "countries",
  "w": 1000, "h": 820,
  "credit": "Map data: Natural Earth (public domain)",
  "items": [ { "id": "FR", "name": "France", "alt": ["french republic"],
               "d": "M…", "cx": 421.3, "cy": 396.8, "bbox": [x0,y0,x1,y1] } ] }
```

- `cx/cy` = visual label anchor: centroid of the **largest polygon** (not the multipolygon
  mean, which lands France's label in the Atlantic because of Corsica etc.).
- `bbox` powers jigsaw tolerance + tap-nearest + zoom-to-item.
- ISO id where available; admin1 uses a slug of the name.
- NE quirks: use `iso_a2_eh` (plain `iso_a2` is `-99` for France/Norway); tiny islands whose
  simplified geometry collapses get a circle of radius ~6 units at their centroid as `d`
  so they stay visible/tappable (flag them `"dot": true`).

Generated JSON **is checked into git** — runtime never builds or fetches anything beyond its
own static files. Keep `credit` displayed in the help modal.

## 4. The map component (js/map.js) — mobile-first rules

- One `<svg viewBox="0 0 w h">`; region items as `<path>` with `data-id`. Pan/zoom via a
  `<g transform>`: pointer-drag pan, wheel zoom, **pinch zoom** (two pointers), double-tap
  zoom-in, and +/− buttons; zoom clamped [1, 12]. Tap = pointerup with < 8 px total movement.
- **Small-country problem (mode 1 etc.):** three layers of defence:
  1. every item also gets an invisible hit `<path>` clone with `stroke-width: 14/scale` and
     `pointer-events: stroke` (fat finger halo, shrinks as you zoom in);
  2. a tap that hits nothing selects the nearest item centroid within 24 screen px, if any;
  3. selection never auto-commits — outline + CONFIRM button (per the spec), so a fiddly tap
     is always correctable, and you can zoom before confirming.
- Fill states as CSS classes: `.sel` (outline highlight), `.ok` (green fill), `.bad` (red
  fill), `.dim` (unplayed, jigsaw silhouette mode: uniform fill, `stroke: none`). Name labels
  as `<text>` at `cx/cy`, `font-size` scaled by `1/zoom` (clamped) so labels stay readable.
- `vector-effect: non-scaling-stroke` on all border strokes.
- Jigsaw tolerance: drop is correct when
  `dist(dropPoint, itemCentroid) ≤ max(0.55 * bboxDiagonal(item), 0.05 * mapDiagonal)`
  measured in map units. That gives big pieces forgiving targets and tiny pieces a floor of
  ~5% of the map — tune with playtesting.

## 5. Answer matching (modes 3 & 5)

`normalizeAnswer(s)`: lowercase → strip diacritics (NFD, drop combining marks) → `&`→`and` →
strip punctuation → collapse spaces → expand leading `st `→`saint `. Match against
`[name, …alt]` all normalized. Alias table lives in the build script (baked into `alt` in the
JSON) — must include at least: UAE; UK/Great Britain; USA/US/United States/America; DRC/DR
Congo/Congo-Kinshasa; Republic of the Congo/Congo-Brazzaville; Czechia/Czech Republic; Ivory
Coast/Côte d'Ivoire; Myanmar/Burma; East Timor/Timor-Leste; Eswatini/Swaziland; Cape
Verde/Cabo Verde; North Macedonia/Macedonia; Bosnia/Bosnia and Herzegovina; Vatican/Holy See;
São Tomé (with/without "and Príncipe"); Saint Kitts/St Kitts and Nevis; Saint Vincent (+ "and
the Grenadines"); Antigua (+ "and Barbuda"); Trinidad (+ "and Tobago"); Palestine/Palestinian
Territories; Turkey/Türkiye; US state DC variants; UK county "-shire" NOT auto-expanded (type
it properly) but `Co. Durham/County Durham`, `Rhondda Cynon Taf/Taff`. Sweep: dedupe — an
already-found name just pulses its territory.

## 6. Multiplayer protocol (shared rooms layer, like Scramblr)

- `MAX_PLAYERS = 5`. Rooms/joining/invites/rematch/notifications = exactly the Splitz/Scramblr
  code paths (`createNet(GAME_SLUG)`, `RoomConnection`, `createRematch`, `triggerPush` on
  friend challenge).
- Prestart: **host** (seat 0) sees the region picker + mode picker in the prestart overlay;
  guests see "waiting for host". Host taps START →
  `move { move_index: 0, player: 0, type: 'start', payload: { region, mode, startAt } }` +
  `updateRoomStatus('playing')`. A 3-2-1 countdown from `startAt` (Scramblr pattern), then
  everyone plays the same seeded sequence concurrently. `room.seed` drives the shuffle —
  identical for all seats.
- Progress moves (optional nicety, NOT required for v1): skip. Live progress is shown via
  presence only.
- Finishing: each client submits ONE sparse move
  `{ move_index: 10 + seat, player: seat, type: 'result', payload: { outcomes, ms, foundCount, gaveUp } }`
  where `outcomes = [{ id, ok, pick? }]` per question (sweep: `found: [ids]`). Results overlay
  shows "waiting for N…" then final ranking once all seats reported (or a seat is flagged
  `left`). `persistResultIfReady` → `finishRoom` (copy Scramblr's idempotent write-once +
  rewrite-if-more-complete logic).
- Reviewing attempts: tap a `.pchip` after finishing → render that player's `outcomes` onto
  the map (green/red + labels), Splitz `spectate()` style; tap your own card to return.
- Solo = no room at all (Scramblr daily pattern): seat 0, fake room object, skip networking.
  Solo start screen = same region/mode picker.

## 7. Instructions / help

Help modal (shared menu "How to play" opens `#help-modal`, same as other games): one intro
line, then a short paragraph per mode (name in caps + one sentence), the multiplayer line
("everyone races the same questions; tap a player's card at the end to see their map"), and
the Natural Earth credit. Also show a one-line hint under the map the first time each mode
runs (localStorage flag `atlaz.hint.<mode>`).

## 8. Landing page

Root `index.html`: replace the GAME 06 "COMING SOON" card with ATLAZ
(`// GAME 06 //`, name ATLAZ, desc ~"Map guessing games. Pinpoint countries, drag jigsaw
pieces into place, or race to name every state on the map — solo or against friends."),
and append a fresh GAME 07 coming-soon card.

## 9. Testing & verification

- `atlaz/test/engine.test.mjs` (pure node, zero deps, like splitz/test): seeded shuffle is
  deterministic + a permutation; normalization/alias matching table-driven cases; jigsaw
  tolerance math; sweep comparator ordering (completer beats faster quitter etc.);
  standings/winner derivation incl. ties.
- Data sanity check in the test too: load each `data/maps/*.json`, assert expected item
  counts (54 Africa, 51 USA, 47 Japan, …), every item has non-empty `d`, `name`, finite
  `cx/cy`, ids unique.
- Manual/Playwright smoke: `npx serve .` from repo root, open `/atlaz/`, play a solo round of
  each mode on a small region (Central America), check pan/zoom on touch emulation, and the
  three themes.
- Multiplayer: two browser contexts, create/join room, run a LINE-UP race, check result
  ranking + card-tap attempt review + rematch.

## 10. Work checklist (update as you land pieces)

- [x] Research data sources reachable from the dev env (amCharts/simplemaps/wikimedia blocked; Natural Earth via raw.githubusercontent + npm topojson/d3-geo chosen)
- [x] Plan checked into main
- [x] `tools/build-maps.mjs` + checked-in `data/maps/*.json` for all 15 regions (incl. Britain dissolve table, Ireland dissolve, Europe Russia clip + windowSkip, projected-space clipExtent, alias baking, label anchors, microstate dots)
- [x] `js/engine.js` + `test/engine.test.mjs` green (incl. per-region data sanity: counts, unique ids, label anchors, self-resolving names)
- [x] `js/map.js` (pan/pinch/wheel/double-tap zoom, tap-vs-drag, nearest-centroid tap assist, constant-size labels, fill states, silhouette)
- [x] `index.html` + css + config/net/notify/sw/manifest/icons scaffold (copied patterns)
- [x] Region & mode picker (solo + host prestart, remembered in localStorage)
- [x] Mode 1 PINPOINT
- [x] Mode 2 LINE-UP
- [x] Mode 3 NAMEDROP
- [x] Mode 4 JIGSAW
- [x] Mode 5 SWEEP (timer, armed give-up, completion-over-quitters ranking)
- [x] Multiplayer glue (start payload, sparse result moves 10+seat, waiting/final results, attempt review via player cards, rematch, finishRoom)
- [x] Help modal + credits (first-run hints folded into prompt-sub instead)
- [x] Landing page card (GAME 06 → ATLAZ, added GAME 07 placeholder)
- [x] All game tests pass (`for d in wurdz splitz scramblr atlaz; do node $d/test/engine.test.mjs; done`)
- [x] Playwright smoke of all 5 solo modes + a simulated 2-player room (stubbed Supabase, injected seat-1 result, card-tap review verified)
- [x] Push to `claude/map-geography-game-8j4ojm`

Phone-feedback round 1 (all landed):

- [x] Tap hit-testing fixed: `setPointerCapture` retargets pointerup to the svg, so direct
      path hits never fired and selection fell back to bbox-centre distance (Norway/Denmark
      unselectable — centres in the sea). Now: elementFromPoint → pointerdown target →
      nearest-bbox-rect assist.
- [x] Solo mode removed (landing + lobby); a 1-player room is solo. Player cards hidden
      when fewer than 2 players; 1-player rooms excluded from Game History.
- [x] Two-stage host prestart (pick → READY card with count/code/START RACE + change link).
- [x] Britain split into England / Scotland / Wales / Northern Ireland (6 counties).
- [x] Türkiye playable in europe + w-asia; Egypt in africa + w-asia; every region gets a
      dimmed, cropped `ctx` neighbour layer and a `lakes` layer (Great Lakes etc.).
- [x] Zoom-button glyphs centred; Line-up option buttons flex-centred (Android clipping);
      timer chip tabular-nums + room chip hidden during play so the map/mode chip never
      ellipsizes; theme radius/font tokens used so Synth corners render right.
- [x] `interactive-widget=resizes-content` viewport + scroll-to-origin guard: the keyboard
      can never scroll the game chrome off-screen (Namedrop/Sweep inputs).
- [x] Horizontal scroll on intro screens fixed across ALL games (`.card` overflowed its
      padded flex parent: min(420px, 94vw) + 40px padding > 100vw on phones; also
      `overflow-x` clamped on the landing scroll containers and `html`).
- [x] shared/history.js: theme-token restyle (was hard-coded Synth neon in every game),
      1-player rooms filtered out, per-game detail line via `LB_CONFIG.historyDetail`
      (Atlaz shows "Region · MODE").

Next playtest round candidates: on-device pinch feel, per-mode question caps for huge
regions, Splitz-style live progress moves, sweep leaderboard, real two-device multiplayer
against production Supabase.

Open questions parked for playtesting (don't block v1): per-mode question caps for huge
regions (Africa jigsaw = 54 drags — maybe cap at 20 with seeded subset?), sweep leaderboard as
a Scramblr-style daily, 32-county Ireland, Caribbean placement, zoom-follow on Line-up/Namedrop
highlights (auto-zoom to the highlighted item is probably wanted — decide on device).
