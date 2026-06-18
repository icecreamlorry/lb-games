// End-to-end check for the shared "My Games" chrome (shared/lobby-ui.js):
// loads each game signed-in with seeded rooms and asserts the injected lobby
// and account-bar render and respond, plus an anonymous-guest pass. Catches
// regressions in the inject-before-wire ordering and the LB_CONFIG plumbing.
//
// Run (Playwright must be resolvable, e.g. via NODE_PATH):
//   NODE_PATH=/opt/node22/lib/node_modules \
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
//   node test/lobby.e2e.mjs
//
// Serves the repo itself, so no separate web server is needed.

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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

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

const SEED_ROOMS = [
  { code: 'AAA111', status: 'waiting',  invited_user_id: null, players: [{ seat: 0, name: 'Alice', userId: 'u1' }] },
  { code: 'BBB222', status: 'playing',  invited_user_id: null, players: [{ seat: 0, name: 'Alice', userId: 'u1' }, { seat: 1, name: 'Bob', userId: 'u2' }] },
  { code: 'CCC333', status: 'finished', invited_user_id: null, players: [{ seat: 0, name: 'Alice', userId: 'u1' }, { seat: 1, name: 'Bob', userId: 'u2' }] },
];
const USER = { id: 'u1', email: 'alice@example.com', user_metadata: { display_name: 'Alice' } };

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  — ' + detail}`);
}

async function newPage(browser, base, { signedIn }) {
  const ctx = await browser.newContext({ viewport: { width: 411, height: 914 }, ignoreHTTPSErrors: true });
  await ctx.route('**://cdn.jsdelivr.net/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: STUB }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.addInitScript(([user, rooms]) => {
    localStorage.setItem('lbgames.name', 'Alice');
    if (user) { globalThis.__TEST_USER = user; globalThis.__TEST_MYROOMS = rooms; }
  }, [signedIn ? USER : null, SEED_ROOMS]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });
  return { ctx, page, errs };
}

(async () => {
  const server = await serve();
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] });

  for (const game of ['scramblr', 'splitz']) {
    // --- signed-in: the My Games lobby ---
    {
      const { ctx, page, errs } = await newPage(browser, base, { signedIn: true });
      await page.goto(`${base}/${game}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const vis = (id) => { const el = document.getElementById(id); const s = el?.closest('.screen'); return !!el && (!s || !s.classList.contains('hidden')); };
        return {
          lobbyShown: !document.getElementById('screen-lobby').classList.contains('hidden'),
          hasNew: !!document.getElementById('btn-lobby-new'),
          hasJoin: !!document.getElementById('btn-lobby-join'),
          hasDaily: !!document.getElementById('btn-lobby-daily'),
          hasGoLobby: !!document.getElementById('btn-go-lobby'),
          cards: document.querySelectorAll('#lobby-list .lobby-game').length,
          name: document.getElementById('lobby-name')?.textContent || '',
        };
      });
      check(`${game}: lobby screen shown when signed in`, r.lobbyShown);
      check(`${game}: lobby markup injected (NEW GAME button)`, r.hasNew);
      check(`${game}: account-bar injected (MY GAMES button)`, r.hasGoLobby);
      check(`${game}: seeded rooms rendered as cards`, r.cards === 3, `got ${r.cards} cards`);
      check(`${game}: lobby greets the signed-in name`, r.name === 'Alice', `got "${r.name}"`);
      check(`${game}: daily button matches LB_CONFIG.daily`, r.hasDaily === (game === 'scramblr'), `hasDaily=${r.hasDaily}`);

      // JOIN BY CODE toggles the code box
      await page.click('#btn-lobby-join');
      const joinOpen = await page.evaluate(() => !document.getElementById('lobby-join-box').classList.contains('hidden'));
      check(`${game}: JOIN BY CODE reveals the code input`, joinOpen);

      check(`${game}: no page errors (signed in)`, errs.length === 0, errs.slice(0, 3).join(' | '));
      await ctx.close();
    }

    // --- guest: landing + injected account bar ---
    {
      const { ctx, page, errs } = await newPage(browser, base, { signedIn: false });
      await page.goto(`${base}/${game}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => ({
        landingShown: !document.getElementById('screen-landing').classList.contains('hidden'),
        hasLogin: !!document.getElementById('btn-login'),
        hasSetName: !!document.getElementById('btn-set-name'),
      }));
      check(`${game}: landing shown for guest`, r.landingShown);
      check(`${game}: account-bar injected for guest (LOG IN)`, r.hasLogin && r.hasSetName);
      check(`${game}: no page errors (guest)`, errs.length === 0, errs.slice(0, 3).join(' | '));
      await ctx.close();
    }
  }

  await browser.close();
  server.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
