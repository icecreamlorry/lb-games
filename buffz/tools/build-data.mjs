// BUFFZ data builder — pulls the playable pool from TMDb.
//
//   TMDB_API_KEY=xxxxx node buffz/tools/build-data.mjs
//
// NOTE: api.themoviedb.org is NOT reachable from the LB Games dev sandbox
// (proxy 403) — run this on a normal machine, then commit the regenerated
// buffz/data/titles.json. A free key comes from themoviedb.org → Settings →
// API (either the v3 "API Key" or the v4 "Read Access Token" works — the
// script accepts both).
//
// What it fetches: the top MOVIE_COUNT movies + TV_COUNT shows by VOTE COUNT
// (the best "everyone's heard of it" proxy: popularity is trend-of-the-week,
// top-rated is critically-acclaimed-obscure), via /discover pages, then one
// details call per title with append_to_response=credits. ~1,150 requests,
// about a minute at TMDb's free-tier rate; costs nothing; attribution is
// shown in the game's help modal.
//
// Output shape (buffz/data/titles.json) — see PLAN.md §2. Kept deliberately
// lean: 3 cast names, one-sentence plots, no images, `country` only for
// non-US titles (the only question that uses it), `orig` only when it
// differs from the display title.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'data', 'titles.json');

const KEY = process.env.TMDB_API_KEY;
if (!KEY) {
  console.error('Set TMDB_API_KEY (v3 key or v4 read token) — free from themoviedb.org → Settings → API.');
  process.exit(1);
}
const V4 = KEY.length > 60; // v4 read tokens are long JWTs; v3 keys are 32 hex chars

const MOVIE_COUNT = 750;
const TV_COUNT = 350;
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

async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!V4) url.searchParams.set('api_key', KEY);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, V4 ? { headers: { Authorization: `Bearer ${KEY}` } } : undefined);
    if (res.status === 429 && attempt < 5) {
      // Free tier is generous (~50 req/s) but back off politely if throttled.
      const wait = Number(res.headers.get('retry-after')) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`TMDb ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return res.json();
  }
}

// A modest concurrency pool keeps the run fast without hammering the API.
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

function firstSentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).slice(0, 220);
}

function decadeOf(year) { return `${Math.floor(year / 10) * 10}s`; }

async function discover(kind, count) {
  const ids = [];
  const dateKey = kind === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte';
  for (let page = 1; ids.length < count && page <= Math.ceil(count / PAGE) + 5; page++) {
    const d = await tmdb(`/discover/${kind}`, {
      sort_by: 'vote_count.desc',
      page,
      // Exclude the odd unreleased/dateless stragglers.
      [dateKey]: new Date().toISOString().slice(0, 10),
    });
    for (const r of d.results) if (!ids.includes(r.id)) ids.push(r.id);
  }
  return ids.slice(0, count);
}

function buildMovie(d) {
  const year = Number((d.release_date || '').slice(0, 4));
  if (!year || !d.title) return null;
  const cast = (d.credits?.cast || []).slice(0, 3).map((c) => c.name);
  const director = (d.credits?.crew || []).find((c) => c.job === 'Director')?.name;
  const genres = (d.genres || []).map((g) => g.name).filter((g) => g !== 'TV Movie');
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

function buildTv(d) {
  const year = Number((d.first_air_date || '').slice(0, 4));
  if (!year || !d.name) return null;
  const cast = (d.credits?.cast || []).slice(0, 3).map((c) => c.name);
  const creator = (d.created_by || [])[0]?.name;
  const genres = [...new Set((d.genres || []).flatMap((g) => TV_GENRE_MAP[g.name] ?? [g.name]))];
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

console.log(`discovering top ${MOVIE_COUNT} movies + ${TV_COUNT} TV shows by vote count…`);
const [movieIds, tvIds] = await Promise.all([discover('movie', MOVIE_COUNT), discover('tv', TV_COUNT)]);

console.log('fetching details…');
const movies = await mapPool(movieIds, 8, (id) => tmdb(`/movie/${id}`, { append_to_response: 'credits' }).then(buildMovie).catch(() => null));
const shows = await mapPool(tvIds, 8, (id) => tmdb(`/tv/${id}`, { append_to_response: 'credits' }).then(buildTv).catch(() => null));

const items = {};
for (const [prefix, list] of [['m', movies], ['v', shows]]) {
  for (let i = 0; i < list.length; i++) {
    if (list[i]) items[`${prefix}${prefix === 'm' ? movieIds[i] : tvIds[i]}`] = list[i];
  }
}

// The GENRE dropdown lists genres with a workable amount of material.
const genreCounts = {};
for (const it of Object.values(items)) for (const g of it.genres) genreCounts[g] = (genreCounts[g] || 0) + 1;
const genres = Object.keys(genreCounts).filter((g) => genreCounts[g] >= 12).sort();

const out = {
  credit: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
  genres,
  items,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));

// Report
const all = Object.values(items);
console.log(`\nitems: ${all.length} (${all.filter((i) => i.t === 'm').length} movies, ${all.filter((i) => i.t === 'v').length} tv)`);
const decades = {};
for (const it of all) decades[it.decade] = (decades[it.decade] || 0) + 1;
console.log('decades:', JSON.stringify(Object.fromEntries(Object.entries(decades).sort())));
console.log('genres:', genres.join(', '));
console.log(`taglines: ${all.filter((i) => i.tagline).length}, plots: ${all.filter((i) => i.plot).length}, directors/creators: ${all.filter((i) => i.director || i.creator).length}`);
console.log(`size: ${Math.round(JSON.stringify(out).length / 1024)} KB → ${OUT}`);
