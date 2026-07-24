# LB Games — working notes for Claude

A family of vanilla-JS web games (Chromagrid, Wurdz, Scramblr, Splitz, Lexicorp,
Atlaz, Flagz, Atomyx, Buffz, Weiqi) sharing one Supabase rooms/accounts/push
layer under `shared/`. No build step — static HTML + ES modules, served straight
from GitHub Pages (`icecreamlorry.github.io/lb-games`). Each game lives in its
own folder with `index.html`, `js/`, `css/style.css`, `sw.js`, `manifest`.

## ⚠️ New-game UI checklist — the bugs that keep coming back

These two layout bugs have been fixed in every game one at a time. **When you
add or restyle a game, do these up front and verify them, so we stop re-fixing
the same things.**

### 1. The floating hamburger menu (`#btn-menu`) must not overlap anything

`shared/account-ui.js` injects a **`position: fixed` hamburger button at the
top-right corner** (`#btn-menu`, z-index 970), on *every* screen. Any content a
screen puts in that corner will collide with it unless the screen reserves the
space. Required per game:

- **Game screen header** (and any other custom header, e.g. a tutorial header) —
  the header's own CSS must clear the corner:
  ```css
  .game-header {
    padding-right: 58px;                                   /* clear the 36px button */
    padding-top: calc(env(safe-area-inset-top, 0px) + 10px);
  }
  ```
- **Wide screens** — pull the button in beside the centred column instead of the
  far window corner (cosmetic, but every game does it). `N` = half the game
  column's max-width:
  ```css
  @media (min-width: 561px) {
    #screen-game:not(.hidden) ~ #btn-menu,
    #screen-game:not(.hidden) ~ #app-menu {
      right: max(calc(env(safe-area-inset-right, 0px) + 10px), calc(50% - N + 6px));
    }
  }
  ```
- **Lobby ("My Games")** — the shared card header clears the button via
  `shared/shared.css` (`#screen-lobby .bar { padding-right: 52px }`), so you get
  this for free **as long as** you don't override `.bar`.

Verify at ~412px wide that the button doesn't sit on the Leave/Resign/LOG OUT
buttons.

### 2. No horizontal scroll; screens are centred

Screens must not scroll sideways, and card-style screens (landing, lobby) must
be centred both ways. Required per game:

```css
html, body { height: 100%; overflow: hidden; }

/* Every card screen: FLEX-CENTRE it (all three properties) + clip overflow-x. */
#screen-landing, #screen-lobby {
  display: flex; align-items: center; justify-content: center;
  overflow-y: auto; overflow-x: hidden; padding: 20px;
}
```

- Cards use `width: min(420px, 92vw); max-width: 100%;` so they never exceed the
  viewport.
- Wide content (boards, tables, code) scrolls inside its own
  `overflow-x: auto` container — the page body never scrolls sideways.
- **Fixed-size boards/canvases in an `align-items: stretch` flex column** hug the
  left with a gap on the right: the panel stretches to the widest sibling (title,
  score bar) while the fixed-size board stays left-aligned inside it. Worst on a
  short viewport (iPhone Safari with toolbars) where the board shrinks to fit the
  height. Give the board's wrapper `align-self: center` so the panel hugs the
  board and centres (Chromagrid's `#grid-wrap`). Relatedly, an SVG/`<canvas>`
  with `width:100%` needs an ancestor with a *definite* width or it collapses to
  its 300px intrinsic size — don't leave the flex column on `margin:0 auto` alone
  (Weiqi's `.table` needs `width:100%`).

The classic mistake: setting only `justify-content: center` without
`display: flex` + `align-items: center`. That leaves the card top-left **and**
lets its fixed width push past the edge → both bugs at once.

## Shared layer (don't re-implement per game)

- `shared/rooms.js` + `shared/net.js` — rooms, moves, realtime, push. Each game's
  `js/net.js` calls `createNet(GAME_SLUG)`.
- `shared/account-ui.js` / `shared/lobby-ui.js` — auth modals, hamburger menu,
  the injected lobby card + account bar.
- `shared/boot.js` — the boot veil (lifts on `LBBoot.done()`, 8s failsafe).
- `shared/supabaseClient.js` imports supabase-js from a **CDN**, so the whole app
  graph only evaluates when that CDN is reachable. In a network-blocked sandbox
  the game screens won't boot; test game-independent pieces (engines, tutorials)
  in isolation instead.

## Per-game conventions

- Move log is the source of truth; engines are pure and deterministic and fold
  an ordered move log into state (`replayMoves`). Colours/first-player derive
  from the room `seed`.
- Per-game options (mode, board size, …) ride the `start` move payload — no new
  DB columns.
- Turn notifications, offline/online presence, and resignation come from the
  shared layer; Wurdz/Weiqi are the reference implementations.
- **Guests get a persistent per-device identity** (`shared/guest-id.js`,
  localStorage) so they can rejoin their seat with the room code after a browser
  close — never store the guest id in sessionStorage. For true auto-resume, keep
  the game's "resume this room" pointer in **localStorage for guests** (they have
  no server-side games list) and sessionStorage for signed-in players (they have
  the lobby). See Weiqi's `saveSession`/`readSession`/`clearSession`.
- Add each new game as a card in the root `index.html`, and give it engine tests
  under `<game>/test/*.mjs` (run with `node`).

## Git

Work on the designated feature branch, then fast-forward `main`
(`git fetch origin main && git checkout main && git merge --ff-only <branch> &&
git push origin main`). GitHub Pages serves `main`, so a push deploys it.
