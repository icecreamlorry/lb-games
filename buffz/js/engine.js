// Buffz game logic — pure functions, no DOM, no network (unit-tested by
// test/engine.test.mjs under plain node).
//
// THE DETERMINISM CONTRACT: every seat must derive identical rounds from
// (data, filters, mode, diff, room seed). So everything here draws randomness
// only from the seeded RNG, iterates the pool in sorted-id order before the
// seeded shuffle, and never touches Date/Math.random. Break that and
// multiplayer silently stops being fair.

// ---- Game modes -------------------------------------------------------------

export const MODES = [
  { id: 'mixed', name: 'MIXED', tagline: 'A bit of everything, every round' },
  { id: 'plotlines', name: 'PLOTLINES', tagline: 'Taglines & plots — name the title' },
  { id: 'casting', name: 'CASTING', tagline: 'Directors, creators & stars' },
  { id: 'details', name: 'DETAILS', tagline: 'Years, runtimes, studios & more' },
  { id: 'timeline', name: 'TIMELINE', tagline: 'Sort by release year' },
  { id: 'ranked', name: 'RANKED', tagline: 'Sort by TMDb rating' },
];
export function modeMeta(id) { return MODES.find((m) => m.id === id) || null; }
export function isOrderMode(id) { return id === 'timeline' || id === 'ranked'; }

// ---- Difficulty ---------------------------------------------------------------
// { q, n } convention: q = questions, n = options per question / titles per
// sorting round. No ALL tier — meaningless over a ~1,000-title pool.

export const DIFFS = [
  { id: 'easy', name: 'EASY', q: 5, n: 3 },
  { id: 'medium', name: 'MEDIUM', q: 10, n: 4 },
  { id: 'hard', name: 'HARD', q: 15, n: 6 },
  { id: 'marathon', name: 'MARATHON', q: 25, n: 8 },
];
export function diffMeta(id) { return DIFFS.find((d) => d.id === id) || null; }

export const ORDER_ROUNDS = 5;   // max sorting rounds
export const MIN_POOL = 12;      // fewer filtered titles than this → can't start

// How many questions/rounds a mode+difficulty produces for a pool of this
// size — used by the UI to tell the player what their choice will do.
export function roundsFor(mode, diff, poolLen) {
  const { n = 0, q = 0 } = diff || {};
  if (isOrderMode(mode)) return Math.min(ORDER_ROUNDS, Math.floor(poolLen / Math.min(n, poolLen)) || 1);
  return Math.min(q, poolLen);
}

// ---- Seeded RNG ----------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleWith(rand, array) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const pickFrom = (rand, arr) => arr[Math.floor(rand() * arr.length)];

// ---- The question bank ---------------------------------------------------------
// Each category: { id, ok(item): can this item host the question?,
//   build(item, ctx): question or null }. ctx = { rand, n, pool, items, others() }.
// A question: { cat, prompt, quote?, options: [text…], answer: idx, fact }.
// `quote` renders as the big quoted text (taglines/plots); `fact` is the
// learning line shown on the reveal.
//
// Distractor rules that keep questions FAIR:
//   - numeric distractors are near the truth but never equal;
//   - "highest/most" picks need a clear margin over every distractor;
//   - reverse people-lookups exclude titles that also feature the person;
//   - title options never include duplicate display titles.

const isMovie = (it) => it.t === 'm';
const noun = (it) => (isMovie(it) ? 'film' : 'show');
const factOf = (it) => {
  const who = it.director ? `dir. ${it.director}` : it.creator ? `created by ${it.creator}` : null;
  return [String(it.year), who].filter(Boolean).join(' · ');
};

// n-1 distinct distractor titles (excluding `not`), by pool order already
// shuffled per-round; `extra` filters candidates further.
function titleOptions(ctx, answerId, extra = null) {
  const { rand, n, pool, items } = ctx;
  const seen = new Set([items[answerId].title]);
  const out = [answerId];
  for (const id of shuffleWith(rand, pool)) {
    if (out.length >= n) break;
    if (id === answerId) continue;
    const it = items[id];
    if (seen.has(it.title)) continue;
    if (extra && !extra(it, id)) continue;
    seen.add(it.title);
    out.push(id);
  }
  if (out.length < 2) return null;
  return shuffleWith(rand, out);
}

// Distinct numeric distractors near `truth`; step picks the granularity.
function numberOptions(rand, n, truth, step, min = 1) {
  const opts = new Set([truth]);
  let guard = 0;
  while (opts.size < n && guard++ < 60) {
    const delta = (1 + Math.floor(rand() * 4)) * step * (rand() < 0.5 ? -1 : 1);
    const v = Math.max(min, truth + delta);
    if (v !== truth) opts.add(v);
  }
  return shuffleWith(rand, [...opts]);
}

function fromTitles(ctx, ids, answerId, prompt, quote, fact) {
  if (!ids) return null;
  const { items } = ctx;
  return {
    prompt, quote,
    options: ids.map((id) => items[id].title),
    answer: ids.indexOf(answerId),
    fact,
  };
}

export const CATEGORIES = [
  {
    id: 'tagline',
    ok: (it) => !!it.tagline,
    build(it, ctx) {
      const ids = titleOptions(ctx, ctx.id, (o) => o.tagline !== it.tagline);
      return fromTitles(ctx, ids, ctx.id, `Whose tagline is this?`, `“${it.tagline}”`, `${it.title} — ${factOf(it)}`);
    },
  },
  {
    id: 'plot',
    ok: (it) => !!it.plot,
    build(it, ctx) {
      // Mask the title inside its own plot so it never gives itself away.
      const masked = it.plot.replace(new RegExp(it.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '___');
      const ids = titleOptions(ctx, ctx.id);
      return fromTitles(ctx, ids, ctx.id, `Which ${noun(it)} is this?`, masked, `${it.title} — ${factOf(it)}`);
    },
  },
  {
    id: 'director',
    ok: (it) => !!it.director,
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const names = new Set([it.director]);
      for (const id of shuffleWith(rand, pool)) {
        if (names.size >= n) break;
        const d = items[id].director;
        if (d) names.add(d);
      }
      if (names.size < 2) return null;
      const options = shuffleWith(rand, [...names]);
      return { prompt: `Who directed ${it.title}?`, options, answer: options.indexOf(it.director), fact: `${it.title} — ${factOf(it)}` };
    },
  },
  {
    id: 'revdirector',
    ok: (it) => !!it.director,
    build(it, ctx) {
      const ids = titleOptions(ctx, ctx.id, (o) => o.director !== it.director);
      return fromTitles(ctx, ids, ctx.id, `Which film did ${it.director} direct?`, null, `${it.title} — ${it.year}`);
    },
  },
  {
    id: 'creator',
    ok: (it) => !!it.creator,
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const names = new Set([it.creator]);
      for (const id of shuffleWith(rand, pool)) {
        if (names.size >= n) break;
        const c = items[id].creator || items[id].director;
        if (c) names.add(c);
      }
      if (names.size < 2) return null;
      const options = shuffleWith(rand, [...names]);
      return { prompt: `Who created ${it.title}?`, options, answer: options.indexOf(it.creator), fact: `${it.title} — ${factOf(it)}` };
    },
  },
  {
    id: 'star',
    ok: (it) => it.cast?.length >= 1,
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const star = pickFrom(rand, it.cast);
      const names = new Set([star]);
      for (const id of shuffleWith(rand, pool)) {
        if (names.size >= n) break;
        if (id === ctx.id) continue;
        // First cast member of the other title who ISN'T also in this one.
        const c = (items[id].cast || []).find((x) => !it.cast.includes(x));
        if (c) names.add(c);
      }
      if (names.size < 2) return null;
      const options = shuffleWith(rand, [...names]);
      return { prompt: `Who stars in ${it.title}?`, options, answer: options.indexOf(star), fact: `${it.title} — ${factOf(it)}` };
    },
  },
  {
    id: 'revstar',
    ok: (it) => it.cast?.length >= 1,
    build(it, ctx) {
      const star = pickFrom(ctx.rand, it.cast);
      const ids = titleOptions(ctx, ctx.id, (o) => !(o.cast || []).includes(star));
      return fromTitles(ctx, ids, ctx.id, `Which ${noun(it)} stars ${star}?`, null, `${it.title} — ${factOf(it)}`);
    },
  },
  {
    id: 'year',
    ok: () => true,
    build(it, ctx) {
      const options = numberOptions(ctx.rand, ctx.n, it.year, 1, 1900).map(String);
      return { prompt: `What year did ${it.title} ${isMovie(it) ? 'come out' : 'first air'}?`, options, answer: options.indexOf(String(it.year)), fact: `${it.title} — ${factOf(it)}` };
    },
  },
  {
    id: 'runtime',
    ok: (it) => it.runtime > 0,
    build(it, ctx) {
      const step = it.runtime >= 100 ? 15 : 10;
      const options = numberOptions(ctx.rand, ctx.n, it.runtime, step, 15).map((v) => `${v} min`);
      const what = isMovie(it) ? `How long is ${it.title}?` : `How long is a typical ${it.title} episode?`;
      return { prompt: what, options, answer: options.indexOf(`${it.runtime} min`), fact: `${it.title} — ${it.runtime} min` };
    },
  },
  {
    id: 'genre',
    ok: (it) => it.genres?.length >= 1,
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const truth = pickFrom(rand, it.genres);
      const wrong = new Set();
      for (const id of shuffleWith(rand, pool)) {
        for (const g of items[id].genres || []) {
          if (wrong.size >= n - 1) break;
          if (!it.genres.includes(g)) wrong.add(g);
        }
      }
      if (!wrong.size) return null;
      const options = shuffleWith(rand, [truth, ...wrong]);
      return { prompt: `Which of these genres fits ${it.title}?`, options, answer: options.indexOf(truth), fact: `${it.title} — ${it.genres.join(' / ')}` };
    },
  },
  {
    id: 'studio',
    ok: (it) => !!it.studio,
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const names = new Set([it.studio]);
      for (const id of shuffleWith(rand, pool)) {
        if (names.size >= n) break;
        const s = items[id].studio;
        if (s) names.add(s);
      }
      if (names.size < 2) return null;
      const options = shuffleWith(rand, [...names]);
      const what = isMovie(it) ? `Which studio made ${it.title}?` : `Which network/service made ${it.title}?`;
      return { prompt: what, options, answer: options.indexOf(it.studio), fact: `${it.title} — ${it.studio}` };
    },
  },
  {
    id: 'country',
    ok: (it) => !!it.country, // the builder only sets country for non-US titles
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const names = new Set([it.country]);
      const extras = ['United States', 'United Kingdom', 'France', 'Japan', 'South Korea', 'Germany', 'Italy', 'Spain', 'Brazil', 'India'];
      for (const id of shuffleWith(rand, pool)) {
        if (names.size >= n) break;
        const c = items[id].country;
        if (c) names.add(c);
      }
      for (const c of shuffleWith(rand, extras)) {
        if (names.size >= n) break;
        names.add(c);
      }
      const options = shuffleWith(rand, [...names]);
      return { prompt: `Which country is ${it.title} from?`, options, answer: options.indexOf(it.country), fact: `${it.title} — ${it.country}` };
    },
  },
  {
    id: 'origtitle',
    ok: (it) => !!it.orig,
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const opts = new Set([it.orig]);
      for (const id of shuffleWith(rand, pool)) {
        if (opts.size >= n) break;
        const o = items[id].orig;
        if (o) opts.add(o);
      }
      if (opts.size < 2) return null;
      const options = shuffleWith(rand, [...opts]);
      return { prompt: `What is the original title of ${it.title}?`, options, answer: options.indexOf(it.orig), fact: `${it.title} (${it.orig}) — ${factOf(it)}` };
    },
  },
  {
    id: 'seasons',
    ok: (it) => it.seasons > 0,
    build(it, ctx) {
      const options = numberOptions(ctx.rand, Math.min(ctx.n, 4), it.seasons, 1, 1).map(String);
      return { prompt: `How many seasons of ${it.title} are there?`, options, answer: options.indexOf(String(it.seasons)), fact: `${it.title} — ${it.seasons} season${it.seasons === 1 ? '' : 's'}` };
    },
  },
  {
    id: 'ratingpick',
    ok: (it) => it.rating > 0,
    build(it, ctx) {
      // "Which is rated highest?" — the answer must beat every distractor by a
      // clear margin so it's knowledge, not a coin flip.
      const { rand, n, pool, items } = ctx;
      const ids = [ctx.id];
      for (const id of shuffleWith(rand, pool)) {
        if (ids.length >= n) break;
        const o = items[id];
        if (id !== ctx.id && o.rating > 0 && it.rating - o.rating >= 0.4) ids.push(id);
      }
      if (ids.length < Math.min(n, 3)) return null;
      const order = shuffleWith(rand, ids);
      return {
        prompt: 'Which of these is rated highest on TMDb?',
        options: order.map((id) => items[id].title),
        answer: order.indexOf(ctx.id),
        fact: `${it.title} — ${it.rating.toFixed(1)} on TMDb`,
      };
    },
  },
  {
    id: 'revenuepick',
    ok: (it) => it.revenue > 0,
    build(it, ctx) {
      const { rand, n, pool, items } = ctx;
      const ids = [ctx.id];
      for (const id of shuffleWith(rand, pool)) {
        if (ids.length >= n) break;
        const o = items[id];
        if (id !== ctx.id && o.revenue > 0 && it.revenue >= o.revenue * 1.5) ids.push(id);
      }
      if (ids.length < Math.min(n, 3)) return null;
      const order = shuffleWith(rand, ids);
      return {
        prompt: 'Which of these made the most at the box office?',
        options: order.map((id) => items[id].title),
        answer: order.indexOf(ctx.id),
        fact: `${it.title} — ${fmtMoney(it.revenue)} worldwide`,
      };
    },
  },
];

export function fmtMoney(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`;
  return `$${n.toLocaleString()}`;
}

export const MODE_CATS = {
  mixed: CATEGORIES.map((c) => c.id),
  plotlines: ['tagline', 'plot'],
  casting: ['director', 'revdirector', 'creator', 'star', 'revstar'],
  details: ['year', 'runtime', 'genre', 'studio', 'country', 'origtitle', 'seasons', 'ratingpick', 'revenuepick'],
};

// ---- Round builders --------------------------------------------------------------
// Pick modes → [{ cat, prompt, quote?, options, answer, fact }] — q questions,
// each on a distinct title, category seeded per title from the mode's list.
// Order modes → [{ ids }] — n titles per round, ORDER_ROUNDS max, no repeats.

export function buildRounds(mode, diff, poolIds, seed, items) {
  const rand = mulberry32(seed);
  // Sorted before the seeded shuffle: pool order must not depend on caller
  // iteration quirks (the determinism contract).
  const pool = shuffleWith(rand, poolIds.slice().sort());
  const { n = 0, q = 0 } = diff || {};

  if (isOrderMode(mode)) {
    const size = Math.min(n, pool.length);
    const count = Math.min(ORDER_ROUNDS, Math.floor(pool.length / size) || 1);
    // Prefer titles with DISTINCT sort-keys within a round (distinct years for
    // TIMELINE, distinct ratings for RANKED) so there's an unambiguous correct
    // order. When the pool can't supply enough distinct keys (small pools;
    // ratings collide often), fall back to any unused title — gradeOrder treats
    // equal keys as interchangeable, so a tie still grades either way.
    const rounds = [];
    const used = new Set();
    for (let r = 0; r < count; r++) {
      const ids = [];
      const keys = new Set();
      for (const id of pool) {
        if (ids.length >= size) break;
        if (used.has(id)) continue;
        const k = orderKey(mode, items[id]);
        if (keys.has(k)) continue;
        ids.push(id); keys.add(k); used.add(id);
      }
      for (const id of pool) { // fill any shortfall, allowing duplicate keys
        if (ids.length >= size) break;
        if (used.has(id)) continue;
        ids.push(id); used.add(id);
      }
      rounds.push({ ids });
    }
    return rounds;
  }

  const catIds = MODE_CATS[mode] || MODE_CATS.mixed;
  const cats = CATEGORIES.filter((c) => catIds.includes(c.id));
  const rounds = [];
  for (const id of pool) {
    if (rounds.length >= q) break;
    const it = items[id];
    const usable = cats.filter((c) => c.ok(it));
    if (!usable.length) continue;
    // Try seeded-shuffled categories until one builds a valid question for
    // this title (some need distractors the pool can't always provide).
    for (const cat of shuffleWith(rand, usable)) {
      const question = cat.build(it, { id, rand, n, pool, items });
      if (question) { rounds.push({ cat: cat.id, id, ...question }); break; }
    }
  }
  return rounds;
}

// ---- Ordering keys + grading -------------------------------------------------------

export function orderKey(mode, item) {
  return mode === 'timeline' ? item.year : item.rating;
}

export function expectedOrder(mode, ids, items) {
  return ids.slice().sort((a, b) => {
    const ka = orderKey(mode, items[a]), kb = orderKey(mode, items[b]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// A slot is correct when its key equals the key expected at that slot — equal
// values (same year, same rating) are interchangeable rather than punished.
export function gradeOrder(mode, placed, items) {
  const expected = expectedOrder(mode, placed, items);
  return placed.map((id, i) => orderKey(mode, items[id]) === orderKey(mode, items[expected[i]]));
}

// ---- Results / ranking ----------------------------------------------------------------
// result: { outcomes, score, total, ms }. Score desc, then time asc, all modes.

export function scoreOf(result) { return result ? (Number(result.score) || 0) : 0; }

export function compareResults(a, b) {
  const missing = (x) => (x ? 0 : 1);
  if (missing(a) || missing(b)) return missing(a) - missing(b);
  return (scoreOf(b) - scoreOf(a)) || (a.ms - b.ms);
}

export function rankSeats(results, seats) {
  const list = [];
  for (let s = 0; s < seats; s++) list.push(s);
  return list.sort((a, b) => compareResults(results[a], results[b]) || a - b);
}

export function winnerSeat(results, seats) {
  if (seats <= 1) return 0;
  const ranked = rankSeats(results, seats);
  const top = ranked[0];
  if (!results[top]) return 'tie';
  const next = ranked[1];
  // A draw is an equal SCORE — time only breaks ties for list order, it doesn't
  // decide the winner (otherwise an equal-score game is never a draw).
  if (next != null && results[next] && scoreOf(results[top]) === scoreOf(results[next])) return 'tie';
  return top;
}
