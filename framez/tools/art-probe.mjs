#!/usr/bin/env node
// art-probe.mjs — feasibility probe for an art-guessing game dataset.
//
// Uses Wikidata as the spine: for each artist it pulls EVERY painting whose
// creator is that artist, with an image, inception year, owning collection,
// and a fame weight (# of Wikipedia sitelinks). Optionally layers real
// Wikipedia pageviews on top for a stronger popularity signal.
//
// Nothing is written; it just prints a coverage report so we can decide the
// fame floor per artist before building anything. Runs on a normal internet
// connection (Wikidata is blocked from the Claude sandbox). Node 18+.
//
//   node art-probe.mjs                      # default artist sample
//   node art-probe.mjs "Claude Monet" "Rembrandt"   # custom list
//   PAGEVIEWS=1 node art-probe.mjs          # also fetch monthly pageviews (slower)

const UA = 'lb-games-art-probe/0.1 (dataset feasibility; contact: ice.cream.lorry@googlemail.com)';
const SPARQL = 'https://query.wikidata.org/sparql';
const WVIEWS = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';

const ARTISTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'Claude Monet',        // impressionist, huge catalog
      'Rembrandt',           // dutch master
      'Johannes Vermeer',    // small catalog, all famous
      'Vincent van Gogh',
      'Katsushika Hokusai',  // non-western coverage test
      'Artemisia Gentileschi', // thinner coverage test
      'Frida Kahlo',         // 20th c., copyright caveats
      'Georgia O\'Keeffe',
    ];

async function sparql(query) {
  const url = `${SPARQL}?format=json&query=${encodeURIComponent(query)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
  if (!r.ok) throw new Error(`SPARQL ${r.status} ${r.statusText}`);
  return (await r.json()).results.bindings;
}

// Resolve an artist name -> QID via the entity search API.
async function resolveArtist(name) {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=1&search=${encodeURIComponent(name)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  return j.search?.[0]?.id || null;
}

// Every painting by this creator, fame-weighted by sitelink count.
async function paintingsFor(qid) {
  const q = `
    SELECT ?painting ?paintingLabel ?image ?inception ?collectionLabel ?sitelinks WHERE {
      ?painting wdt:P170 wd:${qid} ;
                wdt:P31 wd:Q3305213 .
      OPTIONAL { ?painting wdt:P18 ?image. }
      OPTIONAL { ?painting wdt:P571 ?inception. }
      OPTIONAL { ?painting wdt:P195 ?collection. }
      ?painting wikibase:sitelinks ?sitelinks .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } ORDER BY DESC(?sitelinks)`;
  const rows = await sparql(q);
  // Collapse multiple images/collections per painting into one record.
  const byId = new Map();
  for (const b of rows) {
    const id = b.painting.value.split('/').pop();
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        title: b.paintingLabel?.value || id,
        image: b.image?.value || null,
        year: b.inception?.value ? new Date(b.inception.value).getUTCFullYear() : null,
        collection: b.collectionLabel?.value || null,
        sitelinks: Number(b.sitelinks?.value || 0),
      });
    } else if (b.image?.value && !byId.get(id).image) {
      byId.get(id).image = b.image.value;
    }
  }
  return [...byId.values()];
}

async function monthlyViews(title) {
  const end = new Date(); const start = new Date(end); start.setMonth(start.getMonth() - 3);
  const f = (d) => d.toISOString().slice(0, 10).replace(/-/g, '') + '00';
  const t = encodeURIComponent(title.replace(/ /g, '_'));
  try {
    const r = await fetch(`${WVIEWS}/${t}/monthly/${f(start)}/${f(end)}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const items = (await r.json()).items || [];
    if (!items.length) return null;
    return Math.round(items.reduce((s, i) => s + i.views, 0) / items.length);
  } catch { return null; }
}

const pct = (arr, p) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : 0;

(async () => {
  console.log(`Probing ${ARTISTS.length} artists — spine: Wikidata; weight: sitelinks${process.env.PAGEVIEWS ? ' + pageviews' : ''}\n`);
  const summary = [];
  for (const name of ARTISTS) {
    try {
      const qid = await resolveArtist(name);
      if (!qid) { console.log(`✗ ${name}: no Wikidata match\n`); continue; }
      const all = await paintingsFor(qid);
      const withImg = all.filter((p) => p.image);
      const sl = withImg.map((p) => p.sitelinks);
      // "known but not iconic" band: drop the top ~15% (the postcard hits) and
      // anything with <2 sitelinks (essentially unknown), keep the rest.
      const iconicFloor = pct(sl, 0.85);
      const band = withImg.filter((p) => p.sitelinks >= 2 && p.sitelinks < iconicFloor);
      console.log(`● ${name} (${qid})`);
      console.log(`    paintings in Wikidata: ${all.length}   with image (P18): ${withImg.length}`);
      console.log(`    sitelinks  min ${pct(sl,0)} · median ${pct(sl,0.5)} · p85 ${iconicFloor} · max ${pct(sl,1)}`);
      console.log(`    "known but not iconic" band (2 ≤ sitelinks < ${iconicFloor}): ${band.length} works`);
      const show = (process.env.PAGEVIEWS ? band : band).slice(0, 5);
      for (const p of show) {
        let extra = '';
        if (process.env.PAGEVIEWS) { const v = await monthlyViews(p.title); extra = v == null ? ' · views n/a' : ` · ~${v.toLocaleString()} views/mo`; }
        console.log(`      · ${p.title} (${p.year ?? '?'}) — ${p.sitelinks} links${extra}${p.collection ? ' · ' + p.collection : ''}`);
      }
      console.log('');
      summary.push({ name, total: all.length, withImg: withImg.length, band: band.length });
    } catch (e) {
      console.log(`✗ ${name}: ${e.message}\n`);
    }
  }
  console.log('── summary ─────────────────────────────');
  for (const s of summary) console.log(`  ${s.name.padEnd(24)} img ${String(s.withImg).padStart(4)}   band ${String(s.band).padStart(4)}`);
  const playable = summary.filter((s) => s.band >= 8).length;
  console.log(`\n  ${playable}/${summary.length} artists have ≥8 usable "non-iconic" works with images.`);
})();
