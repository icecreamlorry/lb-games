// ATLAZ map data builder.
//
// Turns Natural Earth GeoJSON (public domain) into the compact, pre-projected
// region files the game ships in atlaz/data/maps/*.json. Run from anywhere:
//
//   node atlaz/tools/build-maps.mjs            # build all regions
//   node atlaz/tools/build-maps.mjs europe usa # build specific regions
//
// Sources are downloaded once into tools/cache/ (gitignored) via curl — the
// dev environment's proxy allows raw.githubusercontent.com. The generated
// JSON is checked into git; the game never fetches or builds at runtime.
//
// Each region file contains three layers:
//   items — the playable territories (id/name/alt/d/cx/cy/bbox)
//   ctx   — non-playable neighbouring land, cropped by the frame, so maps
//           don't show impossible gaps (Türkiye-shaped hole in Europe etc.)
//   lakes — large lakes, drawn as water so Michigan doesn't look broken
//
// See atlaz/PLAN.md §3 for the full pipeline description.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoMercator, geoConicConformal, geoAlbersUsa, geoPath } from 'd3-geo';
import { topology } from 'topojson-server';
import { feature, merge } from 'topojson-client';
import { presimplify, quantile, simplify } from 'topojson-simplify';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'cache');
const OUT = join(HERE, '..', 'data', 'maps');
const W = 1000; // every region is emitted 1000 units wide

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const SOURCES = {
  admin0: { file: 'ne50_admin0.geojson', url: `${NE}/ne_50m_admin_0_countries.geojson` },
  admin1: { file: 'ne10_admin1.geojson', url: `${NE}/ne_10m_admin_1_states_provinces.geojson` },
  lakes: { file: 'ne50_lakes.geojson', url: `${NE}/ne_50m_lakes.geojson` },
};

// ---- Country name/alias overrides (id = ISO 3166-1 a2, NE's ISO_A2_EH) -----
// `name` replaces NE's NAME_EN; `alt` are extra accepted answers (matching is
// case/diacritic/punctuation-insensitive at runtime, so one spelling each).
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
};

// ---- Region definitions ----------------------------------------------------
// window: [lonMin, lonMax, latMin, latMax] — polygons whose outer-ring centroid
// falls outside are dropped (removes overseas territories from the frame).
// normLon: add 360 to negative longitudes before the window test (Pacific).
// fitExclude: ids drawn but ignored when fitting the projection (Russia).
// windowSkip: ids exempt from the window test (clipExtent crops them instead).
// labelAt: manual [lon, lat] label anchors for ids whose centroid misbehaves.
// ctx: ISO list of non-playable neighbour countries drawn as cropped scenery.
//   Rule of thumb (playtested): only include land that shares a LAND BORDER
//   with something playable (or fills a hole inside land that's already
//   shown). Neighbours across open sea are dropped — an island region like
//   Japan or Australia reads fine alone, and a random sliver of disconnected
//   coast at the frame edge looks worse than nothing.
// ctxAdmin1: admin-1 filter (props => bool) merged into ONE scenery shape —
//   used where the land neighbour is part of one country (UK nations).
// Transcontinental countries are deliberately playable in TWO regions:
// Türkiye (europe + w-asia) and Egypt (africa + w-asia).

const AFRICA = 'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW';
const EUROPE = 'AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA TR';
const SE_ASIA = 'BN KH ID LA MY MM PH SG TH TL VN';
const W_ASIA = 'AM AZ BH CY GE IL IQ IR JO KW LB OM PS QA SA SY TR AE YE EG';
const OCEANIA = 'AU NZ PG FJ SB VU WS TO KI FM MH PW NR TV';
const S_AMERICA = 'AR BO BR CL CO EC GY PY PE SR UY VE';
// Mainland chain from Canada to Panama in one map; the island states get
// their own Caribbean map — mixing them with the continent left the islands
// unplayably small.
const N_AMERICA = 'CA US MX BZ CR SV GT HN NI PA';
const CARIBBEAN = 'BS CU JM HT DO KN AG DM LC VC GD BB TT';

const mercator = () => geoMercator();
const conic = (parallels, lon0) => geoConicConformal().parallels(parallels).rotate([-lon0, 0]);

const REGIONS = [
  { id: 'africa', label: 'Africa', kind: 'countries', iso: AFRICA,
    window: [-26, 64, -36, 38], proj: mercator, simplifyQ: 0.3,
    // Sinai land bridge: Egypt's Asian neighbours + the peninsula they sit on.
    ctx: 'IL PS JO SA YE OM AE QA BH KW SY IQ LB' },
  { id: 'europe', label: 'Europe', kind: 'countries', iso: EUROPE,
    window: [-25, 65, 30, 72], proj: () => conic([40, 60], 15),
    fitExclude: ['RU', 'TR'], windowSkip: ['RU'],
    labelAt: { RU: [37.6, 55.8], NO: [8.5, 61] }, simplifyQ: 0.3,
    // Land neighbours of playable Russia/Türkiye only — North Africa across
    // the Med reads fine as open sea.
    ctx: 'GE AM AZ KZ SY IQ' },
  { id: 'se-asia', label: 'South East Asia', kind: 'countries', iso: SE_ASIA,
    window: [90, 142, -12, 29], proj: mercator, simplifyQ: 0.5,
    ctx: 'CN IN BD BT NP PG' },
  { id: 'w-asia', label: 'Western Asia', kind: 'countries', iso: W_ASIA,
    window: [22, 64, 11, 44], proj: mercator, simplifyQ: 0.5,
    ctx: 'GR BG RU KZ TM UZ AF PK SD LY' },
  { id: 'oceania', label: 'Australasia & Polynesia', kind: 'countries', iso: OCEANIA,
    window: [110, 215, -48, 20], normLon: true, proj: () => geoMercator().rotate([-160, 0]),
    // Indonesia shares New Guinea with playable PNG; MY/BN/TL fill holes in
    // the Indonesian islands that are then on show.
    ctx: 'ID TL MY BN' },

  { id: 's-america', label: 'South America', kind: 'countries', iso: S_AMERICA,
    window: [-82, -34, -56, 13], proj: mercator, simplifyQ: 0.6,
    ctx: 'PA FR' },
  { id: 'n-america', label: 'North & Central America', kind: 'countries', iso: N_AMERICA,
    window: [-170, -50, 5.5, 84], proj: () => conic([30, 60], -96),
    dropRing: (lon, lat) => lon < -140 && lat < 35 /* Hawaii */, simplifyQ: 0.3,
    // Colombia/Venezuela continue Panama's isthmus; Greenland hugs the
    // Canadian arctic islands closely enough that its absence reads wrong.
    ctx: 'GL CO VE' },
  { id: 'caribbean', label: 'Caribbean', kind: 'countries', iso: CARIBBEAN,
    window: [-85.5, -58.5, 9.7, 27.5], proj: mercator,
    // Surrounding mainland coasts (Florida, Yucatán, Venezuela) anchor the
    // islands' positions on any Caribbean map.
    ctx: 'US MX VE CO' },

  { id: 'usa', label: 'USA', kind: 'states', admin: 'United States of America',
    proj: () => geoAlbersUsa(), simplifyQ: 0.3,
    ctx: 'CA MX',
    alt: { 'district-of-columbia': ['washington dc', 'dc'] } },
  { id: 'england', label: 'England', kind: 'states', admin: 'United Kingdom', unit: 'England',
    proj: () => conic([50, 55], -1.5), simplifyQ: 0.5, dissolve: englandGroup,
    // Land neighbours only — NI is across the Irish Sea.
    ctxAdmin1: (p) => p.geonunit === 'Scotland' || p.geonunit === 'Wales',
    alt: { 'greater-london': ['london'], 'county-durham': ['durham'] } },
  { id: 'scotland', label: 'Scotland', kind: 'states', admin: 'United Kingdom', unit: 'Scotland',
    window: [-8.2, 0.5, 54.5, 61.2], proj: () => conic([55, 60], -4), simplifyQ: 0.5,
    dissolve: (p) => SCOTLAND_FIX[p.name] || p.name,
    // England is the only land neighbour — NI is across the North Channel.
    ctxAdmin1: (p) => p.geonunit === 'England',
    alt: { 'outer-hebrides': ['western isles', 'na h eileanan siar', 'eilean siar'],
           'perth-and-kinross': ['perthshire and kinross'] } },
  { id: 'wales', label: 'Wales', kind: 'states', admin: 'United Kingdom', unit: 'Wales',
    proj: () => conic([51, 53.5], -3.8), simplifyQ: 0.5,
    dissolve: (p) => WALES_FIX[p.name] || p.name,
    ctxAdmin1: (p) => p.geonunit === 'England', // Wales' only land neighbour
    alt: { anglesey: ['ynys mon'], 'rhondda-cynon-taf': ['rhondda cynon taff', 'rhondda'] } },
  { id: 'northern-ireland', label: 'Northern Ireland', kind: 'states', admin: 'United Kingdom', unit: 'Northern Ireland',
    proj: () => conic([54, 55.5], -6.7), simplifyQ: 0.6, dissolve: niGroup,
    ctx: 'IE', // land border with the Republic; Scotland is across open sea
    alt: { londonderry: ['derry', 'county londonderry'], down: ['county down'],
           antrim: ['county antrim'], armagh: ['county armagh'], tyrone: ['county tyrone'],
           fermanagh: ['county fermanagh'] } },
  { id: 'ireland', label: 'Ireland', kind: 'states', admin: 'Ireland',
    proj: mercator, simplifyQ: 0.5, dissolve: irelandGroup,
    ctxAdmin1: (p) => p.geonunit === 'Northern Ireland' /* land border only */ },
  { id: 'canada', label: 'Canada', kind: 'states', admin: 'Canada',
    proj: () => conic([49, 77], -96), simplifyQ: 0.15,
    ctx: 'US GL',
    alt: { quebec: ['quebec'], 'newfoundland-and-labrador': ['newfoundland'],
           'prince-edward-island': ['pei'], 'northwest-territories': ['nwt'] } },
  { id: 'brazil', label: 'Brazil', kind: 'states', admin: 'Brazil',
    proj: mercator, simplifyQ: 0.3,
    ctx: 'AR BO CL CO EC GY PE PY SR UY VE FR',
    alt: { 'distrito-federal': ['federal district'] } },
  { id: 'australia', label: 'Australia', kind: 'states', admin: 'Australia',
    drop: ['Jervis Bay Territory', 'Lord Howe Island', 'Macquarie Island'],
    window: [112, 155, -44.5, -9], proj: mercator, simplifyQ: 0.4,
    alt: { 'australian-capital-territory': ['act', 'capital territory'],
           'new-south-wales': ['nsw'], 'northern-territory': ['nt'],
           'western-australia': ['wa'], 'south-australia': ['sa'] } },
  { id: 'japan', label: 'Japan', kind: 'states', admin: 'Japan',
    window: [122, 154, 24, 46], proj: mercator, simplifyQ: 0.5 },
];

// ---- UK dissolve tables ------------------------------------------------------
// England: NE's ~150 LAD-level units → 47 ceremonial counties (City of London
// folded into Greater London). Key = NE `name`.
const ENGLAND_COUNTY = {
  Bedfordshire: ['Bedford', 'Central Bedfordshire', 'Luton'],
  Berkshire: ['Bracknell Forest', 'Reading', 'Slough', 'West Berkshire', 'Wokingham', 'Royal Borough of Windsor and Maidenhead'],
  Bristol: ['Bristol'],
  Buckinghamshire: ['Buckinghamshire', 'Milton Keynes'],
  Cambridgeshire: ['Cambridgeshire', 'Peterborough'],
  Cheshire: ['Cheshire East', 'Cheshire West and Chester', 'Halton', 'Warrington'],
  Cornwall: ['Cornwall', 'Isles of Scilly'],
  Cumbria: ['Cumbria'],
  Derbyshire: ['Derbyshire', 'Derby'],
  Devon: ['Devon', 'Plymouth', 'Torbay'],
  Dorset: ['Dorset', 'Bournemouth', 'Poole'],
  'County Durham': ['Durham', 'Darlington', 'Hartlepool', 'Stockton-on-Tees'],
  'East Riding of Yorkshire': ['East Riding of Yorkshire', 'Kingston upon Hull'],
  'East Sussex': ['East Sussex', 'Brighton and Hove'],
  Essex: ['Essex', 'Southend-on-Sea', 'Thurrock'],
  Gloucestershire: ['Gloucestershire', 'South Gloucestershire'],
  'Greater London': ['City', 'Barking and Dagenham', 'Barnet', 'Bexley', 'Brent', 'Bromley', 'Camden', 'Croydon', 'Ealing', 'Enfield', 'Greenwich', 'Hackney', 'Hammersmith and Fulham', 'Haringey', 'Harrow', 'Havering', 'Hillingdon', 'Hounslow', 'Islington', 'Kensington and Chelsea', 'Kingston upon Thames', 'Lambeth', 'Lewisham', 'Merton', 'Newham', 'Redbridge', 'Richmond upon Thames', 'Southwark', 'Sutton', 'Tower Hamlets', 'Waltham Forest', 'Wandsworth', 'Westminster'],
  'Greater Manchester': ['Bolton', 'Bury', 'Manchester', 'Oldham', 'Rochdale', 'Salford', 'Stockport', 'Tameside', 'Trafford', 'Wigan'],
  Hampshire: ['Hampshire', 'Portsmouth', 'Southampton'],
  Herefordshire: ['Herefordshire'],
  Hertfordshire: ['Hertfordshire'],
  'Isle of Wight': ['Isle of Wight'],
  Kent: ['Kent', 'Medway'],
  Lancashire: ['Lancashire', 'Blackburn with Darwen', 'Blackpool'],
  Leicestershire: ['Leicestershire', 'Leicester'],
  Lincolnshire: ['Lincolnshire', 'North Lincolnshire', 'North East Lincolnshire'],
  Merseyside: ['Knowsley', 'Liverpool', 'Sefton', 'Merseyside'],
  Norfolk: ['Norfolk'],
  'North Yorkshire': ['North Yorkshire', 'York', 'Middlesbrough', 'Redcar and Cleveland'],
  Northamptonshire: ['Northamptonshire'],
  Northumberland: ['Northumberland'],
  Nottinghamshire: ['Nottinghamshire', 'Nottingham'],
  Oxfordshire: ['Oxfordshire'],
  Rutland: ['Rutland'],
  Shropshire: ['Shropshire', 'Telford and Wrekin'],
  Somerset: ['Somerset', 'Bath and North East Somerset', 'North Somerset'],
  'South Yorkshire': ['Barnsley', 'Doncaster', 'Rotherham', 'Sheffield'],
  Staffordshire: ['Staffordshire', 'Stoke-on-Trent'],
  Suffolk: ['Suffolk'],
  Surrey: ['Surrey'],
  'Tyne and Wear': ['Gateshead', 'Newcastle upon Tyne', 'North Tyneside', 'South Tyneside', 'Sunderland'],
  Warwickshire: ['Warwickshire'],
  'West Midlands': ['Birmingham', 'Coventry', 'Dudley', 'Sandwell', 'Solihull', 'Walsall', 'Wolverhampton'],
  'West Sussex': ['West Sussex'],
  'West Yorkshire': ['Bradford', 'Calderdale', 'Kirklees', 'Leeds', 'Wakefield'],
  Wiltshire: ['Wiltshire', 'Swindon'],
  Worcestershire: ['Worcestershire'],
};
const ENGLAND_LOOKUP = new Map();
for (const [county, units] of Object.entries(ENGLAND_COUNTY)) {
  for (const u of units) ENGLAND_LOOKUP.set(u, county);
}
function englandGroup(props) {
  const county = ENGLAND_LOOKUP.get(props.name);
  if (!county) throw new Error(`No ceremonial county mapping for England unit "${props.name}"`);
  return county;
}

const SCOTLAND_FIX = {
  'North Ayshire': 'North Ayrshire',           // NE typo
  'Perthshire and Kinross': 'Perth and Kinross',
  'Eilean Siar': 'Outer Hebrides',
};
const WALES_FIX = { 'Rhondda, Cynon, Taff': 'Rhondda Cynon Taf' };

// Northern Ireland: NE's 26 districts → the 6 traditional counties (close
// approximation; modern district boundaries don't follow the counties exactly).
const NI_COUNTY = {
  Antrim: ['Antrim', 'Ballymena', 'Ballymoney', 'Belfast', 'Carrickfergus', 'Larne', 'Lisburn', 'Moyle', 'Newtownabbey'],
  Londonderry: ['Coleraine', 'Derry', 'Limavady', 'Magherafelt'],
  Tyrone: ['Dungannon', 'Mid Ulster', 'Omagh', 'Strabane'],
  Fermanagh: ['Fermanagh'],
  Armagh: ['Armagh', 'Craigavon'],
  Down: ['Ards', 'Banbridge', 'Castlereagh', 'Down', 'Newry and Mourne', 'North Down'],
};
const NI_LOOKUP = new Map();
for (const [county, units] of Object.entries(NI_COUNTY)) {
  for (const u of units) NI_LOOKUP.set(u, county);
}
function niGroup(props) {
  const county = NI_LOOKUP.get(props.name);
  if (!county) throw new Error(`No county mapping for NI district "${props.name}"`);
  return county;
}

const IRELAND_FIX = {
  'Dún Laoghaire–Rathdown': 'Dublin', Fingal: 'Dublin', 'South Dublin': 'Dublin',
  'North Tipperary': 'Tipperary', 'South Tipperary': 'Tipperary',
  Laoighis: 'Laois',
};
function irelandGroup(props) { return IRELAND_FIX[props.name] || props.name; }

// ---- Helpers ----------------------------------------------------------------

function download(src) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, src.file);
  if (existsSync(path)) return path;
  console.log(`downloading ${src.url} …`);
  execFileSync('curl', ['-sS', '--fail', '--max-time', '600', '-o', path, src.url], { stdio: 'inherit' });
  return path;
}

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Keep only the polygons of a (Multi)Polygon whose outer ring centroid passes
// the region window / dropRing tests. Returns null when nothing survives.
function windowGeometry(geom, region) {
  if (!region.window && !region.dropRing) return geom;
  const [lonMin, lonMax, latMin, latMax] = region.window ?? [-Infinity, Infinity, -Infinity, Infinity];
  const keep = (poly) => {
    const ring = poly[0];
    let lon = 0, lat = 0;
    for (const [x, y] of ring) { lon += x; lat += y; }
    lon /= ring.length; lat /= ring.length;
    const nl = region.normLon && lon < 0 ? lon + 360 : lon;
    if (nl < lonMin || nl > lonMax || lat < latMin || lat > latMax) return false;
    if (region.dropRing && region.dropRing(lon, lat)) return false;
    return true;
  };
  if (geom.type === 'Polygon') return keep(geom.coordinates) ? geom : null;
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates.filter(keep);
    if (!polys.length) return null;
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

// Loosened window for context/lakes: the frame clip does the real cropping,
// the window only stops far-flung territories (mainland France in South
// America via French Guiana is wanted; metropolitan France is not).
function ctxWindow(region) {
  if (!region.window) return null;
  const [a, b, c, d] = region.window;
  return { window: [a - 14, b + 14, c - 10, d + 10], normLon: region.normLon, dropRing: region.dropRing };
}

// Load + filter + (optionally) dissolve one region into working features
// [{ id, name, alt, labelLonLat, geometry }] in geographic coordinates.
function collectFeatures(region, sources) {
  const out = [];
  if (region.kind === 'countries') {
    const want = new Set(region.iso.split(' '));
    for (const f of sources.admin0.features) {
      const p = f.properties;
      const a2 = p.ISO_A2_EH;
      if (!want.has(a2)) continue;
      const geom = region.windowSkip?.includes(a2) ? f.geometry : windowGeometry(f.geometry, region);
      if (!geom) { console.warn(`  ! ${a2} fully outside window, skipped`); continue; }
      const over = COUNTRY_NAMES[a2] || {};
      out.push({
        id: a2, name: over.name || p.NAME_EN || p.NAME, alt: over.alt || [],
        labelLonLat: region.labelAt?.[a2] || (Number.isFinite(p.LABEL_X) ? [p.LABEL_X, p.LABEL_Y] : null),
        geometry: geom,
      });
      want.delete(a2);
    }
    for (const missing of want) console.warn(`  ! missing country ${missing}`);
    return out;
  }

  // states: filter by admin country (and geonunit for the UK nations), apply
  // drop list, then dissolve groups.
  let feats = sources.admin1.features.filter((f) => f.properties.admin === region.admin);
  if (region.unit) feats = feats.filter((f) => f.properties.geonunit === region.unit);
  if (region.drop) feats = feats.filter((f) => !region.drop.includes(f.properties.name));
  const groups = new Map(); // group name -> [feature indices]
  const kept = [];
  for (const f of feats) {
    // NB: use `name`, not `name_en` — NE's name_en for District of Columbia is
    // "Washington", which would dissolve DC into Washington state.
    const key = region.dissolve ? region.dissolve(f.properties) : f.properties.name;
    if (key == null) continue;
    const geom = windowGeometry(f.geometry, region);
    if (!geom) continue;
    kept.push({ ...f, geometry: geom });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(kept.length - 1);
  }
  // Dissolve via a shared topology so interior borders vanish cleanly.
  const topo = topology({ u: { type: 'FeatureCollection', features: kept } }, 1e5);
  const geoms = topo.objects.u.geometries;
  for (const [name, idxs] of groups) {
    const geometry = idxs.length === 1
      ? feature(topo, geoms[idxs[0]]).geometry
      : merge(topo, idxs.map((i) => geoms[i]));
    out.push({ id: slug(name), name, alt: region.alt?.[slug(name)] || [], labelLonLat: null, geometry });
  }
  return out;
}

// Non-playable neighbouring land: admin0 countries (region.ctx, each its own
// shape) plus an optional merged admin1 blob (region.ctxAdmin1 — the other UK
// nations). Playable ids never repeat here.
function collectContext(region, sources) {
  const out = [];
  const win = ctxWindow(region);
  const playable = region.kind === 'countries' ? new Set(region.iso.split(' ')) : new Set();
  for (const a2 of (region.ctx ? region.ctx.split(' ') : [])) {
    if (playable.has(a2)) continue;
    const f = sources.admin0.features.find((x) => x.properties.ISO_A2_EH === a2);
    if (!f) { console.warn(`  ! ctx country ${a2} not found`); continue; }
    const geom = win ? windowGeometry(f.geometry, win) : f.geometry;
    if (geom) out.push({ geometry: geom });
  }
  if (region.ctxAdmin1) {
    const feats = sources.admin1.features.filter((f) => region.ctxAdmin1(f.properties));
    if (feats.length) {
      const topo = topology({ u: { type: 'FeatureCollection', features: feats } }, 1e5);
      out.push({ geometry: merge(topo, topo.objects.u.geometries) });
    }
  }
  return out;
}

// Large lakes near the region (drawn as water over the land). The projection
// clip crops them to the frame; a small geo-area threshold keeps only lakes
// that read at map scale.
function collectLakes(region, sources) {
  const win = ctxWindow(region);
  const out = [];
  for (const f of sources.lakes.features) {
    const area = ringAreaDeg(f.geometry);
    if (area < 0.18) continue;
    const geom = win ? windowGeometry(f.geometry, win) : f.geometry;
    if (geom) out.push({ geometry: geom });
  }
  return out;
}

// Rough polygon area in square degrees (for lake size filtering only).
function ringAreaDeg(geom) {
  const ringArea = (ring) => {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    return Math.abs(a / 2);
  };
  if (geom.type === 'Polygon') return ringArea(geom.coordinates[0]);
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((s, p) => s + ringArea(p[0]), 0);
  return 0;
}

// Simplify playable + context together (shared borders stay watertight).
function simplifyAll(items, ctx, q) {
  if (!q) return { items, ctx };
  const all = [...items, ...ctx];
  const fc = { type: 'FeatureCollection', features: all.map((it) => ({ type: 'Feature', properties: {}, geometry: it.geometry })) };
  let topo = topology({ u: fc }, 1e5);
  topo = presimplify(topo);
  topo = simplify(topo, quantile(topo, q));
  const simple = all.map((it, i) => ({ ...it, geometry: feature(topo, topo.objects.u.geometries[i]).geometry }));
  return { items: simple.slice(0, items.length), ctx: simple.slice(items.length) };
}

// Round path coordinates to 1 decimal (d3-geo ≥3.1 has .digits(); fall back to no-op).
function makePath(projection) {
  const path = geoPath(projection);
  if (typeof path.digits === 'function') path.digits(1);
  return path;
}

// Circle path for territories that are invisibly small once projected.
const DOT_R = 5;
function dotPath(cx, cy, r = DOT_R) {
  const f = (n) => Math.round(n * 10) / 10;
  return `M${f(cx - r)},${f(cy)}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0Z`;
}

// Label anchor: centroid of the largest projected polygon that lands inside
// the viewBox (multipolygon mean puts France's label in the sea).
function labelAnchor(item, path, w, h) {
  if (item.labelLonLat) {
    const pt = path.projection()(item.labelLonLat);
    if (pt && pt[0] >= 0 && pt[0] <= w && pt[1] >= 0 && pt[1] <= h) return pt;
  }
  const polys = item.geometry.type === 'Polygon' ? [item.geometry.coordinates] : item.geometry.coordinates;
  let best = null, bestIn = null;
  for (const coords of polys) {
    const poly = { type: 'Polygon', coordinates: coords };
    const a = Math.abs(path.area(poly));
    const c = path.centroid(poly);
    if (!Number.isFinite(c[0])) continue;
    const inside = c[0] >= 0 && c[0] <= w && c[1] >= 0 && c[1] <= h;
    if (!best || a > best.a) best = { a, c };
    if (inside && (!bestIn || a > bestIn.a)) bestIn = { a, c };
  }
  return (bestIn || best)?.c ?? [w / 2, h / 2];
}

function buildRegion(region, sources) {
  console.log(`— ${region.id}`);
  let items = collectFeatures(region, sources);
  let ctx = collectContext(region, sources);
  ({ items, ctx } = simplifyAll(items, ctx, region.simplifyQ));
  const lakes = collectLakes(region, sources);

  const drawFC = { type: 'FeatureCollection', features: items.map((it) => ({ type: 'Feature', properties: {}, geometry: it.geometry })) };
  const fitFC = region.fitExclude
    ? { type: 'FeatureCollection', features: items.filter((it) => !region.fitExclude.includes(it.id)).map((it) => ({ type: 'Feature', properties: {}, geometry: it.geometry })) }
    : drawFC;

  const projection = region.proj();
  projection.fitWidth(W, fitFC);
  let path = makePath(projection);
  // Normalise so the fitted content starts at (0,0); height from the fit set.
  const b = path.bounds(fitFC);
  const t = projection.translate();
  projection.translate([t[0] - b[0][0], t[1] - b[0][1]]);
  path = makePath(projection);
  const h = Math.ceil(path.bounds(fitFC)[1][1]) + 1;
  // Clip to the frame in projected space (composite geoAlbersUsa lacks
  // clipExtent — it clips to the US insets by construction). Crops windowSkip
  // geometry (Russia's far east), all context land, and lakes to the frame.
  if (typeof projection.clipExtent === 'function') {
    projection.clipExtent([[-2, -2], [W + 2, h + 2]]);
    path = makePath(projection);
  }

  const out = [];
  for (const item of items) {
    const f = { type: 'Feature', properties: {}, geometry: item.geometry };
    let d = path(f);
    const bb = path.bounds(f);
    let [cx, cy] = labelAnchor(item, path, W, h);
    let dot = false;
    const tiny = !d || (bb[1][0] - bb[0][0]) + (bb[1][1] - bb[0][1]) < 7;
    if (tiny) {
      dot = true;
      d = dotPath(cx, cy);
      bb[0][0] = cx - DOT_R; bb[0][1] = cy - DOT_R; bb[1][0] = cx + DOT_R; bb[1][1] = cy + DOT_R;
    }
    const r1 = (n) => Math.round(n * 10) / 10;
    const entry = {
      id: item.id, name: item.name,
      d, cx: r1(cx), cy: r1(cy),
      bbox: [r1(bb[0][0]), r1(bb[0][1]), r1(bb[1][0]), r1(bb[1][1])],
    };
    if (item.alt.length) entry.alt = item.alt;
    if (dot) entry.dot = true;
    out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));

  // Context + lakes render as bare path strings (no interaction, no names).
  const inFrame = (bb) => bb[0][0] < W && bb[1][0] > 0 && bb[0][1] < h && bb[1][1] > 0;
  const layer = (feats) => feats
    .map((it) => {
      const f = { type: 'Feature', properties: {}, geometry: it.geometry };
      const d = path(f);
      return d && inFrame(path.bounds(f)) ? d : null;
    })
    .filter(Boolean);

  const json = {
    id: region.id, label: region.label, kind: region.kind, w: W, h,
    credit: 'Map data: Natural Earth (public domain)',
    items: out,
    ctx: layer(ctx),
    lakes: layer(lakes),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${region.id}.json`), JSON.stringify(json));
  const kb = Math.round(JSON.stringify(json).length / 1024);
  console.log(`  ${out.length} items, ${json.ctx.length} ctx, ${json.lakes.length} lakes, ${W}×${h}, ${kb} KB${out.filter((o) => o.dot).length ? `, dots: ${out.filter((o) => o.dot).map((o) => o.id).join(' ')}` : ''}`);
}

// ---- main -------------------------------------------------------------------

const wanted = process.argv.slice(2);
const regions = wanted.length ? REGIONS.filter((r) => wanted.includes(r.id)) : REGIONS;
if (!regions.length) { console.error(`Unknown region(s): ${wanted}. Known: ${REGIONS.map((r) => r.id).join(' ')}`); process.exit(1); }

const sources = {
  admin0: JSON.parse(readFileSync(download(SOURCES.admin0), 'utf8')),
  lakes: JSON.parse(readFileSync(download(SOURCES.lakes), 'utf8')),
};
if (regions.some((r) => r.kind === 'states' || r.ctxAdmin1)) {
  sources.admin1 = JSON.parse(readFileSync(download(SOURCES.admin1), 'utf8'));
}

for (const region of regions) buildRegion(region, sources);
console.log('done.');
