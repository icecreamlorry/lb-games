// FLAGZ data builder.
//
//   node flagz/tools/build-data.mjs
//
// Produces:
//   flagz/data/countries.json — regions + per-country name/aliases/population/
//     area (both checked in; the game never fetches or computes at runtime)
//   flagz/data/flags/<cc>.svg — 4x3 flag SVGs for every playable country
//
// Sources:
//   • Natural Earth 50m admin0 (public domain) — names, POP_EST, geometry
//     (area is computed geodesically from the geometry, so it includes each
//     country's islands/overseas parts consistently).
//   • flag-icons (MIT, https://github.com/lipis/flag-icons) — flag SVGs,
//     pulled as an npm tarball (registry.npmjs.org is reachable from the dev
//     environment; most of the web is not).

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoArea } from 'd3-geo';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'cache');
const DATA = join(HERE, '..', 'data');
const ATLAZ_NE = join(HERE, '..', '..', 'atlaz', 'tools', 'cache', 'ne50_admin0.geojson');
const NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

// ---- Regions ----------------------------------------------------------------
// Countries only, sized ~25-35 per region (Africa and Europe split in two, the
// Americas combined). Transcontinentals appear in every region they border.
// `world` is the union of everything, generated below.

const REGIONS = [
  { id: 'europe-west', label: 'Western Europe',
    iso: 'IS IE GB PT ES FR AD MC BE NL LU DE CH LI IT MT SM VA AT DK NO SE' },
  { id: 'europe-east', label: 'Eastern Europe',
    iso: 'FI EE LV LT PL CZ SK HU SI HR BA RS ME MK AL XK GR BG RO MD UA BY RU CY TR' },
  { id: 'africa-north', label: 'Northern Africa',
    iso: 'DZ EG LY MA TN SD SS TD NE ML MR SN GM GW GN SL LR CI GH TG BJ BF NG CV ER DJ ET SO' },
  { id: 'africa-south', label: 'Southern Africa',
    iso: 'CM CF GQ GA CG CD ST AO ZM MW MZ ZW BW NA SZ LS ZA MG MU KM SC KE UG RW BI TZ' },
  { id: 'mid-east', label: 'Middle East',
    iso: 'AM AZ BH CY GE IL IQ IR JO KW LB OM PS QA SA SY TR AE YE EG' },
  { id: 'asia', label: 'Asia',
    iso: 'CN MN KP KR JP TW IN PK AF BD BT NP LK MV KZ KG TJ TM UZ BN KH ID LA MY MM PH SG TH TL VN' },
  { id: 'oceania', label: 'Oceania & Pacific',
    iso: 'AU NZ PG FJ SB VU WS TO KI FM MH PW NR TV' },
  { id: 'americas', label: 'The Americas',
    iso: 'CA US MX BZ CR SV GT HN NI PA BS CU JM HT DO KN AG DM LC VC GD BB TT AR BO BR CL CO EC GY PY PE SR UY VE' },
];

// ---- Name/alias overrides (shared thinking with atlaz/tools/build-maps.mjs) --
const COUNTRY_NAMES = {
  US: { name: 'United States', alt: ['usa', 'united states of america', 'america', 'us'] },
  GB: { name: 'United Kingdom', alt: ['uk', 'great britain', 'britain'] },
  AE: { name: 'United Arab Emirates', alt: ['uae', 'emirates'] },
  CI: { name: 'Ivory Coast', alt: ['cote divoire'] },
  CD: { name: 'DR Congo', alt: ['democratic republic of the congo', 'drc', 'congo kinshasa', 'dr congo'] },
  CG: { name: 'Republic of the Congo', alt: ['congo', 'congo brazzaville'] },
  SZ: { name: 'Eswatini', alt: ['swaziland'] },
  CZ: { name: 'Czechia', alt: ['czech republic'] },
  MM: { name: 'Myanmar', alt: ['burma'] },
  TL: { name: 'Timor-Leste', alt: ['east timor'] },
  CV: { name: 'Cape Verde', alt: ['cabo verde'] },
  ST: { name: 'São Tomé and Príncipe', alt: ['sao tome'] },
  MK: { name: 'North Macedonia', alt: ['macedonia'] },
  BA: { name: 'Bosnia and Herzegovina', alt: ['bosnia'] },
  VA: { name: 'Vatican City', alt: ['vatican', 'holy see'] },
  PS: { name: 'Palestine', alt: ['palestinian territories'] },
  TR: { name: 'Türkiye', alt: ['turkey', 'turkiye'] },
  KN: { name: 'Saint Kitts and Nevis', alt: ['st kitts'] },
  VC: { name: 'Saint Vincent and the Grenadines', alt: ['st vincent'] },
  AG: { name: 'Antigua and Barbuda', alt: ['antigua'] },
  TT: { name: 'Trinidad and Tobago', alt: ['trinidad'] },
  CF: { name: 'Central African Republic', alt: ['car'] },
  GW: { name: 'Guinea-Bissau', alt: [] },
  TZ: { name: 'Tanzania', alt: [] },
  FM: { name: 'Micronesia', alt: ['federated states of micronesia'] },
  PG: { name: 'Papua New Guinea', alt: ['png'] },
  NZ: { name: 'New Zealand', alt: ['aotearoa'] },
  LA: { name: 'Laos', alt: [] },
  SS: { name: 'South Sudan', alt: [] },
  XK: { name: 'Kosovo', alt: [] },
  KM: { name: 'Comoros', alt: [] },
  RU: { name: 'Russia', alt: ['russian federation'] },
  KP: { name: 'North Korea', alt: ['dprk', 'democratic peoples republic of korea'] },
  KR: { name: 'South Korea', alt: ['korea', 'republic of korea'] },
  TW: { name: 'Taiwan', alt: ['republic of china', 'chinese taipei'] },
  KG: { name: 'Kyrgyzstan', alt: ['kyrgyz republic'] },
  MV: { name: 'Maldives', alt: [] },
  LK: { name: 'Sri Lanka', alt: ['ceylon'] },
  // Shorten the formal titles Natural Earth uses to the everyday names.
  CN: { name: 'China', alt: ['peoples republic of china', 'prc'] },
  BS: { name: 'Bahamas', alt: ['the bahamas'] },
  GM: { name: 'Gambia', alt: ['the gambia'] },
};

// ---- Load Natural Earth -------------------------------------------------------

function loadNE() {
  if (existsSync(ATLAZ_NE)) return JSON.parse(readFileSync(ATLAZ_NE, 'utf8'));
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, 'ne50_admin0.geojson');
  if (!existsSync(path)) {
    console.log('downloading Natural Earth admin0…');
    execFileSync('curl', ['-sS', '--fail', '--max-time', '600', '-o', path, NE_URL], { stdio: 'inherit' });
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

// De-facto territories folded into their claimed state for pop/area, matching
// the Atlaz maps (Somaliland → Somalia, N. Cyprus → Cyprus).
const ABSORB = { SO: ['SOL'], CY: ['CYN'] };

// The two square national flags. flag-icons' 4x3 renders stretch them into a
// rectangle, so we ship the true 1:1 art and mark them square (the game shows
// them un-stretched — see .sq in flagz/css/style.css).
const SQUARE = new Set(['CH', 'VA']);

const EARTH_R_KM = 6371.0088;
function areaKm2(geom) {
  // geoArea returns steradians for GeoJSON objects (spherical polygons).
  return geoArea(geom) * EARTH_R_KM * EARTH_R_KM;
}

// ---- Flags from the flag-icons npm package -------------------------------------

function fetchFlagPkg() {
  mkdirSync(CACHE, { recursive: true });
  const dir = join(CACHE, 'flag-icons');
  if (existsSync(join(dir, 'package', 'flags', '4x3'))) return join(dir, 'package', 'flags', '4x3');
  mkdirSync(dir, { recursive: true });
  console.log('fetching flag-icons from npm…');
  execSync('npm pack flag-icons --silent', { cwd: dir });
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  execSync(`tar xzf ${tgz}`, { cwd: dir });
  return join(dir, 'package', 'flags', '4x3');
}

// ---- Build ----------------------------------------------------------------------

const ne = loadNE();
const byIso = new Map();
const byA3 = new Map();
for (const f of ne.features) {
  const a2 = f.properties.ISO_A2_EH;
  // Several NE features can share an ISO code (Australia proper AND "Ashmore
  // and Cartier Islands" are both AU) — keep the most populous one.
  if (a2 && a2 !== '-99') {
    const prev = byIso.get(a2);
    if (!prev || (Number(f.properties.POP_EST) || 0) > (Number(prev.properties.POP_EST) || 0)) byIso.set(a2, f);
  }
  byA3.set(f.properties.ADM0_A3, f);
}

const world = [...new Set(REGIONS.flatMap((r) => r.iso.split(' ')))];
const countries = {};
const missingFlags = [];
const flagSrc = fetchFlagPkg();
mkdirSync(join(DATA, 'flags'), { recursive: true });

for (const a2 of world) {
  const f = byIso.get(a2);
  if (!f) { console.error(`! no NE feature for ${a2}`); continue; }
  const p = f.properties;
  const over = COUNTRY_NAMES[a2] || {};
  let pop = Number(p.POP_EST) || 0;
  let area = areaKm2(f.geometry);
  for (const extraA3 of ABSORB[a2] || []) {
    const ef = byA3.get(extraA3);
    if (ef) { pop += Number(ef.properties.POP_EST) || 0; area += areaKm2(ef.geometry); }
  }
  const entry = {
    name: over.name || p.NAME_EN || p.NAME,
    pop: Math.round(pop),
    area: Math.round(area),
  };
  if (over.alt?.length) entry.alt = over.alt;
  if (SQUARE.has(a2)) entry.square = true;
  countries[a2] = entry;

  // Square flags come from the 1x1 art (a sibling of the 4x3 folder).
  const dir = SQUARE.has(a2) ? join(flagSrc, '..', '1x1') : flagSrc;
  const src = join(dir, `${a2.toLowerCase()}.svg`);
  if (existsSync(src)) copyFileSync(src, join(DATA, 'flags', `${a2.toLowerCase()}.svg`));
  else missingFlags.push(a2);
}

const out = {
  credit: 'Flags: flag-icons (MIT). Population & area: Natural Earth (public domain; area computed geodesically).',
  regions: [
    { id: 'world', label: 'Whole World', iso: world.join(' ') },
    ...REGIONS,
  ],
  countries,
};
writeFileSync(join(DATA, 'countries.json'), JSON.stringify(out));

// Report
const flagsDir = join(DATA, 'flags');
const totalKb = Math.round(readdirSync(flagsDir).reduce((s, f) => s + statSync(join(flagsDir, f)).size, 0) / 1024);
console.log(`world: ${world.length} countries`);
for (const r of REGIONS) console.log(`  ${r.id}: ${r.iso.split(' ').length}`);
console.log(`flags: ${readdirSync(flagsDir).length} files, ${totalKb} KB total`);
if (missingFlags.length) console.error('! missing flags:', missingFlags.join(' '));
// Sanity spot-checks
const spot = (a2) => console.log(`  ${a2}: pop ${countries[a2].pop.toLocaleString()}, area ${countries[a2].area.toLocaleString()} km²`);
['CN', 'US', 'RU', 'VA', 'GB', 'BR'].forEach(spot);
