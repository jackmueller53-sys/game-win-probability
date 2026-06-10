/* Unified data loader for the WP site.
   Loads schedule (today.json) + matchup-model features in parallel. */
(function () {
  'use strict';

  const out = {
    pitchers: [], batters: [], league: null, meta: null, today: null,
    bat_splits: {}, pit_splits: {}, bat_whiff: {},
    pit_arsenal: {}, park_factors: {},
    bat_recent: {}, pit_recent: {}, h2h: {},
    ready: null,
  };

  function load(url, fallback) {
    return fetch(url, { cache: 'default' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { console.warn('[data] miss', url, e.message); return fallback; });
  }

  out.ready = Promise.all([
    load('data/pitchers.json',      []),
    load('data/batters.json',       []),
    load('data/league.json',        null),
    load('data/meta.json',          null),
    load('data/today.json',         null),
    load('data/bat_splits.json',    {}),
    load('data/pit_splits.json',    {}),
    load('data/bat_whiff.json',     {}),
    load('data/pit_arsenal.json',   {}),
    load('data/park_factors.json',  {}),
    load('data/bat_recent.json',    {}),
    load('data/pit_recent.json',    {}),
    load('data/h2h.json',           {}),
  ]).then(([p, b, l, m, t, bs, ps, bw, pa, pf, br, pr, h2h]) => {
    out.pitchers = Array.isArray(p) ? p : [];
    out.batters  = Array.isArray(b) ? b : [];
    out.league   = l;
    out.meta     = m;
    out.today    = t;
    out.bat_splits   = bs || {};
    out.pit_splits   = ps || {};
    out.bat_whiff    = bw || {};
    out.pit_arsenal  = pa || {};
    out.park_factors = pf || {};
    out.bat_recent   = br || {};
    out.pit_recent   = pr || {};
    out.h2h          = h2h || {};
    return out;
  });

  window.MatchupData = out;
})();
