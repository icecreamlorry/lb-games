// SCRAMBLR "common words" builder — splits the ENABLE dictionary into the
// words an ordinary player would kick themselves for missing ("common") and
// the Scrabble-list oddities nobody has heard of ("obscure"). The results
// screen uses the split so a player sees "you missed 3 common words" instead
// of one 25-word wall where 22 are AAL, KEX and PYIC.
//
//   node scramblr/tools/build-common.mjs [--cache DIR]
//
// Writes scramblr/data/common.txt (one lowercase word per line, sorted, same
// format as dictionary.txt) — commit the regenerated file. Sources are
// downloaded once into the cache dir (default: <os tmp>/lb-scramblr-common):
//
//   - SCOWL 2020.12.07 (wordlist.sourceforge.net) — curated, dictionary-derived
//     word lists in nested "sizes" (10 … 95). Size 35 is a small spell-checker,
//     50 medium, 70 large, 80+ "the strange words people use in Scrabble". The
//     size is the backbone: it's clean of names and foreign words, which raw
//     frequency counts are not (COLIN, DONNA, LOUIS are all high-frequency
//     tokens and all ENABLE words).
//   - hermitdave/FrequencyWords en_full (OpenSubtitles 2018) — per-million
//     spoken frequency. Prunes the size-50 words nobody actually says (CALKS,
//     ENURE, RIFER) and lets British/slang words that SCOWL only lists at 55/60
//     (BLOKE, AUNTY, DODGY) count as common when people say them a lot.
//   - Norvig's count_1w.txt (Google web trillion-word corpus) — per-million
//     written frequency. A secondary route in for written-not-spoken words
//     (DATUM, VERTEX, PAYEE) that subtitles under-count.
//
// RULE (per word, sc = smallest SCOWL size listing it, subs/web = per-million):
//   common  <=>  sc <= 50 and (subs >= 0.1 or web >= 0.5)
//            or  sc <= 60 and subs >= 0.5
//            or  an inflection of a common word: strip -s/-es/-ies/-ed/-ing/
//                -er/-est/-ly, and the stem is itself a solidly common
//                dictionary word (sc <= 50, subs >= 0.5). RUSES / BARDS / LAZILY
//                are rare as tokens but nobody who knows RUSE would call RUSES
//                obscure — and plurals are most of what a 4x4 board yields.
//            or  sc > 60 but plainly in everyday use — spoken AND written at
//                >= 2 per million — and not in SCOWL's proper-names lists (SNUCK,
//                LATINO, BACHELORETTE; the lists are conservative about slang and
//                new words). The names filter matters: without it that bucket is
//                almost entirely APACHE, DEVON, TAMMY.
//   Everything else is obscure. The inflection route also requires the form
//   itself to be attested at all (subs >= 0.01 or web >= 0.05) so ghost forms
//   like NIGHS and JUSTS don't ride in on their stem, and it doesn't try plain
//   -er/-est (agent nouns — HEXER, HOPER — are rarely what a player knows).
// SCOWL dialects used: english + american + british + british_z + canadian +
// australian, plus each one's variant_1 (common alternative spellings);
// variant_2/3 (DOPY, SHLEP) are skipped. Accents are stripped so SCOWL's
// "café"/"cliché" match ENABLE's CAFE/CLICHE.
//
// Knobs are the constants below. Re-run and eyeball the printed samples after
// changing one — "common" is a judgement call, and the samples are the test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DICT_PATH = path.join(HERE, '..', 'data', 'dictionary.txt');
const OUT_PATH = path.join(HERE, '..', 'data', 'common.txt');

const SOURCES = {
  scowl: { file: 'scowl-2020.12.07.tar.gz', url: 'https://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz' },
  subs: { file: 'subs_en_full.txt', url: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt' },
  web: { file: 'count_1w.txt', url: 'https://norvig.com/ngrams/count_1w.txt' },
};
const DIALECTS = /^(english|american|british|british_z|canadian|australian)(_variant_1)?-words\.(\d+)$/;
// Names live in -proper-names, but SCOWL files most first names, places and
// nationalities under -upper (capitalised words) — both are excluded from the
// everyday route, at the cost of GREEK/SWISS/EASTER counting as obscure.
const NAMES = /-(proper-names|upper)\.\d+$/;

// The knobs.
const SC_CORE = 50, SC_SLANG = 60;
const SUBS_CORE = 0.1, WEB_CORE = 0.5; // sc <= 50 needs either
const SUBS_SLANG = 0.5;                // sc 55/60 needs spoken use
const STEM_SUBS = 0.5;                 // inflection route: the stem must be this common
const ATTESTED_SUBS = 0.01, ATTESTED_WEB = 0.05; // ...and the form must exist somewhere
const EVERYDAY = 2;                    // sc > 60 route: spoken AND written this often

const argv = process.argv.slice(2);
const cacheDir = argv.includes('--cache') ? argv[argv.indexOf('--cache') + 1] : path.join(os.tmpdir(), 'lb-scramblr-common');
fs.mkdirSync(cacheDir, { recursive: true });

async function fetchCached(key) {
  const { file, url } = SOURCES[key];
  const p = path.join(cacheDir, file);
  if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
  console.log(`downloading ${url}`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  return p;
}

// Minimal tar reader: yields { name, body } for regular files. SCOWL's paths
// are short, but GNU long-name entries are handled in case a future release
// isn't.
function* tarEntries(buf) {
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, b) => hdr.toString('latin1', a, b).replace(/\0[\s\S]*$/, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = str(156, 157);
    const prefix = str(345, 500);
    const name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = body.toString('latin1').replace(/\0[\s\S]*$/, '');
    else if (type === '0' || type === '') yield { name, body };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

async function main() {
  const dict = fs.readFileSync(DICT_PATH, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const D = new Set(dict);

  // Per-million frequencies, restricted to dictionary words.
  const loadFreq = (file, sep) => {
    const m = new Map(); let total = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const [w, c] = line.trim().split(sep); const n = +c;
      if (!w || !n) continue;
      total += n;
      if (D.has(w) && !m.has(w)) m.set(w, n);
    }
    const pm = new Map(); for (const [w, n] of m) pm.set(w, (n / total) * 1e6);
    return pm;
  };
  const subs = loadFreq(await fetchCached('subs'), ' ');
  const web = loadFreq(await fetchCached('web'), '\t');

  // Smallest SCOWL size per dictionary word.
  const size = new Map(), names = new Set();
  const tar = zlib.gunzipSync(fs.readFileSync(await fetchCached('scowl')));
  let files = 0;
  for (const { name, body } of tarEntries(tar)) {
    if (!name.includes('/final/')) continue;
    if (NAMES.test(name)) {
      for (const line of body.toString('latin1').split('\n')) names.add(deaccent(line.trim()).toLowerCase());
      continue;
    }
    const m = path.basename(name).match(DIALECTS);
    if (!m) continue;
    files++;
    const n = +m[3];
    for (const line of body.toString('latin1').split('\n')) {
      const w = deaccent(line.trim()).toLowerCase();
      if (!w || !D.has(w)) continue;
      if (!size.has(w) || size.get(w) > n) size.set(w, n);
    }
  }
  if (!files) throw new Error('no SCOWL word lists found in the tarball');

  const S = (w) => subs.get(w) ?? 0, W = (w) => web.get(w) ?? 0, SC = (w) => size.get(w) ?? 99;
  const base = (w) => (SC(w) <= SC_CORE && (S(w) >= SUBS_CORE || W(w) >= WEB_CORE)) || (SC(w) <= SC_SLANG && S(w) >= SUBS_SLANG);
  const everyday = (w) => S(w) >= EVERYDAY && W(w) >= EVERYDAY && !names.has(w);
  const attested = (w) => S(w) >= ATTESTED_SUBS || W(w) >= ATTESTED_WEB;
  const solid = (w) => D.has(w) && SC(w) <= SC_CORE && S(w) >= STEM_SUBS;

  // Candidate stems for an inflected form. Deliberately naive — a wrong stem
  // only matters if it's ALSO a solidly common word, which is rare (and then
  // usually harmless: FLIED -> FLY).
  function stems(w) {
    const out = [];
    const cut = (n, add = '') => { if (w.length - n >= 3) out.push(w.slice(0, -n) + add); };
    const dbl = (n) => { const i = w.length - n; if (i >= 4 && w[i - 1] === w[i - 2]) out.push(w.slice(0, i - 1)); };
    if (w.endsWith('ies')) cut(3, 'y');
    if (/(s|x|z|ch|sh)es$/.test(w)) cut(2); // -es only after a sibilant; otherwise it's stem+e+s
    if (w.endsWith('s') && !w.endsWith('ss')) cut(1);
    if (w.endsWith('ied')) cut(3, 'y');
    if (w.endsWith('ed')) { cut(2); cut(1); dbl(2); }
    if (w.endsWith('ing')) { cut(3); cut(3, 'e'); dbl(3); }
    if (w.endsWith('ier')) cut(3, 'y');
    if (w.endsWith('iest')) cut(4, 'y');
    if (w.endsWith('ily')) cut(3, 'y');
    if (w.endsWith('ly')) cut(2);
    return out;
  }

  const common = [], viaStem = [], viaEveryday = [];
  for (const w of dict) {
    if (base(w)) common.push(w);
    else if (everyday(w)) { common.push(w); viaEveryday.push(w); }
    else if (attested(w) && stems(w).some(solid)) { common.push(w); viaStem.push(w); }
  }
  common.sort();
  fs.writeFileSync(OUT_PATH, common.join('\n') + '\n');

  // Report.
  const byLen = (arr) => { const c = {}; for (const w of arr) c[w.length] = (c[w.length] || 0) + 1; return c; };
  const cl = byLen(common), dl = byLen(dict);
  console.log(`\n${common.length} common of ${dict.length} dictionary words -> ${path.relative(process.cwd(), OUT_PATH)}`);
  console.log('by length: ' + Object.keys(dl).sort((a, b) => a - b).map((l) => `${l}:${cl[l] || 0}/${dl[l]}`).join('  '));
  console.log(`${viaStem.length} admitted as inflections of a common stem, ${viaEveryday.length} as everyday words SCOWL rates > 60`);
  const sample = (arr, n) => arr.slice().sort(() => Math.random() - 0.5).slice(0, n).join(' ');
  const set = new Set(common);
  const short = (arr) => arr.filter((w) => w.length <= 5);
  console.log('\nsample common (<=5 letters):  ' + sample(short(common), 60));
  console.log('\nsample via stem (<=5 letters): ' + sample(short(viaStem), 60));
  console.log('\nall everyday (> 60) admissions: ' + viaEveryday.join(' '));
  console.log('\nsample obscure (<=5 letters):  ' + sample(short(dict.filter((w) => !set.has(w))), 60));
  console.log('\nobscure but spoken >=1/M (should mostly be names/foreign): ' + sample(dict.filter((w) => !set.has(w) && S(w) >= 1), 60));
}

main().catch((e) => { console.error(e); process.exit(1); });
