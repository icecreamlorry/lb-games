// Flagz game logic — pure functions, no DOM, no network (unit-tested by
// test/engine.test.mjs under plain node). The seeded round builders are the
// heart of multiplayer fairness: every seat derives identical rounds from the
// room seed.

// ---- Game modes -------------------------------------------------------------

export const MODES = [
  { id: 'spotter', name: 'SPOTTER', tagline: 'One name — tap its flag' },
  { id: 'lineup', name: 'LINE-UP', tagline: 'One flag — pick its country' },
  { id: 'namedrop', name: 'NAMEDROP', tagline: 'One flag — type its country' },
  { id: 'atoz', name: 'A TO Z', tagline: 'Sort flags alphabetically, blind' },
  { id: 'headcount', name: 'HEADCOUNT', tagline: 'Sort flags by population' },
  { id: 'landmass', name: 'LANDMASS', tagline: 'Sort flags by area' },
];
export function modeMeta(id) { return MODES.find((m) => m.id === id) || null; }
export function isOrderMode(id) { return id === 'atoz' || id === 'headcount' || id === 'landmass'; }

// ---- Difficulty ---------------------------------------------------------------
// n = options shown (pick modes) / flags per sorting round. 0 = the whole region.

export const DIFFS = [
  { id: 'easy', name: 'EASY', n: 3 },
  { id: 'medium', name: 'MEDIUM', n: 6 },
  { id: 'hard', name: 'HARD', n: 9 },
  { id: 'all', name: 'ALL', n: 0 },
];
export function diffMeta(id) { return DIFFS.find((d) => d.id === id) || null; }

export const PICK_ROUNDS = 10;  // questions per game in spotter/lineup/namedrop
export const ORDER_ROUNDS = 5;  // sorting rounds (1 when difficulty = all)

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
// pick modes → [{ answer, options }] (options shuffled, contain answer;
//   namedrop gets no options). n = 0 → every region flag is an option.
// order modes → [{ ids }] (display order, already shuffled). n = 0 → one round
//   with the whole region.

export function buildRounds(mode, diffN, regionIso, seed) {
  const rand = mulberry32(seed);
  const pool = shuffleWith(rand, regionIso);

  if (isOrderMode(mode)) {
    if (!diffN) return [{ ids: pool.slice() }];
    const n = Math.min(diffN, pool.length);
    const count = Math.min(ORDER_ROUNDS, Math.floor(pool.length / n) || 1);
    const rounds = [];
    for (let r = 0; r < count; r++) rounds.push({ ids: pool.slice(r * n, r * n + n) });
    return rounds;
  }

  const count = Math.min(PICK_ROUNDS, pool.length);
  const rounds = [];
  for (let r = 0; r < count; r++) {
    const answer = pool[r];
    if (mode === 'namedrop') { rounds.push({ answer, options: [] }); continue; }
    let options;
    if (!diffN || diffN >= regionIso.length) {
      options = shuffleWith(rand, regionIso);
    } else {
      const distractors = shuffleWith(rand, regionIso.filter((c) => c !== answer)).slice(0, diffN - 1);
      options = shuffleWith(rand, [answer, ...distractors]);
    }
    rounds.push({ answer, options });
  }
  return rounds;
}

// ---- Ordering keys + grading -------------------------------------------------------

// Value used to sort a country in each order mode. atoz sorts on the display
// name (case/diacritic-insensitive); headcount/landmass ascending numerics.
export function orderKey(mode, country) {
  if (mode === 'atoz') return normalizeAnswer(country.name);
  if (mode === 'headcount') return country.pop;
  return country.area;
}

// The expected arrangement for a round (ascending; A first for atoz).
export function expectedOrder(mode, ids, countries) {
  return ids.slice().sort((a, b) => {
    const ka = orderKey(mode, countries[a]), kb = orderKey(mode, countries[b]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// Grade a player's arrangement slot-by-slot. A slot is correct when its key
// equals the key expected at that slot — so equal values (rare pop/area ties)
// are interchangeable rather than punished.
export function gradeOrder(mode, placed, countries) {
  const expected = expectedOrder(mode, placed, countries);
  return placed.map((id, i) => orderKey(mode, countries[id]) === orderKey(mode, countries[expected[i]]));
}

// ---- Answer matching (namedrop) ------------------------------------------------------

export function normalizeAnswer(s) {
  let t = String(s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
  t = t.replace(/^st /, 'saint ').replace(/ st /g, ' saint ');
  t = t.replace(/^the /, ''); // "the bahamas" == "bahamas"
  return t;
}

export function buildAnswerIndex(entries) {
  // entries: [{ id, name, alt }]
  const idx = new Map();
  const packed = new Map();
  for (const it of entries) {
    for (const cand of [it.name, ...(it.alt || [])]) {
      const key = normalizeAnswer(cand);
      if (!key) continue;
      if (!idx.has(key)) idx.set(key, it.id);
      const p = key.replace(/ /g, '');
      if (!packed.has(p)) packed.set(p, it.id);
    }
  }
  idx.packed = packed;
  return idx;
}

export function matchAnswer(index, input) {
  const key = normalizeAnswer(input);
  return index.get(key) ?? index.packed?.get(key.replace(/ /g, '')) ?? null;
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
  if (next != null && results[next] && compareResults(results[top], results[next]) === 0) return 'tie';
  return top;
}
