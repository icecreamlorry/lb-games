// Atlaz engine tests — plain node, zero deps:  node atlaz/test/engine.test.mjs
// Covers the pure logic (seeded order, answer matching, jigsaw tolerance,
// sweep/standard ranking) plus sanity checks over the generated map data.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mulberry32, seededShuffle, questionOrder,
  normalizeAnswer, buildAnswerIndex, matchAnswer,
  jigsawTolerance, jigsawHit, bboxCenter,
  scoreOf, compareResults, rankSeats, winnerSeat, MODES, modeMeta,
} from '../js/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL  ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ---- seeded shuffle ----------------------------------------------------------

{
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}` }));
  const a = questionOrder(items, 12345);
  const b = questionOrder(items, 12345);
  const c = questionOrder(items, 54321);
  eq(a, b, 'same seed → same order');
  ok(JSON.stringify(a) !== JSON.stringify(c), 'different seed → different order');
  eq([...a].sort(), items.map((i) => i.id).sort(), 'order is a permutation');
  const r = mulberry32(7);
  ok(r() >= 0 && r() < 1, 'mulberry32 emits [0,1)');
}

// ---- answer normalization ------------------------------------------------------

{
  eq(normalizeAnswer('  São Tomé & Príncipe!! '), 'sao tome and principe', 'diacritics/&/punctuation');
  eq(normalizeAnswer('St Kitts'), 'saint kitts', 'leading St → Saint');
  eq(normalizeAnswer('Mont-St-Michel'), 'mont saint michel', 'inner st → saint');
  eq(normalizeAnswer("Côte d'Ivoire"), 'cote divoire', 'apostrophes elided');
  eq(normalizeAnswer('RHONDDA, CYNON, TAFF'), 'rhondda cynon taff', 'case + commas');
}

{
  const items = [
    { id: 'US', name: 'United States', alt: ['usa', 'america'] },
    { id: 'GB', name: 'United Kingdom', alt: ['uk', 'great britain', 'britain'] },
    { id: 'KN', name: 'Saint Kitts and Nevis', alt: ['st kitts'] },
  ];
  const idx = buildAnswerIndex(items);
  eq(matchAnswer(idx, 'U.S.A.'), 'US', 'alias with punctuation');
  eq(matchAnswer(idx, 'united kingdom'), 'GB', 'plain name');
  eq(matchAnswer(idx, 'St. Kitts & Nevis'), 'KN', 'st/saint + & aliasing');
  eq(matchAnswer(idx, 'saint kitts'), 'KN', 'alias itself normalized');
  eq(matchAnswer(idx, 'france'), null, 'no match → null');
}

// ---- jigsaw tolerance -----------------------------------------------------------

{
  const big = { id: 'big', bbox: [0, 0, 400, 300] };     // diag 500 → tol 275
  const tiny = { id: 'tiny', bbox: [500, 500, 504, 503] }; // floor: 5% of map diag
  const W = 1000, H = 1000;
  eq(bboxCenter(big), [200, 150], 'bbox centre');
  ok(Math.abs(jigsawTolerance(big, W, H) - 275) < 1e-9, 'big piece → 55% of its diagonal');
  ok(Math.abs(jigsawTolerance(tiny, W, H) - 0.05 * Math.hypot(W, H)) < 1e-9, 'tiny piece → 5% map floor');
  ok(jigsawHit(big, 300, 250, W, H), 'inside tolerance hits');
  ok(!jigsawHit(big, 700, 800, W, H), 'far away misses');
  ok(jigsawHit(tiny, 540, 540, W, H), 'tiny piece forgiving drop');
}

// ---- scoring & ranking ------------------------------------------------------------

{
  const r = (overrides) => ({ outcomes: [], foundCount: 0, total: 7, ms: 60000, gaveUp: false, ...overrides });
  const oc = (n, total) => Array.from({ length: total }, (_, i) => ({ id: `x${i}`, ok: i < n }));

  eq(scoreOf(r({ outcomes: oc(5, 7) })), 5, 'scoreOf counts correct outcomes');
  eq(scoreOf(r({ foundCount: 4 })), 4, 'scoreOf falls back to foundCount');
  eq(scoreOf(undefined), 0, 'scoreOf tolerates missing result');

  // modes 1–4: score desc, then time asc
  const A = r({ outcomes: oc(5, 7), ms: 90000 });
  const B = r({ outcomes: oc(5, 7), ms: 30000 });
  const C = r({ outcomes: oc(7, 7), ms: 120000 });
  eq(rankSeats('pinpoint', { 0: A, 1: B, 2: C }, 3), [2, 1, 0], 'score first, faster breaks ties');
  eq(winnerSeat('pinpoint', { 0: A, 1: B, 2: C }, 3), 2, 'winner = top of ranking');
  eq(winnerSeat('pinpoint', { 0: B, 1: { ...B } }, 2), 'tie', 'identical results tie');
  eq(winnerSeat('pinpoint', {}, 2), 'tie', 'nobody submitted → tie');
  eq(winnerSeat('pinpoint', { 0: A }, 1), 0, 'solo winner');

  // sweep: completion dominates; quitters by found desc then time
  const full = r({ foundCount: 7, ms: 300000 });
  const fastQuit = r({ foundCount: 6, ms: 20000, gaveUp: true });
  const slowQuit = r({ foundCount: 6, ms: 50000, gaveUp: true });
  const fewQuit = r({ foundCount: 2, ms: 5000, gaveUp: true });
  eq(rankSeats('sweep', { 0: fastQuit, 1: full, 2: fewQuit, 3: slowQuit }, 4), [1, 0, 3, 2],
    'sweep: completer above all quitters; quitters by found then time');
  const fullFast = r({ foundCount: 7, ms: 100000 });
  eq(rankSeats('sweep', { 0: full, 1: fullFast }, 2), [1, 0], 'sweep: completers race on time');
  ok(compareResults('sweep', full, fastQuit) < 0, 'slow completer still beats fast quitter');
  eq(rankSeats('sweep', { 1: full }, 2), [1, 0], 'missing results sink to the bottom');
}

// ---- modes metadata -----------------------------------------------------------------

{
  eq(MODES.length, 5, 'five modes');
  ok(MODES.every((m) => modeMeta(m.id) === m), 'modeMeta finds every mode');
  ok(!modeMeta('nope'), 'unknown mode → null');
}

// ---- generated map data sanity --------------------------------------------------------

{
  const dir = join(HERE, '..', 'data', 'maps');
  const expected = {
    'africa': 54, 'europe': 47, 'se-asia': 11, 'w-asia': 20, 'oceania': 14,
    'caribbean': 13, 's-america': 12, 'n-america': 10,
    'usa': 51, 'england': 47, 'scotland': 32, 'wales': 22, 'northern-ireland': 6,
    'ireland': 26, 'canada': 13, 'brazil': 27, 'australia': 8, 'japan': 47,
  };
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  eq(files.length, Object.keys(expected).length, 'all 18 region files exist');
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    ok(expected[d.id] === d.items.length, `${d.id}: ${d.items.length} items (want ${expected[d.id]})`);
    ok(d.w === 1000 && Number.isFinite(d.h) && d.h > 100, `${d.id}: sensible viewBox`);
    ok(typeof d.credit === 'string' && d.credit.includes('Natural Earth'), `${d.id}: credit line present`);
    ok(Array.isArray(d.ctx) && d.ctx.every((c) => typeof c === 'string' && c.length > 5), `${d.id}: ctx layer well-formed`);
    ok(Array.isArray(d.lakes), `${d.id}: lakes layer present`);
    const ids = new Set();
    for (const it of d.items) {
      ok(it.id && !ids.has(it.id), `${d.id}/${it.id}: unique id`);
      ids.add(it.id);
      ok(typeof it.d === 'string' && it.d.length > 10, `${d.id}/${it.id}: has path data`);
      ok(typeof it.name === 'string' && it.name.length > 1, `${d.id}/${it.id}: has a name`);
      ok(Number.isFinite(it.cx) && Number.isFinite(it.cy), `${d.id}/${it.id}: label anchor`);
      ok(Array.isArray(it.bbox) && it.bbox.length === 4 && it.bbox.every(Number.isFinite), `${d.id}/${it.id}: bbox`);
      ok(it.cx >= -50 && it.cx <= d.w + 50 && it.cy >= -50 && it.cy <= d.h + 50, `${d.id}/${it.id}: label anchor within frame`);
    }
    // Every item resolvable by its own name through the answer index.
    const idx = buildAnswerIndex(d.items);
    for (const it of d.items) {
      ok(matchAnswer(idx, it.name) === it.id || d.items.some((o) => o.id !== it.id && normalizeAnswer(o.name) === normalizeAnswer(it.name)),
        `${d.id}/${it.id}: name resolves to itself`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
