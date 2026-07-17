// ATOMYX data builder.
//
//   node atomyx/tools/build-data.mjs
//
// Produces atomyx/data/elements.json — playable sets + per-element data
// (checked in; the game never fetches or computes at runtime).
//
// Source: Bowserinator/Periodic-Table-JSON (CC-BY-SA), fetched from
// raw.githubusercontent.com into the gitignored tools/cache/.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'cache');
const DATA = join(HERE, '..', 'data');
const SRC_URL = 'https://raw.githubusercontent.com/Bowserinator/Periodic-Table-JSON/master/PeriodicTableJSON.json';

// ---- Grid layout ------------------------------------------------------------
// Position computed from the atomic number ALONE — the table's shape is fixed,
// so this is deterministic and immune to dataset quirks. 18 columns; rows 1-7
// are the main table; rows 9/10 are the lanthanide/actinide shelf at cols 3-17
// (row 8 is a spacer in the CSS grid).

const PERIODS = [[1, 2], [3, 10], [11, 18], [19, 36], [37, 54], [55, 86], [87, 118]];

function pos(num) {
  if (num >= 57 && num <= 71) return { x: 3 + num - 57, y: 9 };
  if (num >= 89 && num <= 103) return { x: 3 + num - 89, y: 10 };
  const p = PERIODS.findIndex(([a, b]) => num >= a && num <= b) + 1;
  const [a, b] = PERIODS[p - 1];
  const idx = num - a;
  if (p === 1) return { x: num === 1 ? 1 : 18, y: 1 };
  if (p <= 3) return { x: idx < 2 ? idx + 1 : 18 - (b - num), y: p };
  if (p <= 5) return { x: idx + 1, y: p };
  // Periods 6/7: 2 s-block cells, then the f-block (on the shelf), then 4..18.
  if (idx < 2) return { x: idx + 1, y: p };
  return { x: 4 + (num - (a + 17)), y: p };
}

// ---- Families ----------------------------------------------------------------
// The exact 12-way column partition (sums to 118). Stored per element as `fam`
// for future modes (FAMILY quiz, family colouring) and used to derive sets.

function famOf(num) {
  if (num === 1) return 'hydrogen';
  if ([3, 11, 19, 37, 55, 87].includes(num)) return 'alkali';
  if ([4, 12, 20, 38, 56, 88].includes(num)) return 'alkaline';
  if (num >= 57 && num <= 71) return 'lanthanide';
  if (num >= 89 && num <= 103) return 'actinide';
  if ([2, 10, 18, 36, 54, 86, 118].includes(num)) return 'noble';
  const col = pos(num).x;
  if (col >= 3 && col <= 12) return 'transition';
  return ['boron', 'carbon', 'pnictogen', 'chalcogen', 'halogen'][col - 13];
}

// ---- Name/alias overrides -----------------------------------------------------
// IUPAC spellings as primary (Aluminium, Caesium, Sulfur), the other spelling as
// an alias, plus the classic alternative names people genuinely use.

const NAMES = {
  13: { name: 'Aluminium', alt: ['aluminum'] },
  55: { name: 'Caesium', alt: ['cesium'] },
  16: { name: 'Sulfur', alt: ['sulphur'] },
  74: { alt: ['wolfram'] },
  80: { alt: ['quicksilver'] },
  11: { alt: ['natrium'] },
  19: { alt: ['kalium'] },
  26: { alt: ['ferrum'] },
  47: { alt: ['argentum'] },
  79: { alt: ['aurum'] },
  82: { alt: ['plumbum'] },
  50: { alt: ['stannum'] },
};

// ---- Sets ----------------------------------------------------------------------
// The playable slices. Family sets are exact; first20/everyday are curated tiers.

const EVERYDAY = [1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20,
  22, 26, 28, 29, 30, 47, 50, 53, 74, 78, 79, 80, 82, 92];

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const SETS = [
  { id: 'all', label: 'Whole Table', nums: range(1, 118) },
  { id: 'first20', label: 'The First 20', nums: range(1, 20) },
  { id: 'everyday', label: 'Everyday 30', nums: EVERYDAY },
  { id: 'alkline', label: 'Alkali & Alkaline', nums: [3, 11, 19, 37, 55, 87, 4, 12, 20, 38, 56, 88].sort((a, b) => a - b) },
  { id: 'salts', label: 'Halogens & Nobles', nums: [9, 17, 35, 53, 85, 117, 2, 10, 18, 36, 54, 86, 118].sort((a, b) => a - b) },
  { id: 'transition', label: 'Transition Metals', nums: [...range(21, 30), ...range(39, 48), ...range(72, 80), ...range(104, 112)] },
  { id: 'pblock', label: 'Groups 13 to 16', nums: range(1, 118).filter((n) => ['boron', 'carbon', 'pnictogen', 'chalcogen'].includes(famOf(n))) },
  { id: 'lanthanides', label: 'Lanthanides', nums: range(57, 71) },
  { id: 'actinides', label: 'Actinides', nums: range(89, 103) },
];

// ---- Load source -----------------------------------------------------------------

function loadSource() {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, 'PeriodicTableJSON.json');
  if (!existsSync(path)) {
    console.log('downloading Periodic-Table-JSON…');
    execFileSync('curl', ['-sS', '--fail', '--max-time', '300', '-o', path, SRC_URL], { stdio: 'inherit' });
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---- Build -------------------------------------------------------------------------

const src = loadSource().elements.filter((e) => e.number <= 118);
if (src.length !== 118) throw new Error(`expected 118 elements, got ${src.length}`);

const elements = {};
const byNum = {};
for (const e of src.sort((a, b) => a.number - b.number)) {
  const over = NAMES[e.number] || {};
  const { x, y } = pos(e.number);
  const entry = {
    name: over.name || e.name,
    sym: e.symbol,
    num: e.number,
    mass: Math.round(e.atomic_mass * 10000) / 10000,
    x, y,
    fam: famOf(e.number),
    cat: e.category,
    // Phases of elements ≥100 have never been observed in bulk — the dataset's
    // predictions (liquid copernicium!) shouldn't be taught as fact.
    phase: e.number >= 100 ? '?' : { Solid: 's', Liquid: 'l', Gas: 'g' }[e.phase] || '?',
  };
  if (Number.isFinite(e.melt)) entry.melt = Math.round(e.melt * 100) / 100;
  if (Number.isFinite(e.electronegativity_pauling)) entry.en = e.electronegativity_pauling;
  if (over.alt?.length) entry.alt = over.alt;
  const id = e.symbol.toLowerCase();
  elements[id] = entry;
  byNum[e.number] = id;
}

const out = {
  credit: 'Element data: Periodic-Table-JSON by Bowserinator (CC-BY-SA).',
  sets: SETS.map((s) => ({ id: s.id, label: s.label, els: s.nums.map((n) => byNum[n]).join(' ') })),
  elements,
};
mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'elements.json'), JSON.stringify(out));

// Report + sanity
console.log(`elements: ${Object.keys(elements).length}`);
for (const s of out.sets) console.log(`  ${s.id}: ${s.els.split(' ').length}`);
const famCounts = {};
for (const el of Object.values(elements)) famCounts[el.fam] = (famCounts[el.fam] || 0) + 1;
console.log('families:', JSON.stringify(famCounts));
const seen = new Set();
for (const [id, el] of Object.entries(elements)) {
  const key = `${el.x},${el.y}`;
  if (seen.has(key)) throw new Error(`grid collision at ${key} (${id})`);
  if (el.x < 1 || el.x > 18 || el.y < 1 || el.y > 10 || el.y === 8) throw new Error(`bad pos ${key} (${id})`);
  seen.add(key);
}
console.log('grid: all positions unique & in range');
const spot = (id) => console.log(`  ${id}: ${elements[id].name} #${elements[id].num} @${elements[id].x},${elements[id].y} ${elements[id].mass}u ${elements[id].fam} ${elements[id].phase}`);
['h', 'fe', 'w', 'la', 'og', 'hg', 'br'].forEach(spot);
