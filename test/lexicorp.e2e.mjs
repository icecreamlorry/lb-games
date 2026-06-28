// End-to-end smoke test for Lexicorp's turn-based gameplay over the shared
// rooms layer. Serves the repo, stubs the Supabase CDN with the in-memory
// stub (which seeds a second player on room insert so the host can start),
// then drives a real turn: create room → start → build a dictionary word from
// the dealt hand → play → assert earnings and that the turn passes.
//
// Run (Playwright must be resolvable, e.g. via NODE_PATH):
//   NODE_PATH=/opt/node22/lib/node_modules \
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
//   node test/lexicorp.e2e.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STUB = fs.readFileSync(path.join(HERE, 'supabase-stub.mjs'), 'utf8');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

function serve() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  — ' + detail}`);
}

(async () => {
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ viewport: { width: 411, height: 914 } });
  await ctx.route('**://cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: STUB }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // The "your turn" push is fire-and-forget; stub the Edge Function so the test
  // sandbox doesn't log a CORS/network error for it.
  await ctx.route(/functions\/v1\/notify/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await ctx.addInitScript(() => { localStorage.setItem('lbgames.name', 'Alice'); });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });

  await page.goto(`${base}/lexicorp/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  check('landing shown for guest', await page.evaluate(() => !document.getElementById('screen-landing').classList.contains('hidden')));

  // Create a room — the stub seeds a 2nd player, so START is enabled.
  await page.click('#btn-create');
  await page.waitForTimeout(700);
  check('game screen shown after create', await page.evaluate(() => !document.getElementById('screen-game').classList.contains('hidden')));
  check('prestart overlay visible', await page.evaluate(() => !document.getElementById('prestart-overlay').classList.contains('hidden')));
  check('START enabled with 2 players', await page.evaluate(() => !document.getElementById('btn-start').disabled));
  // The waiting overlay must not bury the header — you have to be able to quit.
  check('header LEAVE reachable while waiting (not occluded)', await page.evaluate(() => {
    const b = document.getElementById('btn-leave'); const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === b || b.contains(top);
  }));
  check('prestart overlay has its own LEAVE button', await page.evaluate(() => {
    const b = document.getElementById('btn-prestart-leave');
    return !!b && !b.classList.contains('hidden') && b.offsetParent !== null;
  }));

  await page.click('#btn-start');
  await page.waitForTimeout(400);

  const dealt = await page.evaluate(() => ({
    hand: document.querySelectorAll('#hand .tile').length,
    pool: document.querySelectorAll('#pool .tile').length,
    patents: document.querySelectorAll('#patents .pat').length,
    banner: document.getElementById('turn-banner').textContent,
  }));
  check('hand dealt 7 tiles', dealt.hand === 7, `got ${dealt.hand}`);
  check('pool has 3 tiles', dealt.pool === 3, `got ${dealt.pool}`);
  check('patents grid has 26 letters', dealt.patents === 26, `got ${dealt.patents}`);
  check('my turn banner shows', /YOUR TURN/.test(dealt.banner), dealt.banner);

  // Make sure the dictionary is loaded, then find a real word from the hand.
  await page.evaluate(async () => {
    const dict = await import('/lexicorp/js/dictionary.js');
    await dict.loadDictionary();
  });

  const plan = await page.evaluate(async () => {
    const dict = await import('/lexicorp/js/dictionary.js');
    const letters = Array.from(document.querySelectorAll('#hand .tile')).map((t) => t.textContent);
    // Search ordered triples of distinct hand positions for a valid word.
    const n = letters.length;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
      if (a === b || a === c || b === c) continue;
      const w = letters[a] + letters[b] + letters[c];
      if (dict.isWord(w)) return { idx: [a, b, c], word: w };
    }
    return null;
  });
  check('found a playable 3-letter word in hand', !!plan, 'no word found in dealt hand');

  if (plan) {
    const moneyBefore = await page.evaluate(() => Number(document.querySelector('#players-strip .pchip.me .pstats span').textContent.replace('$', '')));
    // Click the hand tiles in word order. The hand re-renders after each tap,
    // so re-query by position every time (tile positions are stable).
    for (const i of plan.idx) {
      const tiles = await page.$$('#hand .tile');
      await tiles[i].click();
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(150);
    check('word preview accepts the word', await page.evaluate(() => document.getElementById('word-preview').classList.contains('ok')));
    check('PLAY enabled for valid word', await page.evaluate(() => !document.getElementById('btn-play').disabled));

    await page.click('#btn-play');
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => ({
      money: Number(document.querySelector('#players-strip .pchip.me .pstats span').textContent.replace('$', '')),
      banner: document.getElementById('turn-banner').textContent,
      hand: document.querySelectorAll('#hand .tile').length,
      movesInDb: (globalThis.__DB?.moves || []).length,
    }));
    check('money increased after playing', after.money > moneyBefore, `before ${moneyBefore} after ${after.money}`);
    check('hand refilled back to 7', after.hand === 7, `got ${after.hand}`);
    check('turn passed to opponent', /turn/i.test(after.banner) && !/YOUR TURN/.test(after.banner), after.banner);
    check('move written to moves table', after.movesInDb >= 2, `got ${after.movesInDb} (start + play)`);
  }

  // Opponent's move arrives via the DB poll: inject a seat-1 swap and confirm
  // the client replays it and hands the turn back to us.
  const code = await page.evaluate(() => Array.from(globalThis.__DB.rooms.keys())[0]);
  await page.evaluate((c) => globalThis.__DB.moves.push({ room_code: c, move_index: 2, player: 1, type: 'swap', payload: {} }), code);
  await page.waitForTimeout(3200); // poll interval is 2.5s
  check('opponent move replayed via poll → my turn again',
    await page.evaluate(() => /YOUR TURN/.test(document.getElementById('turn-banner').textContent)));
  // Regression: the swap relief valve must be live again on our new turn. It is
  // disabled during a submit and was previously never re-enabled, which left
  // every bottom button greyed out from your 2nd turn onward.
  check('swap button re-enabled on a later turn',
    await page.evaluate(() => !document.getElementById('btn-swap').disabled));

  check('no console/page errors during play', errs.length === 0, errs.slice(0, 3).join(' | '));

  // ---- Leave-while-waiting flow (fresh room) -------------------------------
  // A guest who opens a room and changes their mind must be able to quit the
  // waiting screen back to the landing page.
  await page.goto(`${base}/lexicorp/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.click('#btn-create');
  await page.waitForTimeout(600);
  await page.click('#btn-prestart-leave'); // real hit-tested click — fails if occluded
  await page.waitForTimeout(300);
  check('prestart LEAVE returns guest to landing',
    await page.evaluate(() => !document.getElementById('screen-landing').classList.contains('hidden')
      && document.getElementById('screen-game').classList.contains('hidden')));

  // ---- Missed-start catch-up ------------------------------------------------
  // If the 'start' broadcast is missed but the room is seen as 'playing', the
  // overlay must still clear (handleRoomUpdate pulls the move log).
  await page.click('#btn-create');
  await page.waitForTimeout(600);
  const code2 = await page.evaluate(() => Array.from(globalThis.__DB.rooms.keys()).pop());
  // Write a start move straight to the DB (simulating the host) WITHOUT going
  // through this client, then mark the room playing — the poll/room-update path
  // should apply it and drop the prestart overlay.
  await page.evaluate((c) => {
    globalThis.__DB.moves.push({ room_code: c, move_index: 0, player: 0, type: 'start', payload: {} });
    globalThis.__DB.rooms.get(c).status = 'playing';
  }, code2);
  await page.waitForTimeout(3200);
  check('missed start is recovered → prestart overlay clears',
    await page.evaluate(() => document.getElementById('prestart-overlay').classList.contains('hidden')));

  await ctx.close();
  await browser.close();
  server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
