// Boot veil + pre-paint auth hint — theme-boot.js's sibling for layout.
//
// Problem: every page's static HTML is the signed-OUT layout, and the account
// layer only learns "actually, you're logged in" after Supabase resolves. So a
// signed-in visitor always saw the guest screen flash in and then reconfigure
// (account bar flips, screen swaps to the lobby, maybe again into a resumed
// game). Supabase caches the whole session in localStorage though, so
// signed-in-ness is knowable synchronously, before first paint.
//
// This runs as a classic (blocking) script at the TOP OF <body>, after
// window.LB_CONFIG and theme-boot.js:
//
//   1. Reads the cached Supabase session and stamps <html data-auth="in|out">
//      so CSS/inline scripts can paint the right variant immediately. The
//      cached user (if any) is exposed as LBBoot.user.
//   2. On game pages (LB_CONFIG.gameSlug set) it injects a full-screen boot
//      veil — the game's logo plus pulsing dots — that covers the app until
//      main.js has decided which screen to show and calls LBBoot.done().
//      The veil fades in only after a beat (see shared.css), so fast boots
//      show a clean themed background rather than a flickering spinner.
//
// LBBoot.done() is safe to call multiple times, and a failsafe timer lifts
// the veil regardless, so a missed error path can never brick the page.

(function () {
  var user = null;
  try {
    // supabase-js v2 persists the session at sb-<project-ref>-auth-token.
    // Scan rather than hardcode the ref (it lives in an ES module we can't
    // import from a classic script). Presence of a session = optimistically
    // signed in; if the refresh later fails, onAuthChange corrects the UI.
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (/^sb-.+-auth-token$/.test(k)) {
        var s = JSON.parse(localStorage.getItem(k));
        user = (s && (s.user || (s.currentSession && s.currentSession.user))) || null;
        break;
      }
    }
  } catch (e) {}
  document.documentElement.dataset.auth = user ? 'in' : 'out';

  var veil = null;
  var cfg = window.LB_CONFIG || {};
  if (cfg.gameSlug && document.currentScript) {
    var name = String(cfg.gameName || 'LB GAMES').toUpperCase()
      .replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    document.currentScript.insertAdjacentHTML('afterend',
      '<div id="lb-boot-veil" aria-hidden="true"><div class="lb-boot-inner">' +
      '<div class="lb-boot-logo">' + name + '</div>' +
      '<div class="lb-boot-dots"><i></i><i></i><i></i></div>' +
      '</div></div>');
    veil = document.getElementById('lb-boot-veil');
  }

  function done() {
    if (!veil) return;
    var v = veil;
    veil = null;
    v.classList.add('lifting');
    setTimeout(function () { v.remove(); }, 400);
  }

  window.LBBoot = { user: user, done: done };
  // Failsafe: never leave the page stuck behind the veil.
  setTimeout(done, 8000);
})();
