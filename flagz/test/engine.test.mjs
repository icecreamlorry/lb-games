// Flagz engine tests — plain node, zero deps:  node flagz/test/engine.test.mjs
// Pure logic (seeded rounds, ordering grades, matching, ranking) + sanity
// checks over the generated country data and flag files.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODES, modeMeta, DIFFS, diffMeta, isOrderMode, PICK_ROUNDS, ORDER_ROUNDS,
  mulberry32, shuffleWith, buildRounds,
  orderKey, expectedOrder, gradeOrder,
  normalizeAnswer, buildAnswerIndex, matchAnswer,
  scoreOf, compareResults, rankSeats, winnerSeat,
} from '../js/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL  ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const REGION = 'AA BB CC DD EE FF GG HH II JJ KK LL MM NN OO PP'.split(' ');

// ---- seeded round building ---------------------------------------------------

{
  const a = buildRounds('spotter', 6, REGION, 42);
  const b = buildRounds('spotter', 6, REGION, 42);
  const c = buildRounds('spotter', 6, REGION, 43);
  eq(a, b, 'same seed → same rounds');
  ok(JSON.stringify(a) !== JSON.stringify(c), 'different seed → different rounds');
  eq(a.length, PICK_ROUNDS, 'pick modes run 10 rounds');
  for (const r of a) {
    eq(r.options.length, 6, 'medium → 6 options');
    ok(r.options.includes(r.answer), 'answer among options');
    eq([...new Set(r.options)].length, r.options.length, 'options unique');
  }
  const answers = a.map((r) => r.answer);
  eq([...new Set(answers)].length, answers.length, 'no repeated questions');

  const all = buildRounds('lineup', 0, REGION, 7);
  for (const r of all) eq(r.options.length, REGION.length, 'ALL difficulty → whole region as options');

  const nd = buildRounds('namedrop', 6, REGION, 7);
  for (const r of nd) eq(r.options.length, 0, 'namedrop has no options');

  const small = buildRounds('spotter', 9, 'AA BB CC'.split(' '), 5);
  eq(small.length, 3, 'rounds capped at region size');
  for (const r of small) eq(r.options.length, 3, 'options capped at region size');
}

{
  const rounds = buildRounds('headcount', 3, REGION, 42);
  eq(rounds.length, ORDER_ROUNDS, 'order modes run 5 rounds');
  const seen = new Set();
  for (const r of rounds) {
    eq(r.ids.length, 3, 'easy → 3 flags per round');
    for (const id of r.ids) { ok(!seen.has(id), 'no flag repeats across rounds'); seen.add(id); }
  }
  const allRounds = buildRounds('atoz', 0, REGION, 42);
  eq(allRounds.length, 1, 'ALL difficulty → one big round');
  eq(allRounds[0].ids.length, REGION.length, '…containing the whole region');
  const tiny = buildRounds('landmass', 9, 'AA BB CC DD'.split(' '), 3);
  ok(tiny.length >= 1 && tiny[0].ids.length === 4, 'small region → single round of everything');
}

// ---- ordering keys + grading ----------------------------------------------------

{
  const C = {
    AA: { name: 'Austria', pop: 9, area: 84 },
    BB: { name: 'Belgium', pop: 11, area: 30 },
    CC: { name: 'Chad', pop: 16, area: 1284 },
    DD: { name: 'Denmark', pop: 6, area: 43 },
  };
  eq(expectedOrder('atoz', ['CC', 'AA', 'DD', 'BB'], C), ['AA', 'BB', 'CC', 'DD'], 'atoz sorts by name');
  eq(expectedOrder('headcount', ['AA', 'BB', 'CC', 'DD'], C), ['DD', 'AA', 'BB', 'CC'], 'headcount sorts by population');
  eq(expectedOrder('landmass', ['AA', 'BB', 'CC', 'DD'], C), ['BB', 'DD', 'AA', 'CC'], 'landmass sorts by area');
  eq(gradeOrder('atoz', ['AA', 'BB', 'CC', 'DD'], C), [true, true, true, true], 'perfect arrangement');
  eq(gradeOrder('atoz', ['BB', 'AA', 'CC', 'DD'], C), [false, false, true, true], 'two swapped → two wrong');
  // ties: equal values are interchangeable
  const T = { XX: { name: 'X', pop: 5, area: 1 }, YY: { name: 'Y', pop: 5, area: 2 }, ZZ: { name: 'Z', pop: 9, area: 3 } };
  eq(gradeOrder('headcount', ['YY', 'XX', 'ZZ'], T), [true, true, true], 'population ties interchangeable');
}

// ---- answer matching ---------------------------------------------------------------

{
  eq(normalizeAnswer("Côte d'Ivoire!"), 'cote divoire', 'normalization');
  const idx = buildAnswerIndex([
    { id: 'US', name: 'United States', alt: ['usa'] },
    { id: 'KP', name: 'North Korea', alt: ['dprk'] },
  ]);
  eq(matchAnswer(idx, 'U.S.A.'), 'US', 'packed alias');
  eq(matchAnswer(idx, 'north korea'), 'KP', 'plain name');
  eq(matchAnswer(idx, 'zzz'), null, 'no match');
}

// ---- ranking -------------------------------------------------------------------------

{
  const r = (score, ms) => ({ outcomes: [], score, total: 10, ms });
  eq(rankSeats({ 0: r(5, 60), 1: r(7, 90), 2: r(7, 50) }, 3), [2, 1, 0], 'score desc, time asc');
  eq(winnerSeat({ 0: r(5, 60), 1: r(5, 60) }, 2), 'tie', 'identical results tie');
  eq(winnerSeat({}, 2), 'tie', 'nobody submitted → tie');
  eq(scoreOf(undefined), 0, 'missing result scores 0');
  ok(compareResults(r(1, 1), undefined) < 0, 'any result beats no result');
}

// ---- modes/diffs metadata ---------------------------------------------------------------

{
  eq(MODES.length, 6, 'six modes');
  ok(MODES.every((m) => modeMeta(m.id) === m), 'modeMeta finds every mode');
  ok(isOrderMode('atoz') && isOrderMode('headcount') && isOrderMode('landmass') && !isOrderMode('spotter'), 'order-mode split');
  eq(DIFFS.map((d) => d.n), [3, 6, 9, 0], 'difficulty option counts');
  ok(DIFFS.every((d) => diffMeta(d.id) === d), 'diffMeta finds every difficulty');
}

// ---- generated data sanity ------------------------------------------------------------------

{
  const data = JSON.parse(readFileSync(join(HERE, '..', 'data', 'countries.json'), 'utf8'));
  ok(typeof data.credit === 'string' && data.credit.includes('flag-icons'), 'credit line present');
  const world = data.regions.find((r) => r.id === 'world');
  ok(world, 'world region exists');
  const worldSet = new Set(world.iso.split(' '));
  ok(worldSet.size >= 190, `world has ${worldSet.size} countries`);
  for (const r of data.regions) {
    const iso = r.iso.split(' ');
    eq([...new Set(iso)].length, iso.length, `${r.id}: no duplicate countries`);
    if (r.id !== 'world') {
      ok(iso.length >= 14 && iso.length <= 35, `${r.id}: ${iso.length} countries within size target`);
      for (const c of iso) ok(worldSet.has(c), `${r.id}/${c}: in world too`);
    }
  }
  const flagsDir = join(HERE, '..', 'data', 'flags');
  for (const [a2, c] of Object.entries(data.countries)) {
    ok(typeof c.name === 'string' && c.name.length > 1, `${a2}: has a name`);
    ok(Number.isFinite(c.pop) && c.pop > 0, `${a2}: population present`);
    ok(Number.isFinite(c.area) && c.area > 0, `${a2}: area present`);
    ok(existsSync(join(flagsDir, `${a2.toLowerCase()}.svg`)), `${a2}: flag file exists`);
  }
  // Every world country resolvable by its own name.
  const idx = buildAnswerIndex(Object.entries(data.countries).map(([id, c]) => ({ id, name: c.name, alt: c.alt })));
  for (const [a2, c] of Object.entries(data.countries)) {
    ok(matchAnswer(idx, c.name) === a2, `${a2}: name resolves to itself`);
  }
  // A few well-known orderings hold.
  ok(data.countries.CN.pop > data.countries.DE.pop, 'China outpopulates Germany');
  ok(data.countries.RU.area > data.countries.FR.area, 'Russia larger than France');
  ok(data.countries.VA.area <= 2, 'Vatican tiny');
  // The two square flags are flagged so the UI renders them un-stretched.
  ok(data.countries.CH.square === true, 'Switzerland marked square');
  ok(data.countries.VA.square === true, 'Vatican marked square');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
