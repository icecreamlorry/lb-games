// Atomyx engine tests — plain node, zero deps:  node atomyx/test/engine.test.mjs
// Pure logic (seeded rounds, ordering grades, matching, ranking) + sanity
// checks over the generated element data.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODES, modeMeta, DIFFS, diffMeta, isOrderMode, isTableMode, PICK_ROUNDS, ORDER_ROUNDS, roundsFor,
  mulberry32, shuffleWith, buildRounds,
  orderKey, expectedOrder, gradeOrder,
  normalizeAnswer, buildAnswerIndex, matchAnswer, matchSymbol,
  scoreOf, compareResults, rankSeats, winnerSeat,
} from '../js/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL  ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const SET = 'aa bb cc dd ee ff gg hh ii jj kk ll mm nn oo pp'.split(' ');
const EASY = diffMeta('easy'), MED = diffMeta('medium'), HARD = diffMeta('hard'), ALL = diffMeta('all');

// ---- seeded round building ---------------------------------------------------

{
  const a = buildRounds('lineup', MED, SET, 42);
  const b = buildRounds('lineup', MED, SET, 42);
  const c = buildRounds('lineup', MED, SET, 43);
  eq(a, b, 'same seed → same rounds');
  ok(JSON.stringify(a) !== JSON.stringify(c), 'different seed → different rounds');
  eq(a.length, 10, 'lineup medium → 10 questions');
  for (const r of a) {
    eq(r.options.length, 6, 'medium → 6 options');
    ok(r.options.includes(r.answer), 'answer among options');
    eq([...new Set(r.options)].length, r.options.length, 'options unique');
  }
  const answers = a.map((r) => r.answer);
  eq([...new Set(answers)].length, answers.length, 'no repeated questions');

  const all = buildRounds('lineup', ALL, SET, 7);
  eq(all.length, SET.length, 'lineup ALL → a question for every element');
  for (const r of all) eq(r.options.length, SET.length, 'ALL difficulty → whole set as options');

  // Difficulty now drives the QUESTION count in the modes that used to ignore it.
  for (const mode of ['pinpoint', 'namedrop', 'build']) {
    eq(buildRounds(mode, EASY, SET, 7).length, 5, `${mode} easy → 5 questions`);
    eq(buildRounds(mode, MED, SET, 7).length, 10, `${mode} medium → 10 questions`);
    eq(buildRounds(mode, HARD, SET, 7).length, 15, `${mode} hard → 15 questions`);
    eq(buildRounds(mode, ALL, SET, 7).length, SET.length, `${mode} ALL → every element once`);
    for (const r of buildRounds(mode, MED, SET, 7)) eq(r.options.length, 0, `${mode} has no options`);
    // Never a repeated question.
    const ans = buildRounds(mode, HARD, SET, 7).map((r) => r.answer);
    eq([...new Set(ans)].length, ans.length, `${mode}: no repeated questions`);
  }

  // Question count is capped at the set size (HARD wants 15, set has only 3).
  const small = buildRounds('pinpoint', HARD, ['aa', 'bb', 'cc'], 5);
  eq(small.length, 3, 'questions capped at set size');

  const sweep = buildRounds('sweep', MED, SET, 9);
  eq(sweep.length, 1, 'sweep is one round');
  eq([...sweep[0].ids].sort(), [...SET].sort(), '…carrying the whole set');
}

{
  const rounds = buildRounds('mass', EASY, SET, 42);
  eq(rounds.length, ORDER_ROUNDS, 'mass easy → 5 rounds (16 elements / 3 cards, capped)');
  const seen = new Set();
  for (const r of rounds) {
    eq(r.ids.length, 3, 'easy → 3 cards per round');
    for (const id of r.ids) { ok(!seen.has(id), 'no element repeats across rounds'); seen.add(id); }
  }
  eq(buildRounds('mass', MED, SET, 42).every((r) => r.ids.length === 6), true, 'medium → 6 cards per round');
  eq(buildRounds('mass', HARD, SET, 42)[0].ids.length, 9, 'hard → 9 cards per round');
  const allRounds = buildRounds('mass', ALL, SET, 42);
  eq(allRounds.length, 1, 'ALL difficulty → one big round');
  eq(allRounds[0].ids.length, SET.length, '…containing the whole set');
  const tiny = buildRounds('mass', HARD, ['aa', 'bb', 'cc', 'dd'], 3);
  ok(tiny.length >= 1 && tiny[0].ids.length === 4, 'small set → single round of everything');
}

// ---- roundsFor (what the UI advertises) --------------------------------------

{
  eq(roundsFor('pinpoint', EASY, 20), 5, 'roundsFor pinpoint easy');
  eq(roundsFor('pinpoint', HARD, 12), 12, 'roundsFor caps at set size');
  eq(roundsFor('pinpoint', ALL, 30), 30, 'roundsFor ALL = whole set');
  eq(roundsFor('lineup', MED, 30), 10, 'roundsFor lineup medium');
  eq(roundsFor('mass', HARD, 30), 3, 'roundsFor mass hard = 30/9 groups');
  eq(roundsFor('mass', ALL, 30), 1, 'roundsFor mass ALL = one round');
  eq(roundsFor('sweep', HARD, 30), 1, 'roundsFor sweep = one round');
  // roundsFor agrees with the real builder.
  for (const mode of ['pinpoint', 'lineup', 'namedrop', 'build', 'mass'])
    for (const d of DIFFS)
      eq(buildRounds(mode, d, SET, 1).length, roundsFor(mode, d, SET.length), `roundsFor matches builder: ${mode}/${d.id}`);
}

// ---- ordering keys + grading ----------------------------------------------------

{
  const E = {
    h: { name: 'Hydrogen', mass: 1.008 },
    fe: { name: 'Iron', mass: 55.845 },
    co: { name: 'Cobalt', mass: 58.933 },
    ni: { name: 'Nickel', mass: 58.693 },
  };
  eq(expectedOrder('mass', ['co', 'h', 'ni', 'fe'], E), ['h', 'fe', 'ni', 'co'], 'mass sorts ascending (incl. the Co/Ni inversion)');
  eq(gradeOrder('mass', ['h', 'fe', 'ni', 'co'], E), [true, true, true, true], 'perfect arrangement');
  eq(gradeOrder('mass', ['fe', 'h', 'ni', 'co'], E), [false, false, true, true], 'two swapped → two wrong');
  // ties: equal values are interchangeable
  const T = { xx: { name: 'X', mass: 5 }, yy: { name: 'Y', mass: 5 }, zz: { name: 'Z', mass: 9 } };
  eq(gradeOrder('mass', ['yy', 'xx', 'zz'], T), [true, true, true], 'mass ties interchangeable');
}

// ---- answer matching ---------------------------------------------------------------

{
  eq(normalizeAnswer('  CAESIUM! '), 'caesium', 'normalization');
  const idx = buildAnswerIndex([
    { id: 'al', name: 'Aluminium', alt: ['aluminum'] },
    { id: 'w', name: 'Tungsten', alt: ['wolfram'] },
  ]);
  eq(matchAnswer(idx, 'aluminum'), 'al', 'alias spelling');
  eq(matchAnswer(idx, 'Wolfram'), 'w', 'classic alternative name');
  eq(matchAnswer(idx, 'zzz'), null, 'no match');
  eq(matchSymbol(['h', 'he', 'fe'], 'Fe'), 'fe', 'symbol match');
  eq(matchSymbol(['h', 'he'], 'fe'), null, 'symbol outside the set');
}

// ---- ranking -------------------------------------------------------------------------

{
  const r = (score, ms) => ({ outcomes: [], score, total: 10, ms });
  eq(rankSeats({ 0: r(5, 60), 1: r(7, 90), 2: r(7, 50) }, 3), [2, 1, 0], 'score desc, time asc');
  eq(winnerSeat({ 0: r(5, 60), 1: r(5, 60) }, 2), 'tie', 'identical results tie');
  eq(winnerSeat({ 0: r(7, 50), 1: r(7, 90) }, 2), 'tie', 'equal score, different time → draw (time only orders the list)');
  eq(winnerSeat({ 0: r(8, 90), 1: r(6, 40) }, 2), 0, 'higher score wins even if slower');
  eq(winnerSeat({}, 2), 'tie', 'nobody submitted → tie');
  eq(scoreOf(undefined), 0, 'missing result scores 0');
  ok(compareResults(r(1, 1), undefined) < 0, 'any result beats no result');
  // Sweep ranking falls out of the same rule: completers hold max score.
  const done = (ms) => r(16, ms), quit = (n, ms) => r(n, ms);
  eq(rankSeats({ 0: quit(15, 30), 1: done(300), 2: done(200) }, 3), [2, 1, 0], 'sweep completers above quitters, then by time');
}

// ---- modes/diffs metadata ---------------------------------------------------------------

{
  eq(MODES.length, 6, 'six modes');
  ok(MODES.every((m) => modeMeta(m.id) === m), 'modeMeta finds every mode');
  ok(isOrderMode('mass') && !isOrderMode('pinpoint') && !isOrderMode('sweep'), 'order-mode split');
  ok(isTableMode('pinpoint') && isTableMode('build') && !isTableMode('lineup'), 'table-mode split');
  eq(DIFFS.map((d) => d.n), [3, 6, 9, 0], 'difficulty juggle counts');
  eq(DIFFS.map((d) => d.q), [5, 10, 15, 0], 'difficulty question counts');
  ok(DIFFS.every((d) => diffMeta(d.id) === d), 'diffMeta finds every difficulty');
}

// ---- generated data sanity ------------------------------------------------------------------

{
  const data = JSON.parse(readFileSync(join(HERE, '..', 'data', 'elements.json'), 'utf8'));
  ok(typeof data.credit === 'string' && data.credit.includes('Periodic-Table-JSON'), 'credit line present');
  const E = data.elements;
  eq(Object.keys(E).length, 118, '118 elements');

  const all = data.sets.find((s) => s.id === 'all');
  ok(all, 'all set exists');
  const allSet = new Set(all.els.split(' '));
  eq(allSet.size, 118, 'all set covers everything');
  const wantSizes = { all: 118, first20: 20, everyday: 30, alkline: 12, salts: 13, transition: 38, pblock: 24, lanthanides: 15, actinides: 15 };
  for (const s of data.sets) {
    const els = s.els.split(' ');
    eq([...new Set(els)].length, els.length, `${s.id}: no duplicate elements`);
    eq(els.length, wantSizes[s.id], `${s.id}: expected size`);
    for (const id of els) ok(allSet.has(id), `${s.id}/${id}: in all too`);
  }

  // Per element: fields present, id = lowercase symbol, valid grid position.
  const seen = new Set();
  const famCounts = {};
  for (const [id, el] of Object.entries(E)) {
    ok(typeof el.name === 'string' && el.name.length > 2, `${id}: has a name`);
    ok(el.sym.toLowerCase() === id, `${id}: id is the lowercase symbol`);
    ok(Number.isFinite(el.mass) && el.mass > 0, `${id}: mass present`);
    ok(el.x >= 1 && el.x <= 18 && el.y >= 1 && el.y <= 10 && el.y !== 8, `${id}: grid position in range`);
    ok(!seen.has(`${el.x},${el.y}`), `${id}: no grid collision`);
    seen.add(`${el.x},${el.y}`);
    ok(['s', 'l', 'g', '?'].includes(el.phase), `${id}: phase valid`);
    famCounts[el.fam] = (famCounts[el.fam] || 0) + 1;
  }
  // The exact 12-family partition.
  eq(famCounts, {
    hydrogen: 1, noble: 7, alkali: 6, alkaline: 6, boron: 6, carbon: 6,
    pnictogen: 6, chalcogen: 6, halogen: 6, transition: 38, lanthanide: 15, actinide: 15,
  }, 'family partition sums to 118');

  // Every element resolvable by its own name; symbols unique by construction.
  const idx = buildAnswerIndex(Object.entries(E).map(([id, el]) => ({ id, name: el.name, alt: el.alt })));
  for (const [id, el] of Object.entries(E)) {
    ok(matchAnswer(idx, el.name) === id, `${id}: name resolves to itself`);
  }
  // Aliases and spellings.
  eq(matchAnswer(idx, 'aluminum'), 'al', 'aluminum → aluminium');
  eq(matchAnswer(idx, 'cesium'), 'cs', 'cesium → caesium');
  eq(matchAnswer(idx, 'sulphur'), 's', 'sulphur → sulfur');
  eq(matchAnswer(idx, 'wolfram'), 'w', 'wolfram → tungsten');
  eq(matchAnswer(idx, 'quicksilver'), 'hg', 'quicksilver → mercury');

  // Known facts.
  eq(E.h.num, 1, 'hydrogen is #1');
  eq(E.og.num, 118, 'oganesson is #118');
  ok(Math.abs(E.fe.mass - 55.845) < 0.01, 'iron mass sane');
  ok(E.ar.mass > E.k.mass, 'the Ar > K mass inversion holds');
  ok(E.co.mass > E.ni.mass, 'the Co > Ni mass inversion holds');
  ok(E.te.mass > E.i.mass, 'the Te > I mass inversion holds');
  // Room-temperature liquids: exactly Hg and Br (predicted phases of the
  // never-observed synthetics are stored as '?', not taught as fact).
  eq(Object.entries(E).filter(([, el]) => el.phase === 'l').map(([id]) => id).sort(), ['br', 'hg'], 'exactly two liquids');
  eq(Object.values(E).filter((el) => el.phase === 'g').length, 11, 'eleven gases');
  // Layout spot-checks: H top-left, He top-right, La/Ac on the shelf.
  eq([E.h.x, E.h.y], [1, 1], 'H at 1,1');
  eq([E.he.x, E.he.y], [18, 1], 'He at 18,1');
  eq([E.la.x, E.la.y], [3, 9], 'La opens the lanthanide shelf');
  eq([E.lr.x, E.lr.y], [17, 10], 'Lr closes the actinide shelf');
  eq([E.rn.x, E.rn.y], [18, 6], 'Rn ends period 6');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
