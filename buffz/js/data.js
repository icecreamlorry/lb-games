// Title data loader + the filter model. There is no fixed "set" list — the
// host narrows the pool with three dropdowns (type / decade / genre), and the
// playable pool is derived here, identically on every seat.

import { MIN_POOL } from './engine.js';

let cache = null;

export async function loadData() {
  if (!cache) {
    cache = fetch(new URL('../data/titles.json', import.meta.url))
      .then((r) => { if (!r.ok) throw new Error(`Could not load title data (${r.status})`); return r.json(); })
      .catch((e) => { cache = null; throw e; });
  }
  return cache;
}

// filters: { type: 'all'|'m'|'v', decade: 'all'|'1990s'…, genre: 'all'|name }.
// Returned ids are SORTED — buildRounds relies on a stable pool order before
// its seeded shuffle (the determinism contract).
export function filterIds(data, { type = 'all', decade = 'all', genre = 'all' } = {}) {
  return Object.keys(data.items).filter((id) => {
    const it = data.items[id];
    if (type !== 'all' && it.t !== type) return false;
    if (decade !== 'all' && it.decade !== decade) return false;
    if (genre !== 'all' && !it.genres.includes(genre)) return false;
    return true;
  }).sort();
}

// Dropdown option lists, derived from the data so they never drift from it.
// Only decades with enough titles to actually start a game are offered, so a
// thin bucket never shows as an unplayable dropdown row. "Pre-1930" (the pooled
// silent era) sorts ahead of the numbered decades.
const decadeRank = (d) => (d === 'Pre-1930' ? -1 : parseInt(d, 10));
export function decadeList(data) {
  const counts = {};
  for (const it of Object.values(data.items)) counts[it.decade] = (counts[it.decade] || 0) + 1;
  return Object.keys(counts).filter((d) => counts[d] >= MIN_POOL).sort((a, b) => decadeRank(a) - decadeRank(b));
}
export function genreList(data) {
  return data.genres || [];
}

export const TYPE_LABELS = { all: 'Movies & TV', m: 'Movies', v: 'TV shows' };

export function filterLabel(f) {
  const bits = [TYPE_LABELS[f?.type] || 'Movies & TV'];
  if (f?.decade && f.decade !== 'all') bits.push(f.decade);
  if (f?.genre && f.genre !== 'all') bits.push(f.genre);
  return bits.join(' · ');
}
