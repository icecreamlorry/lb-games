// Apply the user's cached theme synchronously, before the page paints, so it
// doesn't briefly flash the default theme before the deferred account-ui module
// gets a chance to run loadTheme(). The theme is already persisted in
// localStorage ('lb.theme') by applyTheme(); this just reads it early.
//
// Loaded as a classic (blocking) <head> script, placed right after the inline
// window.LB_CONFIG script so the per-game default is available as a fallback.
(function () {
  try {
    var cfg = window.LB_CONFIG || {};
    var theme = localStorage.getItem('lb.theme') || cfg.defaultTheme || 'synth';
    document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
