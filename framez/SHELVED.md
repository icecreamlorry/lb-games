# Framez — shelved

**Status:** shelved 2026-07-21. Idea was sound but the data spine doesn't support it well enough to build on yet. This doc preserves the feasibility findings so we can restart cleanly if we come back.

## The idea

A guessing game built around paintings. The design need was a supply of works that are **"known but not iconic"** — recognizable enough to be fair, obscure enough to be a real challenge. Too iconic (Mona Lisa, Starry Night) is trivial; too obscure is unguessable.

## Approach tested

- **Spine:** Wikidata as the catalogue of works per artist (SPARQL: paintings by creator, with P18 image).
- **Fame weight:** number of Wikidata **sitelinks** on a work as a proxy for how well-known it is.
- **"Non-iconic" band:** works with `2 ≤ sitelinks < p85(artist)` — i.e. above the floor but below the artist's own 85th percentile. Threshold is **per-artist**, so it self-scales.
- Probe script: `framez/tools/art-probe.mjs`, run over 8 artists.

## Results (8-artist probe)

| Artist | Paintings | With image (P18) | Non-iconic band |
|---|---|---|---|
| Claude Monet | 1209 | 1193 | 0 |
| Rembrandt | 755 | 709 | 119 |
| Johannes Vermeer | 36 | 36 | 28 |
| Vincent van Gogh | 891 | 885 | 320 |
| Katsushika Hokusai | 119 | 93 | 0 |
| Artemisia Gentileschi | 133 | 132 | 40 |
| Frida Kahlo | 35 | **0** | 0 |
| Georgia O'Keeffe | 192 | **18** | 0 |

**Only 4/8 artists** (Rembrandt, Vermeer, van Gogh, Artemisia) yielded ≥8 usable non-iconic works with images.

## Why we shelved it — key findings

1. **Image coverage is the bottleneck, not fame.** The artists that fell out (Kahlo 0/35, O'Keeffe 18/192, Hokusai 93/119) failed mostly on missing P18 images. For 20th-century artists this is almost certainly **copyright** — Wikidata won't host P18 images for in-copyright works. This is structural: no pipeline effort fixes Kahlo via this route. A real build would need an alternative image source (Wikimedia Commons, museum open-access APIs like the Met / Art Institute of Chicago) for modern artists.

2. **The per-artist p85 band means "non-iconic" is relative, not absolute.** Vermeer's band works still carry 24–25 sitelinks — famous paintings by any absolute measure — because his whole corpus is famous. Meanwhile Monet's median is 0 sitelinks, so his band collapses to 0. The threshold logic works as designed but doesn't produce a consistent difficulty level across artists. A restart would likely want an **absolute** fame band (or a hybrid) rather than purely per-artist percentiles.

3. **Data hygiene:** the van Gogh band surfaced two `genid` blank-node values (`.well-known/genid/...`) where a museum/collection name should be. Filter these out if collection is ever a display or answer field.

## If we restart

- Solve the modern-artist image gap first (Commons / museum open-access APIs) — it's the make-or-break constraint.
- Reconsider the fame band: absolute sitelink thresholds, or blend sitelinks with pageview data.
- Curate the artist roster to those with strong open-access image coverage rather than assuming Wikidata P18 is enough.
- Script to resurrect: `framez/tools/art-probe.mjs`.
