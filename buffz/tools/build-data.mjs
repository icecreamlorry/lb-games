// BUFFZ data builder — pulls the playable pool from TMDb with STRATIFIED
// coverage so every decade and every genre is well-stocked.
//
//   TMDB_API_KEY=xxxxx node buffz/tools/build-data.mjs
//
// NOTE: api.themoviedb.org is NOT reachable from the LB Games dev sandbox
// (proxy 403) — run this on a normal machine, then commit the regenerated
// buffz/data/titles.json. A free key comes from themoviedb.org → Settings →
// API (v3 "API Key" or v4 "Read Access Token" — both accepted).
//
// WHY STRATIFIED: a single vote_count.desc pull is recency-biased (vote count
// tracks how many modern TMDb users rated a title), so old decades and niche
// genres starve — the first cut had 1 film in the 1930s and 3 documentaries.
// Instead we run a SEPARATE vote_count.desc query per decade and per genre,
// take the top ~QUOTA of each, and union them with a global popularity
// backbone. The top-100-by-votes WITHIN the 1970s is that decade's best-known
// set even though those films trail a random modern blockbuster globally.
//
// The trade-off is deliberate: filling old/niche buckets necessarily pulls in
// less-famous titles, so the unfiltered pool skews a little deeper. Turn the
// QUOTA knobs down to tighten it, up to broaden it. Buckets TMDb can't fill to
// the quota are reported so you can see the real ceiling (the 1930s genuinely
// doesn't have 100 films most people know).
//
// Output shape (buffz/data/titles.json) — see PLAN.md §2. No images, no LLM;
// questions are seeded templates over this checked-in data. TMDb attribution
// is shown in the game's help modal.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'data', 'titles.json');

// ---- Tunables ----------------------------------------------------------------
const DECADE_QUOTA = 115;   // movies to pull per decade bucket (>100 for headroom)
const GENRE_QUOTA = 130;    // movies to pull per genre bucket
const GLOBAL_MOVIES = 600;  // popularity backbone so famous modern films aren't capped
const TV_COUNT = 350;       // TV shows (single vote_count.desc pull; the ask is movies)
const MIN_VOTES = 25;       // skip literal noise in bucket queries
const FIRST_DECADE = 1930;  // decades below this are grouped into one "Pre-1930" bucket
const PRE1930_QUOTA = 24;   // silent-era classics grouped as "Pre-1930" (own bucket)
const GOAL = 100;           // report buckets that fall short of this

// Deepen the filmographies of directors ALREADY in the pool, so the casting
// cross-reference questions ("which film directed by X also stars Y", "which
// came out first") — which need 3+ films by one director — have more to draw
// on. Knobs (tune from the "deepened" line the report prints):
const DEEPEN_TRIGGER = 2;    // only deepen directors with at least this many pool films
const DEEPEN_CAP = 8;        // bring each such director up to at most this many films
const DEEPEN_MIN_VOTES = 400;// notability floor for an ADDED film — a famous director's
                             //   whole catalogue clears it; a one-hit director's doesn't,
                             //   so we don't pad the pool with obscure titles

const PAGE = 20; // TMDb page size (fixed)

// TMDb TV genres use combined names — normalize onto the movie vocabulary so
// one GENRE dropdown covers both types.
const TV_GENRE_MAP = {
  'Action & Adventure': ['Action', 'Adventure'],
  'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'],
  'War & Politics': ['War'],
  'Kids': ['Family'],
  'Soap': ['Drama'],
  'News': [], 'Talk': [], 'Reality': [], // not quiz material as genres
};

// Genres that don't make good "guess the genre" material even when present.
const SKIP_GENRES = new Set(['TV Movie']);

// ---- TMDb client -------------------------------------------------------------

function makeClient(key) {
  const v4 = key.length > 60; // v4 read tokens are long JWTs; v3 keys are 32 hex chars
  return async function tmdb(path, params = {}) {
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!v4) url.searchParams.set('api_key', key);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, v4 ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
      if (res.status === 429 && attempt < 6) {
        const wait = Number(res.headers.get('retry-after')) || 2;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`TMDb ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      return res.json();
    }
  };
}

// ---- Discovery (stratified) --------------------------------------------------

// Page a /discover query (already sorted by vote_count.desc) until we have
// `quota` distinct ids or the results run out. `seen` lets callers dedupe
// across buckets while still filling each bucket to its quota.
export async function discoverBucket(tmdb, kind, quota, extra = {}, seen = new Set()) {
  const ids = [];
  const maxPages = Math.min(500, Math.ceil(quota / PAGE) + 8); // headroom for dupes
  for (let page = 1; ids.length < quota && page <= maxPages; page++) {
    const d = await tmdb(`/discover/${kind}`, { sort_by: 'vote_count.desc', include_adult: 'false', page, ...extra });
    if (!d.results?.length) break;
    for (const r of d.results) {
      if (ids.length >= quota) break;
      if (!seen.has(r.id)) { ids.push(r.id); }
    }
    if (page >= (d.total_pages || 1)) break;
  }
  return ids;
}

const decadeRanges = (firstDecade, thisYear) => {
  const out = [];
  for (let y = firstDecade; y <= thisYear; y += 10) out.push([y, Math.min(y + 9, thisYear)]);
  return out;
};

// Build the union of movie ids: a global backbone + per-decade + per-genre
// quota buckets. Returns { ids, coverage } where coverage reports how many the
// stratified buckets actually reached (so shortfalls are visible).
export async function collectMovieIds(tmdb, genres, { today = new Date() } = {}) {
  const thisYear = today.getFullYear();
  const ids = new Set();
  const coverage = { decades: {}, genres: {} };

  // 1. Global popularity backbone (keeps famous modern films from being capped
  //    at a single decade's quota).
  for (const id of await discoverBucket(tmdb, 'movie', GLOBAL_MOVIES, {
    'primary_release_date.lte': today.toISOString().slice(0, 10),
  })) ids.add(id);

  // 2a. The silent era, pooled into one "Pre-1930" bucket (too few well-known
  //     films per individual pre-1930 decade to stand alone).
  {
    const got = await discoverBucket(tmdb, 'movie', PRE1930_QUOTA, {
      'primary_release_date.lte': `${FIRST_DECADE - 1}-12-31`,
      'vote_count.gte': MIN_VOTES,
    });
    for (const id of got) ids.add(id);
    coverage.decades['Pre-1930'] = got.length;
  }

  // 2b. Per-decade quotas — each bucket fills toward its own target regardless
  //     of what the backbone already grabbed, so old decades get their depth.
  for (const [start, end] of decadeRanges(FIRST_DECADE, thisYear)) {
    const got = await discoverBucket(tmdb, 'movie', DECADE_QUOTA, {
      'primary_release_date.gte': `${start}-01-01`,
      'primary_release_date.lte': `${end}-12-31`,
      'vote_count.gte': MIN_VOTES,
    });
    for (const id of got) ids.add(id);
    coverage.decades[`${start}s`] = got.length;
  }

  // 3. Per-genre quotas — union on top; the rare genres (Western, Documentary,
  //    Music, History) are the ones this rescues.
  for (const g of genres) {
    if (SKIP_GENRES.has(g.name)) continue;
    const got = await discoverBucket(tmdb, 'movie', GENRE_QUOTA, {
      with_genres: g.id,
      'vote_count.gte': MIN_VOTES,
      'primary_release_date.lte': today.toISOString().slice(0, 10),
    });
    for (const id of got) ids.add(id);
    coverage.genres[g.name] = got.length;
  }

  return { ids: [...ids], coverage };
}

// Given the directors already in the pool ({ id, name, have } — `have` = films
// they already have), pull each one's full directing filmography and return the
// ids of extra films worth adding. Fairness/quality rules:
//   - only directors with >= `trigger` pool films (they're vetted as notable);
//   - only their `job === 'Director'` credits (not writing/producing);
//   - only films clearing `minVotes` (the obscurity gate);
//   - at most `cap` films per director total, taking their highest-voted first;
//   - never re-add a film already in `seen`.
export async function collectDirectorFilms(tmdb, directors, {
  seen = new Set(), minVotes = DEEPEN_MIN_VOTES, cap = DEEPEN_CAP, trigger = DEEPEN_TRIGGER,
} = {}) {
  const add = new Set();
  const coverage = {};
  // Deepest-first, so the cap budget favours directors we already lean on.
  for (const dir of directors.slice().sort((a, b) => b.have - a.have)) {
    if (dir.have < trigger) continue;
    let credits;
    try { credits = await tmdb(`/person/${dir.id}/movie_credits`); }
    catch { continue; }
    const directed = (credits.crew || [])
      .filter((c) => c.job === 'Director' && (c.vote_count || 0) >= minVotes && c.release_date)
      .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
    let room = Math.max(0, cap - dir.have);
    let added = 0;
    for (const c of directed) {
      if (room <= 0) break;
      if (seen.has(c.id) || add.has(c.id)) continue;
      add.add(c.id); room--; added++;
    }
    if (added) coverage[dir.name] = { have: dir.have, added };
  }
  return { ids: [...add], coverage };
}

// ---- Detail fetch (concurrency pool) -----------------------------------------

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      if (idx % 100 === 0) process.stdout.write(`  ${idx}/${items.length}\r`);
    }
  }));
  return out;
}

// ---- Normalization (pure — unit tested) --------------------------------------

export function firstSentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).slice(0, 220);
}

// Everything before FIRST_DECADE collapses into one "Pre-1930" bucket — there
// aren't enough well-known films per individual pre-1930 decade to play, but
// pooled together the silent era makes a fun playable category.
export function decadeOf(year) { return year < FIRST_DECADE ? 'Pre-1930' : `${Math.floor(year / 10) * 10}s`; }

export function buildMovie(d) {
  const year = Number((d.release_date || '').slice(0, 4));
  if (!year || !d.title) return null;
  const cast = (d.credits?.cast || []).slice(0, 3).map((c) => c.name);
  const director = (d.credits?.crew || []).find((c) => c.job === 'Director')?.name;
  const genres = (d.genres || []).map((g) => g.name).filter((g) => !SKIP_GENRES.has(g));
  if (!genres.length) return null; // genre is a core field (filter + a question category)
  const countries = (d.production_countries || []).map((c) => c.name);
  const item = {
    t: 'm',
    title: d.title,
    year, decade: decadeOf(year),
    genres,
    cast,
    rating: Math.round(d.vote_average * 10) / 10,
    votes: d.vote_count,
  };
  if (d.original_title && d.original_title !== d.title) item.orig = d.original_title;
  if (d.runtime > 0) item.runtime = d.runtime;
  if (d.tagline) item.tagline = d.tagline;
  const plot = firstSentence(d.overview);
  if (plot) item.plot = plot;
  if (director) item.director = director;
  const studio = (d.production_companies || [])[0]?.name;
  if (studio) item.studio = studio;
  if (countries.length && !countries.includes('United States of America')) item.country = countries[0];
  if (d.revenue > 0) item.revenue = d.revenue;
  return item;
}

export function buildTv(d) {
  const year = Number((d.first_air_date || '').slice(0, 4));
  if (!year || !d.name) return null;
  const cast = (d.credits?.cast || []).slice(0, 3).map((c) => c.name);
  const creator = (d.created_by || [])[0]?.name;
  const genres = [...new Set((d.genres || []).flatMap((g) => TV_GENRE_MAP[g.name] ?? [g.name]))];
  if (!genres.length) return null; // e.g. pure Reality/News/Talk — not quiz material
  const countries = (d.production_countries || []).map((c) => c.name);
  const item = {
    t: 'v',
    title: d.name,
    year, decade: decadeOf(year),
    genres,
    cast,
    rating: Math.round(d.vote_average * 10) / 10,
    votes: d.vote_count,
  };
  if (d.original_name && d.original_name !== d.name) item.orig = d.original_name;
  const ep = (d.episode_run_time || [])[0];
  if (ep > 0) item.runtime = ep;
  if (d.tagline) item.tagline = d.tagline;
  const plot = firstSentence(d.overview);
  if (plot) item.plot = plot;
  if (creator) item.creator = creator;
  const studio = (d.networks || [])[0]?.name;
  if (studio) item.studio = studio;
  if (countries.length && !countries.includes('United States of America')) item.country = countries[0];
  if (d.number_of_seasons > 0) item.seasons = d.number_of_seasons;
  return item;
}

// Disambiguate same-title films/shows (remakes: "The Lion King" 1994 vs 2019)
// by appending the year, so option buttons are never duplicated and prompts
// like "Who directed The Mummy?" aren't ambiguous. Needs only the year, which
// every item already has — so it also works as a one-time fix on existing data
// without re-fetching. Mutates `items` in place and returns it. If two share
// BOTH title and year (rare on TMDb), the lower-voted one is dropped.
export function disambiguate(items) {
  const byTitle = new Map();
  for (const [id, it] of Object.entries(items)) {
    if (!byTitle.has(it.title)) byTitle.set(it.title, []);
    byTitle.get(it.title).push(id);
  }
  for (const [title, ids] of byTitle) {
    if (ids.length < 2) continue;
    const seenYear = new Map();
    for (const id of ids) {
      const it = items[id];
      const disp = `${title} (${it.year})`;
      const clash = seenYear.get(disp);
      if (clash) {
        // Same title AND year — keep the more-voted, drop the other.
        if ((it.votes || 0) > (items[clash].votes || 0)) { delete items[clash]; seenYear.set(disp, id); }
        else { delete items[id]; continue; }
      } else {
        seenYear.set(disp, id);
      }
      items[id].title = disp;
    }
  }
  return items;
}

// Genres worth offering in the dropdown: enough titles to actually play.
export function genreDropdown(items, min = 20) {
  const counts = {};
  for (const it of Object.values(items)) for (const g of it.genres) counts[g] = (counts[g] || 0) + 1;
  return Object.keys(counts).filter((g) => counts[g] >= min).sort();
}

// ---- Main --------------------------------------------------------------------

async function main() {
  const KEY = process.env.TMDB_API_KEY;
  if (!KEY) {
    console.error('Set TMDB_API_KEY (v3 key or v4 read token) — free from themoviedb.org → Settings → API.');
    process.exit(1);
  }
  const tmdb = makeClient(KEY);

  const genres = (await tmdb('/genre/movie/list')).genres; // [{ id, name }]
  console.log(`stratified movie pull: global ${GLOBAL_MOVIES} + ${DECADE_QUOTA}/decade + ${GENRE_QUOTA}/genre…`);
  const { ids: movieIds, coverage } = await collectMovieIds(tmdb, genres);
  console.log(`\n${movieIds.length} distinct movies selected across buckets.`);

  console.log(`discovering top ${TV_COUNT} TV shows…`);
  const tvIds = await discoverBucket(tmdb, 'tv', TV_COUNT, {
    'first_air_date.lte': new Date().toISOString().slice(0, 10),
  });

  console.log('fetching details…');
  const rawMovies = await mapPool(movieIds, 8, (id) => tmdb(`/movie/${id}`, { append_to_response: 'credits' }).catch(() => null));
  const movies = rawMovies.map((d) => (d ? buildMovie(d) : null));
  const shows = await mapPool(tvIds, 8, (id) => tmdb(`/tv/${id}`, { append_to_response: 'credits' }).then(buildTv).catch(() => null));

  // Deepen the directors we already have, so the casting cross-reference
  // questions have fuller filmographies to draw on. Capture each director's
  // TMDb person-id from the details we just fetched, count their pool films,
  // pull their catalogue and fold in extra notable films.
  const dirMap = new Map(); // personId -> { id, name, have }
  movieIds.forEach((mid, i) => {
    const d = rawMovies[i], m = movies[i];
    if (!d || !m || !m.director) return;
    const crew = (d.credits?.crew || []).find((c) => c.job === 'Director');
    if (!crew?.id) return;
    const e = dirMap.get(crew.id) || { id: crew.id, name: m.director, have: 0 };
    e.have++; dirMap.set(crew.id, e);
  });
  console.log(`deepening ${[...dirMap.values()].filter((d) => d.have >= DEEPEN_TRIGGER).length} directors (>=${DEEPEN_TRIGGER} films, up to ${DEEPEN_CAP} each, >=${DEEPEN_MIN_VOTES} votes)…`);
  const { ids: extraIds, coverage: deepened } = await collectDirectorFilms(tmdb, [...dirMap.values()], { seen: new Set(movieIds) });
  const rawExtra = await mapPool(extraIds, 8, (id) => tmdb(`/movie/${id}`, { append_to_response: 'credits' }).catch(() => null));
  const extra = rawExtra.map((d) => (d ? buildMovie(d) : null));

  const items = {};
  movieIds.forEach((id, i) => { if (movies[i]) items[`m${id}`] = movies[i]; });
  extraIds.forEach((id, i) => { if (extra[i]) items[`m${id}`] = extra[i]; });
  tvIds.forEach((id, i) => { if (shows[i]) items[`v${id}`] = shows[i]; });
  disambiguate(items); // remakes get a year suffix; exact dups dropped

  const out = {
    credit: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    genres: genreDropdown(items),
    items,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));

  // ---- Report (final tallies from the actual built data) ----
  const all = Object.values(items);
  const byDecade = {}, byGenre = {}, movieDecade = {}, movieGenre = {};
  for (const it of all) {
    byDecade[it.decade] = (byDecade[it.decade] || 0) + 1;
    if (it.t === 'm') movieDecade[it.decade] = (movieDecade[it.decade] || 0) + 1;
    for (const g of it.genres) {
      byGenre[g] = (byGenre[g] || 0) + 1;
      if (it.t === 'm') movieGenre[g] = (movieGenre[g] || 0) + 1;
    }
  }
  const deepenedDirs = Object.keys(deepened).length;
  const deepenedFilms = extra.filter(Boolean).length;
  console.log(`\ndeepened: +${deepenedFilms} films across ${deepenedDirs} directors (${extraIds.length} fetched)`);
  console.log(`\nitems: ${all.length} (${all.filter((i) => i.t === 'm').length} movies, ${all.filter((i) => i.t === 'v').length} tv)`);
  console.log('\nmovies per decade (bucket fetched → in final data):');
  for (const [d, got] of Object.entries(coverage.decades).sort()) {
    const have = movieDecade[d] || 0;
    console.log(`  ${d}: ${got} → ${have}${have < GOAL ? `   ⚠ under ${GOAL}` : ''}`);
  }
  console.log('\nmovies per genre (in final data):');
  for (const [g, n] of Object.entries(movieGenre).sort()) {
    console.log(`  ${g}: ${n}${n < GOAL ? `   ⚠ under ${GOAL}` : ''}`);
  }
  console.log(`\ndropdown genres: ${out.genres.join(', ')}`);
  console.log(`size: ${Math.round(JSON.stringify(out).length / 1024)} KB → ${OUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
