// Atomyx game logic — pure functions, no DOM, no network (unit-tested by
// test/engine.test.mjs under plain node). The seeded round builders are the
// heart of multiplayer fairness: every seat derives identical rounds from the
// room seed.

// ---- Game modes -------------------------------------------------------------

export const MODES = [
  { id: 'pinpoint', name: 'PINPOINT', tagline: 'One name — tap its cell' },
  { id: 'lineup', name: 'LINE-UP', tagline: 'One element — pick its name' },
  { id: 'namedrop', name: 'NAMEDROP', tagline: 'One element — type its name' },
  { id: 'mass', name: 'MASS', tagline: 'Sort by atomic mass' },
  { id: 'sweep', name: 'SWEEP', tagline: 'Type every element from memory' },
  { id: 'build', name: 'BUILD', tagline: 'Place tiles on a blank table' },
];
export function modeMeta(id) { return MODES.find((m) => m.id === id) || null; }
export function isOrderMode(id) { return id === 'mass'; }
export function isTableMode(id) { return id === 'pinpoint' || id === 'build'; }

// ---- Difficulty ---------------------------------------------------------------
// Two knobs per tier so difficulty means something in EVERY mode:
//   q = number of questions (pinpoint/lineup/namedrop/build); 0 = whole set once.
//   n = juggle count — name options (lineup) / cards per sorting round (mass);
//       0 = the whole set.
// SWEEP is inherently the whole set, so difficulty doesn't apply there.

export const DIFFS = [
  { id: 'easy', name: 'EASY', n: 3, q: 5 },
  { id: 'medium', name: 'MEDIUM', n: 6, q: 10 },
  { id: 'hard', name: 'HARD', n: 9, q: 15 },
  { id: 'all', name: 'ALL', n: 0, q: 0 },
];
export function diffMeta(id) { return DIFFS.find((d) => d.id === id) || null; }

export const PICK_ROUNDS = 10;  // medium question count (kept for reference/tests)
export const ORDER_ROUNDS = 5;  // fallback sorting rounds cap (1 when difficulty = all)

// How many questions/rounds a mode+difficulty actually produces for a given set
// size — used by the UI to tell the player what a difficulty will do.
export function roundsFor(mode, diff, setLen) {
  const { n = 0, q = 0 } = diff || {};
  if (mode === 'sweep') return 1;
  if (isOrderMode(mode)) return n ? Math.min(q || ORDER_ROUNDS, Math.floor(setLen / Math.min(n, setLen)) || 1) : 1;
  return q ? Math.min(q, setLen) : setLen;
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

// ---- Round builders --------------------------------------------------------------
// diff = a DIFFS entry { n, q } (see above).
// pick modes → [{ answer, options }] — q questions (0 = whole set once), no
//   repeats; only lineup gets options (n = 0 → every set element is an option).
// mass → [{ ids }] (display order, already shuffled). n = 0 → one round with
//   the whole set; otherwise q sorting rounds of n, capped by how many
//   non-overlapping groups the set yields.
// sweep → [{ ids }] — one round carrying the whole set (order irrelevant).

export function buildRounds(mode, diff, setIds, seed) {
  const rand = mulberry32(seed);
  const pool = shuffleWith(rand, setIds);
  const { n = 0, q = 0 } = diff || {};

  if (mode === 'sweep') return [{ ids: pool.slice() }];

  if (isOrderMode(mode)) {
    if (!n) return [{ ids: pool.slice() }];
    const size = Math.min(n, pool.length);
    const count = Math.min(q || ORDER_ROUNDS, Math.floor(pool.length / size) || 1);
    const rounds = [];
    for (let r = 0; r < count; r++) rounds.push({ ids: pool.slice(r * size, r * size + size) });
    return rounds;
  }

  const count = q ? Math.min(q, pool.length) : pool.length;
  const rounds = [];
  for (let r = 0; r < count; r++) {
    const answer = pool[r];
    if (mode !== 'lineup') { rounds.push({ answer, options: [] }); continue; }
    let options;
    if (!n || n >= setIds.length) {
      options = shuffleWith(rand, setIds);
    } else {
      const distractors = shuffleWith(rand, setIds.filter((c) => c !== answer)).slice(0, n - 1);
      options = shuffleWith(rand, [answer, ...distractors]);
    }
    rounds.push({ answer, options });
  }
  return rounds;
}

// ---- Ordering keys + grading -------------------------------------------------------

// Value used to sort an element in the mass mode (ascending, lightest first).
export function orderKey(mode, element) {
  return element.mass;
}

// The expected arrangement for a round (ascending).
export function expectedOrder(mode, ids, elements) {
  return ids.slice().sort((a, b) => {
    const ka = orderKey(mode, elements[a]), kb = orderKey(mode, elements[b]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// Grade a player's arrangement slot-by-slot. A slot is correct when its key
// equals the key expected at that slot — so equal values are interchangeable
// rather than punished.
export function gradeOrder(mode, placed, elements) {
  const expected = expectedOrder(mode, placed, elements);
  return placed.map((id, i) => orderKey(mode, elements[id]) === orderKey(mode, elements[expected[i]]));
}

// ---- Answer matching (namedrop / sweep) ------------------------------------------

export function normalizeAnswer(s) {
  return String(s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

export function buildAnswerIndex(entries) {
  // entries: [{ id, name, alt }]
  const idx = new Map();
  for (const it of entries) {
    for (const cand of [it.name, ...(it.alt || [])]) {
      const key = normalizeAnswer(cand);
      if (key && !idx.has(key)) idx.set(key, it.id);
    }
  }
  return idx;
}

export function matchAnswer(index, input) {
  return index.get(normalizeAnswer(input)) ?? null;
}

// Symbol lookup for SWEEP ("fe" counts as Iron). Element ids ARE lowercase
// symbols, so this only needs to check membership.
export function matchSymbol(setIds, input) {
  const key = normalizeAnswer(input).replace(/ /g, '');
  return setIds.includes(key) ? key : null;
}

// ---- Results / ranking ----------------------------------------------------------------
// result: { outcomes, score, total, ms }. Score desc, then time asc, all modes.
// This rule ranks SWEEP correctly for free: completers hold the max score, so
// they sit above every quitter and race each other on time.

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
