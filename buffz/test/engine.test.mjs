// Buffz engine tests — plain node, zero deps:  node buffz/test/engine.test.mjs
// The question generator is the heart: these tests hammer its determinism
// (identical rounds from identical inputs — multiplayer fairness) and its
// fairness rules (valid answers, no dup options, clear margins, no repeats),
// across every mode × difficulty × a matrix of filters over the real data.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODES, modeMeta, DIFFS, diffMeta, isOrderMode, ORDER_ROUNDS, MIN_POOL, roundsFor,
  mulberry32, shuffleWith, buildRounds, CATEGORIES, MODE_CATS, fmtMoney,
  orderKey, expectedOrder, gradeOrder,
  scoreOf, compareResults, rankSeats, winnerSeat,
} from '../js/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL  ${name}`); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const data = JSON.parse(readFileSync(join(HERE, '..', 'data', 'titles.json'), 'utf8'));
const items = data.items;
const ALL_IDS = Object.keys(items).sort();
const EASY = diffMeta('easy'), MED = diffMeta('medium'), HARD = diffMeta('hard'), MARATHON = diffMeta('marathon');

// ---- data sanity ---------------------------------------------------------------

{
  ok(ALL_IDS.length >= 50, `dataset has ${ALL_IDS.length} titles`);
  ok(typeof data.credit === 'string' && data.credit.includes('TMDB'), 'TMDb credit line present');
  for (const [id, it] of Object.entries(items)) {
    ok(it.t === 'm' || it.t === 'v', `${id}: type is m|v`);
    ok(typeof it.title === 'string' && it.title.length > 0, `${id}: has a title`);
    ok(Number.isFinite(it.year) && it.year > 1900, `${id}: has a year`);
    eq(it.decade, `${Math.floor(it.year / 10) * 10}s`, `${id}: decade matches year`);
    ok(Array.isArray(it.genres) && it.genres.length >= 1, `${id}: has genres`);
    ok(Array.isArray(it.cast) && it.cast.length >= 1 && it.cast.length <= 3, `${id}: 1-3 cast`);
    ok(it.rating > 0 && it.rating <= 10, `${id}: rating in range`);
    if (it.t === 'm') ok(!!it.director && !it.creator && !it.seasons, `${id}: movie fields`);
    if (it.t === 'v') ok(!!it.creator && !it.director && !it.revenue, `${id}: tv fields`);
    if (it.orig) ok(it.orig !== it.title, `${id}: orig differs from title`);
  }
  // country only present for non-US titles by design (question fairness).
  ok(Object.values(items).some((it) => it.country), 'some non-US titles carry country');
}

// ---- question generation: determinism + fairness over a filter matrix ----------

function poolFor(f) {
  return ALL_IDS.filter((id) => {
    const it = items[id];
    if (f.type !== 'all' && it.t !== f.type) return false;
    if (f.decade !== 'all' && it.decade !== f.decade) return false;
    if (f.genre !== 'all' && !it.genres.includes(f.genre)) return false;
    return true;
  });
}

const FILTERS = [
  { type: 'all', decade: 'all', genre: 'all' },
  { type: 'm', decade: 'all', genre: 'all' },
  { type: 'v', decade: 'all', genre: 'all' },
  { type: 'all', decade: '1990s', genre: 'all' },
  { type: 'm', decade: 'all', genre: 'Science Fiction' },
  { type: 'all', decade: 'all', genre: 'Crime' },
];

for (const f of FILTERS) {
  const pool = poolFor(f);
  if (pool.length < MIN_POOL) continue;
  const label = `${f.type}/${f.decade}/${f.genre}`;

  for (const mode of MODES.map((m) => m.id)) {
    for (const diff of [EASY, MED, HARD]) {
      const a = buildRounds(mode, diff, pool, 42, items);
      const b = buildRounds(mode, diff, pool, 42, items);
      const c = buildRounds(mode, diff, pool, 43, items);
      eq(a, b, `${label} ${mode}/${diff.id}: same seed → identical rounds`);
      ok(JSON.stringify(a) !== JSON.stringify(c), `${label} ${mode}/${diff.id}: different seed → different rounds`);
      ok(a.length > 0, `${label} ${mode}/${diff.id}: produced rounds`);
      ok(a.length <= roundsFor(mode, diff, pool.length), `${label} ${mode}/${diff.id}: within advertised count`);

      if (isOrderMode(mode)) {
        const seen = new Set();
        for (const r of a) {
          ok(r.ids.length === Math.min(diff.n, pool.length), `${label} ${mode}/${diff.id}: ${diff.n} per round`);
          for (const id of r.ids) { ok(!seen.has(id), `${label} ${mode}: no title repeats`); seen.add(id); }
        }
      } else {
        const seenTitles = new Set();
        for (const r of a) {
          ok(r.options.length >= 2 && r.options.length <= diff.n, `${label} ${mode}: 2..n options`);
          ok(r.answer >= 0 && r.answer < r.options.length, `${label} ${mode}: answer index valid`);
          eq([...new Set(r.options)].length, r.options.length, `${label} ${mode}: options unique`);
          ok(typeof r.prompt === 'string' && r.prompt.length > 5, `${label} ${mode}: has a prompt`);
          ok(typeof r.fact === 'string' && r.fact.length > 0, `${label} ${mode}: has a reveal fact`);
          ok((MODE_CATS[mode] || MODE_CATS.mixed).includes(r.cat), `${label} ${mode}: category belongs to mode`);
          ok(!seenTitles.has(r.id), `${label} ${mode}: no repeated question title`);
          seenTitles.add(r.id);
        }
      }
    }
  }
}

// ---- category-level correctness over many seeds --------------------------------

{
  const pool = ALL_IDS;
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const r of buildRounds('mixed', MARATHON, pool, seed, items)) {
      const it = items[r.id];
      checked++;
      const correct = r.options[r.answer];
      if (r.cat === 'year') eq(correct, String(it.year), `year: correct option is the year (${it.title})`);
      if (r.cat === 'runtime') eq(correct, `${it.runtime} min`, `runtime: correct option matches (${it.title})`);
      if (r.cat === 'seasons') eq(correct, String(it.seasons), `seasons: correct option matches (${it.title})`);
      if (r.cat === 'director') eq(correct, it.director, `director: correct option matches (${it.title})`);
      if (r.cat === 'creator') eq(correct, it.creator, `creator: correct option matches (${it.title})`);
      if (r.cat === 'studio') eq(correct, it.studio, `studio: correct option matches (${it.title})`);
      if (r.cat === 'country') eq(correct, it.country, `country: correct option matches (${it.title})`);
      if (r.cat === 'origtitle') eq(correct, it.orig, `origtitle: correct option matches (${it.title})`);
      if (r.cat === 'genre') ok(it.genres.includes(correct), `genre: correct option is one of the title's genres (${it.title})`);
      if (r.cat === 'star') ok(it.cast.includes(correct), `star: correct option is in the cast (${it.title})`);
      if (['tagline', 'plot', 'revdirector', 'revstar', 'ratingpick', 'revenuepick'].includes(r.cat)) {
        eq(correct, it.title, `${r.cat}: correct option is the title itself (${it.title})`);
      }
      if (r.cat === 'plot') ok(!r.quote.toLowerCase().includes(it.title.toLowerCase()), `plot: title masked in its own plot (${it.title})`);
      if (r.cat === 'ratingpick') {
        for (let i = 0; i < r.options.length; i++) {
          if (i === r.answer) continue;
          const other = Object.values(items).find((x) => x.title === r.options[i]);
          ok(it.rating - other.rating >= 0.4, `ratingpick: clear margin over ${other.title}`);
        }
      }
      if (r.cat === 'revenuepick') {
        for (let i = 0; i < r.options.length; i++) {
          if (i === r.answer) continue;
          const other = Object.values(items).find((x) => x.title === r.options[i]);
          ok(it.revenue >= other.revenue * 1.5, `revenuepick: clear margin over ${other.title}`);
        }
      }
      if (r.cat === 'revstar') {
        // No distractor title may feature the asked-about star.
        const star = r.prompt.match(/stars (.+)\?$/)?.[1];
        ok(!!star, 'revstar: prompt names the star');
        for (let i = 0; i < r.options.length; i++) {
          if (i === r.answer) continue;
          const other = Object.values(items).find((x) => x.title === r.options[i]);
          ok(!(other.cast || []).includes(star), `revstar: ${other.title} does not also star ${star}`);
        }
      }
      if (r.cat === 'revdirector') {
        const who = r.prompt.match(/did (.+) direct\?$/)?.[1];
        for (let i = 0; i < r.options.length; i++) {
          if (i === r.answer) continue;
          const other = Object.values(items).find((x) => x.title === r.options[i]);
          ok(other.director !== who, `revdirector: ${other.title} not also by ${who}`);
        }
      }
    }
  }
  ok(checked >= 500, `category checks covered ${checked} generated questions`);
  // Over many seeds, MIXED should exercise most of the bank.
  const catsSeen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    for (const r of buildRounds('mixed', MARATHON, pool, seed, items)) catsSeen.add(r.cat);
  }
  ok(catsSeen.size >= 12, `mixed exercises the bank (${catsSeen.size}/${CATEGORIES.length} categories seen)`);
}

// ---- ordering keys + grading ----------------------------------------------------

{
  const T = {
    a: { title: 'A', year: 1990, rating: 7.0 },
    b: { title: 'B', year: 2000, rating: 8.0 },
    c: { title: 'C', year: 2010, rating: 6.0 },
    d: { title: 'D', year: 2000, rating: 9.0 },
  };
  eq(expectedOrder('timeline', ['c', 'a', 'b'], T), ['a', 'b', 'c'], 'timeline sorts by year');
  eq(expectedOrder('ranked', ['a', 'b', 'c'], T), ['c', 'a', 'b'], 'ranked sorts by rating');
  eq(gradeOrder('timeline', ['a', 'b', 'c'], T), [true, true, true], 'perfect arrangement');
  eq(gradeOrder('timeline', ['b', 'a', 'c'], T), [false, false, true], 'two swapped → two wrong');
  // Same-year titles are interchangeable.
  eq(gradeOrder('timeline', ['a', 'd', 'b', 'c'], T), [true, true, true, true], 'year ties interchangeable');
}

// ---- roundsFor + metadata -------------------------------------------------------

{
  eq(MODES.length, 6, 'six modes');
  ok(MODES.every((m) => modeMeta(m.id) === m), 'modeMeta finds every mode');
  ok(isOrderMode('timeline') && isOrderMode('ranked') && !isOrderMode('mixed'), 'order-mode split');
  eq(DIFFS.map((d) => d.q), [5, 10, 15, 25], 'difficulty question counts');
  eq(DIFFS.map((d) => d.n), [3, 4, 6, 8], 'difficulty option counts');
  ok(DIFFS.every((d) => diffMeta(d.id) === d), 'diffMeta finds every difficulty');
  eq(roundsFor('mixed', MED, 500), 10, 'roundsFor pick mode');
  eq(roundsFor('mixed', MARATHON, 12), 12, 'roundsFor caps at pool size');
  eq(roundsFor('timeline', MED, 500), 5, 'roundsFor order mode caps at 5 rounds');
  eq(roundsFor('timeline', HARD, 13), 2, 'roundsFor order mode small pool: 13/6 → 2 rounds');
  ok(MIN_POOL >= DIFFS[DIFFS.length - 1].n, 'MIN_POOL covers the largest sort size');
  eq(fmtMoney(2924000000), '$2.92B', 'money formatting B');
  eq(fmtMoney(47000000), '$47M', 'money formatting M');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
