// Mock-fetch tests for the stratified pull logic. api.themoviedb.org can't be
// reached from the sandbox, so this fakes TMDb's /discover responses to prove
// discoverBucket paginates + dedupes correctly and collectMovieIds fills every
// decade and genre bucket to its quota (the whole point of the rewrite).
//   node buffz/tools/build-data.test.mjs

import {
  discoverBucket, collectMovieIds, collectDirectorFilms, decadeOf, firstSentence, buildMovie, genreDropdown,
} from './build-data.mjs';

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) passed++; else { failed++; console.error(`FAIL  ${n}`); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// A fake TMDb: a synthetic universe of movies with year + genre ids, paged
// exactly like /discover (sorted by vote_count.desc, 20 per page).
function fakeTmdb(universe, genres) {
  const PAGE = 20;
  return async function tmdb(path, params = {}) {
    if (path === '/genre/movie/list') return { genres };
    if (path.startsWith('/discover/')) {
      let pool = universe;
      if (params['primary_release_date.gte']) {
        const lo = Number(params['primary_release_date.gte'].slice(0, 4));
        const hi = Number(params['primary_release_date.lte'].slice(0, 4));
        pool = pool.filter((m) => m.year >= lo && m.year <= hi);
      } else if (params['primary_release_date.lte']) {
        const hi = Number(params['primary_release_date.lte'].slice(0, 4));
        pool = pool.filter((m) => m.year <= hi);
      }
      if (params.with_genres) pool = pool.filter((m) => m.genre_ids.includes(Number(params.with_genres)));
      if (params['vote_count.gte']) pool = pool.filter((m) => m.votes >= Number(params['vote_count.gte']));
      pool = pool.slice().sort((a, b) => b.votes - a.votes);
      const total_pages = Math.max(1, Math.ceil(pool.length / PAGE));
      const page = Number(params.page) || 1;
      return { page, total_pages, results: pool.slice((page - 1) * PAGE, page * PAGE) };
    }
    throw new Error(`unexpected path ${path}`);
  };
}

const GENRES = [{ id: 28, name: 'Action' }, { id: 80, name: 'Crime' }, { id: 37, name: 'Western' }, { id: 99, name: 'Documentary' }];

// ---- pure helpers ----
eq(decadeOf(1972), '1970s', 'decadeOf 1972');
eq(decadeOf(2009), '2000s', 'decadeOf 2009');
eq(firstSentence('A man walks in. Then more happens.'), 'A man walks in.', 'firstSentence splits');
eq(firstSentence('No terminal punctuation here'), 'No terminal punctuation here', 'firstSentence keeps unpunctuated');
{
  const m = buildMovie({ title: 'X', release_date: '1955-03-01', vote_average: 7.44, vote_count: 900, genres: [{ name: 'Western' }, { name: 'TV Movie' }], production_countries: [{ name: 'Italy' }], credits: { crew: [{ job: 'Director', name: 'Sergio' }], cast: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] } });
  eq(m.decade, '1950s', 'buildMovie decade');
  eq(m.genres, ['Western'], 'buildMovie drops TV Movie genre');
  eq(m.cast.length, 3, 'buildMovie trims cast to 3');
  eq(m.country, 'Italy', 'buildMovie keeps non-US country');
  eq(m.director, 'Sergio', 'buildMovie director');
  ok(buildMovie({ title: 'Y', release_date: '', vote_average: 5, vote_count: 1 }) === null, 'buildMovie drops dateless');
}

// ---- discoverBucket: paginates, hits quota, dedupes against `seen` ----
{
  const universe = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, year: 2000, votes: 1000 - i, genre_ids: [28] }));
  const tmdb = fakeTmdb(universe, GENRES);
  const ids = await discoverBucket(tmdb, 'movie', 115);
  eq(ids.length, 115, 'discoverBucket returns exactly the quota');
  eq(ids[0], 1, 'discoverBucket is vote-sorted (highest first)');
  eq([...new Set(ids)].length, ids.length, 'discoverBucket ids unique');
  const seen = new Set([1, 2, 3, 4, 5]);
  const ids2 = await discoverBucket(tmdb, 'movie', 10, {}, seen);
  ok(!ids2.some((x) => seen.has(x)), 'discoverBucket skips seen ids');
  // Exhaustion: quota larger than the universe returns all, no infinite loop.
  const small = Array.from({ length: 7 }, (_, i) => ({ id: 900 + i, year: 2000, votes: 5, genre_ids: [28] }));
  eq((await discoverBucket(fakeTmdb(small, GENRES), 'movie', 50)).length, 7, 'discoverBucket stops when results run out');
}

// ---- collectMovieIds: every decade & genre bucket reaches its quota ----
{
  // A universe with plenty in every decade 1930s..2020s and every genre.
  const universe = [];
  let id = 1;
  const thisYear = new Date().getFullYear();
  // A generous silent era (1905..1929) so the pooled "Pre-1930" bucket fills.
  for (let k = 0; k < 60; k++) universe.push({ id: id++, year: 1905 + (k % 25), votes: 500 - k, genre_ids: [[28, 80, 37, 99][k % 4], 12] });
  for (let start = 1930; start <= thisYear; start += 10) {
    for (let k = 0; k < 200; k++) {
      // Spread genres so each has a deep bench; votes higher for recent decades
      // (mimicking TMDb's recency bias — the thing stratification must beat).
      const gid = [28, 80, 37, 99][k % 4];
      universe.push({ id: id++, year: Math.min(start + (k % 10), thisYear), votes: (start - 1900) * 50 + (200 - k), genre_ids: [gid, 28] });
    }
  }
  const tmdb = fakeTmdb(universe, GENRES);
  const { ids, coverage } = await collectMovieIds(tmdb, GENRES, { today: new Date() });
  eq([...new Set(ids)].length, ids.length, 'collectMovieIds returns a deduped union');
  const decades = Object.keys(coverage.decades);
  ok(decades.includes('1930s') && decades.includes('2020s'), 'collectMovieIds covers 1930s..2020s');
  ok(decades.includes('Pre-1930') && coverage.decades['Pre-1930'] >= 24, `Pre-1930 silent-era bucket filled (${coverage.decades['Pre-1930']})`);
  ok(Object.entries(coverage.decades).filter(([d]) => d !== 'Pre-1930').every(([, n]) => n >= 115), 'every numbered decade bucket reached quota');
  // Western/Documentary exist only 1-in-4, but the genre quota query still fills
  // them because it searches the whole universe by that genre.
  ok(coverage.genres.Western >= 115, `Western genre bucket filled (${coverage.genres.Western})`);
  ok(coverage.genres.Documentary >= 115, `Documentary genre bucket filled (${coverage.genres.Documentary})`);
  // Sanity: the union is far bigger than any single global pull would give per
  // old decade — that's the whole win.
  ok(ids.length > 900, `union is a broad pool (${ids.length} movies)`);
}

// ---- a starved bucket reports short instead of looping forever ----
{
  // Only 12 films in the 1930s; quota is 115 → coverage should honestly say 12.
  const universe = [];
  let id = 1;
  for (let k = 0; k < 12; k++) universe.push({ id: id++, year: 1935, votes: 100 - k, genre_ids: [28] });
  for (let k = 0; k < 400; k++) universe.push({ id: id++, year: 2015, votes: 5000 - k, genre_ids: [28, 80] });
  const { coverage } = await collectMovieIds(fakeTmdb(universe, GENRES), GENRES, { today: new Date('2029-06-01') });
  eq(coverage.decades['1930s'], 12, 'starved decade reports its true (short) count');
  ok(coverage.decades['2010s'] >= 115, '2010s still fills');
}

// ---- collectDirectorFilms: deepen existing directors, gated by trigger/cap/floor ----
{
  // Alice is well-represented (3 pool films) with a deep catalogue; Bob has
  // only 1 pool film so sits below the trigger and is left alone.
  const catalogue = {
    10: [
      { id: 101, job: 'Director', vote_count: 5000, release_date: '2001-01-01' }, // already in pool
      { id: 102, job: 'Director', vote_count: 4000, release_date: '2005-01-01' },
      { id: 103, job: 'Director', vote_count: 900, release_date: '2010-01-01' },
      { id: 104, job: 'Director', vote_count: 50, release_date: '2012-01-01' },   // obscure → excluded
      { id: 105, job: 'Writer', vote_count: 9999, release_date: '2013-01-01' },   // not directed → excluded
      { id: 106, job: 'Director', vote_count: 3000, release_date: '' },           // no release date → excluded
    ],
    20: [{ id: 201, job: 'Director', vote_count: 8000, release_date: '2000-01-01' }],
  };
  const tmdb = async (path) => {
    const m = path.match(/^\/person\/(\d+)\/movie_credits$/);
    if (m) return { crew: catalogue[m[1]] || [] };
    throw new Error(`unexpected path ${path}`);
  };
  const directors = [{ id: 10, name: 'Alice', have: 3 }, { id: 20, name: 'Bob', have: 1 }];
  const { ids, coverage } = await collectDirectorFilms(tmdb, directors, { seen: new Set([101]), trigger: 2, cap: 8, minVotes: 100 });
  ok(!ids.includes(101), 'collectDirectorFilms skips films already in the pool');
  ok(ids.includes(102) && ids.includes(103), 'collectDirectorFilms adds a director\'s notable films');
  ok(!ids.includes(104), 'collectDirectorFilms excludes sub-threshold (obscure) films');
  ok(!ids.includes(105), 'collectDirectorFilms counts only Director credits');
  ok(!ids.includes(106), 'collectDirectorFilms excludes undated films');
  ok(!ids.includes(201), 'collectDirectorFilms leaves below-trigger directors alone');
  eq(coverage.Alice, { have: 3, added: 2 }, 'collectDirectorFilms reports per-director depth added');
}
{
  // No cap: every qualifying film comes in, however prolific the director. Here
  // 8 of 10 clear the 100-vote floor, so all 8 join (the 2 sub-floor excluded).
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 300 + i, job: 'Director', vote_count: i < 8 ? 500 : 50, release_date: '2000-01-01' }));
  const tmdb = async () => ({ crew: many });
  const { ids } = await collectDirectorFilms(tmdb, [{ id: 30, name: 'Prolific', have: 6 }], { seen: new Set(), trigger: 2, minVotes: 100 });
  eq(ids.length, 8, 'collectDirectorFilms adds every film clearing the vote floor — no arbitrary cap');
  ok(!ids.includes(308) && !ids.includes(309), 'collectDirectorFilms still excludes sub-floor films');
}

// ---- genreDropdown threshold ----
{
  const items = { a: { genres: ['Action', 'Rare'] }, b: { genres: ['Action'] }, c: { genres: ['Action'] } };
  eq(genreDropdown(items, 3), ['Action'], 'genreDropdown drops genres below the min');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
