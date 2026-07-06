// Atlaz game logic — pure functions, no DOM, no network (unit-tested by
// test/engine.test.mjs under plain node).

// ---- Game modes -------------------------------------------------------------

export const MODES = [
  { id: 'pinpoint', name: 'PINPOINT', tagline: 'See the name, tap the place' },
  { id: 'lineup', name: 'LINE-UP', tagline: 'See the shape, pick the name' },
  { id: 'namedrop', name: 'NAMEDROP', tagline: 'See the shape, type the name' },
  { id: 'jigsaw', name: 'JIGSAW', tagline: 'Drag each piece into place' },
  { id: 'sweep', name: 'SWEEP', tagline: 'Name everything against the clock' },
];

export function modeMeta(id) { return MODES.find((m) => m.id === id) || null; }

// ---- Seeded shuffle ---------------------------------------------------------
// Same seed (the room's) on every client → identical question order.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(array, seed) {
  const rand = mulberry32(seed);
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The shared question order for a room: every seat shuffles the region's item
// ids with the room seed.
export function questionOrder(items, seed) {
  return seededShuffle(items.map((it) => it.id), seed);
}

// ---- Answer matching (NAMEDROP / SWEEP) -------------------------------------

// Lowercase, strip diacritics and punctuation, unify "&"/"and" and "st."/
// "saint", collapse whitespace — so "São Tomé & Príncipe" == "sao tome and
// principe" and "St Kitts" == "Saint Kitts".
export function normalizeAnswer(s) {
  let t = String(s ?? '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')            // d'Ivoire → divoire
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
  t = t.replace(/^st /, 'saint ').replace(/ st /g, ' saint ');
  return t;
}

// normalized answer -> item id (name + all aliases). A second, space-stripped
// index catches dotted/abbreviated typing ("U.S.A." → "u s a" → "usa").
export function buildAnswerIndex(items) {
  const idx = new Map();
  const packed = new Map();
  for (const it of items) {
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

// ---- Jigsaw tolerance --------------------------------------------------------
// A drop counts as correct within max(55% of the piece's own bbox diagonal,
// 5% of the map diagonal) of the piece's true bbox centre — big pieces get
// naturally forgiving targets, tiny pieces a phone-friendly floor.

export function bboxCenter(item) {
  const [x0, y0, x1, y1] = item.bbox;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export function jigsawTolerance(item, mapW, mapH) {
  const [x0, y0, x1, y1] = item.bbox;
  const pieceDiag = Math.hypot(x1 - x0, y1 - y0);
  return Math.max(0.55 * pieceDiag, 0.05 * Math.hypot(mapW, mapH));
}

export function jigsawHit(item, dropX, dropY, mapW, mapH) {
  const [cx, cy] = bboxCenter(item);
  return Math.hypot(dropX - cx, dropY - cy) <= jigsawTolerance(item, mapW, mapH);
}

// ---- Results / ranking -------------------------------------------------------
// A result: { outcomes: [{id, ok, pick?}], ms, foundCount, gaveUp, total }.
// Modes 1–4: score = #correct, tiebreak lower ms. SWEEP: everyone who found
// them all ranks by time; quitters rank below by found count, then time.

export function scoreOf(result) {
  if (!result) return 0;
  if (Array.isArray(result.outcomes) && result.outcomes.length) {
    return result.outcomes.filter((o) => o && o.ok).length;
  }
  return result.foundCount || 0;
}

export function compareResults(mode, a, b) {
  const missing = (x) => (x ? 0 : 1);
  if (missing(a) || missing(b)) return missing(a) - missing(b);
  if (mode === 'sweep') {
    const doneA = !a.gaveUp && a.foundCount >= a.total;
    const doneB = !b.gaveUp && b.foundCount >= b.total;
    if (doneA !== doneB) return doneA ? -1 : 1;
    if (doneA) return a.ms - b.ms;
    return (b.foundCount - a.foundCount) || (a.ms - b.ms);
  }
  return (scoreOf(b) - scoreOf(a)) || (a.ms - b.ms);
}

// results: sparse array/dict seat -> result. Returns seats best-first.
export function rankSeats(mode, results, seats) {
  const list = [];
  for (let s = 0; s < seats; s++) list.push(s);
  return list.sort((a, b) => compareResults(mode, results[a], results[b]) || a - b);
}

// Winner seat for finishRoom: top of the ranking, 'tie' when the runner-up is
// equivalent under the mode's comparator (or nobody submitted anything).
export function winnerSeat(mode, results, seats) {
  if (seats <= 1) return 0;
  const ranked = rankSeats(mode, results, seats);
  const top = ranked[0];
  if (!results[top]) return 'tie';
  const next = ranked[1];
  if (next != null && results[next] && compareResults(mode, results[top], results[next]) === 0) return 'tie';
  return top;
}
