/* ══════════════════════════════════════════════════════════════════════════
   GAME-LEVEL MONTE CARLO SIMULATOR

   Inputs:
     - homeTeam:  { pitcher, lineup: [batter × 9], leagueAvgBatter }
     - awayTeam:  same shape
     - league:    baselines (used by MatchupModel)
     - opts.sims (default 2000), opts.starterPAs (default 24 ≈ ~6 IP)

   For each simulated half-inning, we:
     - Iterate the batting order through PAs
     - Sample event from matchup-model probabilities
     - Update a 24-state base-out chain (1B, 2B, 3B occupied flags × 0/1/2 outs)
     - Score runs as runners cross home
     - End half-inning at 3 outs

   Starter is replaced by a "bullpen" composite (defined per team or via
   league-average) after starterPAs PAs.

   Output:
     {
       sims, runs: { home: [...], away: [...] },
       meanRuns: { home, away },
       winProb: { home, away },
       summary: { homeMedian, awayMedian, ... }
     }
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Event types as a stable array — index used in sampling buckets
  const EVENTS = ['K', 'BB', 'HBP', 'HR', 'triple', 'double', 'single', 'out_in_play'];

  // ─── Base-out state machine ───
  // bases: [b1, b2, b3] booleans. Returns { newBases, newOuts, runsScored }.
  function applyEvent(event, bases, outs) {
    let [b1, b2, b3] = bases;
    let r = 0;
    switch (event) {
      case 'K':
      case 'out_in_play':
        return { bases: [b1, b2, b3], outs: outs + 1, r: 0 };

      case 'BB':
      case 'HBP':
        if (b1 && b2 && b3) { r = 1; }
        else if (b1 && b2)  { b3 = true; }
        else if (b1)        { b2 = true; b1 = true; }
        else                { b1 = true; }
        // Re-fill from forced positions
        if (event === 'BB' || event === 'HBP') {
          // Already handled above (force-only advance)
        }
        return { bases: [b1, b2, b3], outs, r };

      case 'single': {
        // R3 always scores. R2 scores ~70% of the time (we treat 100% in v1).
        // R1 to 2B (sometimes to 3B; v1 = always 2B).
        if (b3) r++;
        if (b2) r++;
        b3 = b1; // R1 → 3B (a touch aggressive but tunable)
        b2 = false;
        b1 = true;
        return { bases: [b1, b2, b3], outs, r };
      }
      case 'double': {
        if (b3) r++;
        if (b2) r++;
        if (b1) r++;        // R1 scores on most doubles
        b3 = false;
        b2 = true;
        b1 = false;
        return { bases: [b1, b2, b3], outs, r };
      }
      case 'triple': {
        if (b3) r++;
        if (b2) r++;
        if (b1) r++;
        b1 = false; b2 = false; b3 = true;
        return { bases: [b1, b2, b3], outs, r };
      }
      case 'HR': {
        r = 1 + (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0);
        return { bases: [false, false, false], outs, r };
      }
    }
    return { bases: [b1, b2, b3], outs, r: 0 };
  }

  // ─── Per-PA outcome sampling ───
  // Build a cumulative distribution from the matchup-model probability vector.
  function buildCDF(p) {
    const order = EVENTS;
    const cdf = new Array(order.length);
    let cum = 0;
    for (let i = 0; i < order.length; i++) {
      const k = order[i];
      const v = (p[k] != null && p[k] >= 0) ? p[k] : 0;
      cum += v;
      cdf[i] = cum;
    }
    // Normalize defensively (tiny rounding error possible)
    const total = cum;
    if (total > 0 && Math.abs(total - 1) > 1e-6) {
      for (let i = 0; i < cdf.length; i++) cdf[i] /= total;
    }
    return cdf;
  }
  function sampleEvent(cdf, rng) {
    const r = rng();
    for (let i = 0; i < cdf.length; i++) {
      if (r <= cdf[i]) return EVENTS[i];
    }
    return EVENTS[EVENTS.length - 1];
  }

  // ─── Simulate a single half-inning ───
  function simHalfInning(batterOrderState, lineupCDFs, rng) {
    let bases = [false, false, false], outs = 0, runs = 0;
    let i = batterOrderState.idx;
    while (outs < 3) {
      const cdf = lineupCDFs[i];
      const ev = sampleEvent(cdf, rng);
      const r = applyEvent(ev, bases, outs);
      bases = r.bases; outs = r.outs; runs += r.r;
      i = (i + 1) % lineupCDFs.length;
      // Safety stop in case of model degeneration
      if (runs > 25) break;
    }
    batterOrderState.idx = i;
    return runs;
  }

  // ─── Simulate a full game ───
  function simGame(homeCDFs, awayCDFs, rng) {
    let homeRuns = 0, awayRuns = 0;
    const homeState = { idx: 0 };
    const awayState = { idx: 0 };
    for (let inn = 0; inn < 9; inn++) {
      awayRuns += simHalfInning(awayState, awayCDFs, rng);
      // Walk-off optimization: home need not bat in 9th if leading
      if (inn === 8 && homeRuns > awayRuns) break;
      homeRuns += simHalfInning(homeState, homeCDFs, rng);
    }
    // Extras — simple "ghost runner" 10th if tied (one extra inning, no Manfred for v1)
    if (homeRuns === awayRuns) {
      const extra = simHalfInning(awayState, awayCDFs, rng);
      awayRuns += extra;
      if (homeRuns < awayRuns) homeRuns += simHalfInning(homeState, homeCDFs, rng);
      else                     homeRuns += simHalfInning(homeState, homeCDFs, rng);
    }
    return { home: homeRuns, away: awayRuns };
  }

  // ─── Build CDFs for one side ───
  // Each batter gets a per-PA outcome CDF vs the opposing pitcher.
  // ctxFn(batter, pitcher) → ctx with splits / arsenal / whiff / park.
  function buildLineupCDFs(lineup, pitcher, league, ctxFn) {
    return lineup.map(b => {
      const ctx = ctxFn ? ctxFn(b, pitcher) : null;
      const m = window.MatchupModel.matchup(pitcher, b, league, ctx);
      if (!m) return null;
      return buildCDF(m.p);
    });
  }

  // ─── Main entry point ───
  // home / away each: { pitcher, lineup, bullpen?: pitcher-row shape }.
  // bullpen is the team's weighted reliever composite; falls back to
  // league-average proxy when absent.
  //
  // HFA: the model itself doesn't capture umpire bias, batter's-eye, travel
  // fatigue, etc. — collectively ~3-4 percentage points of home-team edge.
  // We post-hoc blend the raw simulator output with the historical HFA prior.
  // hfaBlend=0.20 + hfaPrior=0.540 reproduces the league baseline when the
  // matchup is otherwise neutral (validated against 2025 game outcomes).
  function simulateGame(home, away, league, opts = {}) {
    const sims = opts.sims || 2000;
    const starterInnings = opts.starterInnings || 6;
    const rng = opts.rng || Math.random;
    const ctxFn = opts.ctxFn || null;
    const hfaBlend = opts.hfaBlend != null ? opts.hfaBlend : 0.20;
    const hfaPrior = opts.hfaPrior != null ? opts.hfaPrior : 0.540;

    const leagueAvgPit = {
      throws: null,
      k_pct: league.pit.k_pct,
      bb_pct: league.pit.bb_pct,
      babip: league.pit.babip,
      hr_per_pa: league.pit.hr_per_pa,
      stuff_plus: 100, location_plus: 100,
    };
    const homeBullpen = home.bullpen || leagueAvgPit;
    const awayBullpen = away.bullpen || leagueAvgPit;

    const hStarterCDFs = buildLineupCDFs(home.lineup, away.pitcher, league, ctxFn);
    const aStarterCDFs = buildLineupCDFs(away.lineup, home.pitcher, league, ctxFn);
    const hBullpenCDFs = buildLineupCDFs(home.lineup, awayBullpen, league, ctxFn);
    const aBullpenCDFs = buildLineupCDFs(away.lineup, homeBullpen, league, ctxFn);

    // For a v1 simple model we apply starter-vs-bullpen via per-inning blend:
    // innings 1..starterInnings use starter CDFs, innings starterInnings+1..
    // use bullpen CDFs. We implement this by running sims with two phases.
    // To keep simHalfInning fast & simple, we pass a selector by inning.
    const homeRuns = new Array(sims);
    const awayRuns = new Array(sims);
    let hWins = 0;

    for (let s = 0; s < sims; s++) {
      let hR = 0, aR = 0;
      const homeState = { idx: 0 };
      const awayState = { idx: 0 };
      for (let inn = 0; inn < 9; inn++) {
        const aCDFs = inn < starterInnings ? aStarterCDFs : aBullpenCDFs;
        const hCDFs = inn < starterInnings ? hStarterCDFs : hBullpenCDFs;
        aR += simHalfInning(awayState, aCDFs, rng);
        if (inn === 8 && hR > aR) break;
        hR += simHalfInning(homeState, hCDFs, rng);
      }
      // Extras: one extra inning rolling tiebreaker (max 5 extras to bound runtime)
      let extras = 0;
      while (hR === aR && extras < 5) {
        aR += simHalfInning(awayState, aBullpenCDFs, rng);
        hR += simHalfInning(homeState, hBullpenCDFs, rng);
        extras++;
      }
      // If still tied after 5 extras, flip a coin (rare)
      if (hR === aR) { if (rng() < 0.5) hR++; else aR++; }
      homeRuns[s] = hR; awayRuns[s] = aR;
      if (hR > aR) hWins++;
    }

    return {
      sims,
      meanRuns: {
        home: avg(homeRuns),
        away: avg(awayRuns),
      },
      medianRuns: {
        home: median(homeRuns),
        away: median(awayRuns),
      },
      winProb: {
        home: (1 - hfaBlend) * (hWins / sims) + hfaBlend * hfaPrior,
        away: 1 - ((1 - hfaBlend) * (hWins / sims) + hfaBlend * hfaPrior),
      },
      // Raw (un-HFA-blended) for transparency
      winProbRaw: {
        home: hWins / sims,
        away: 1 - hWins / sims,
      },
      runs: { home: homeRuns, away: awayRuns },
    };
  }

  function avg(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function median(a) {
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  window.WinProbSimulator = { simulateGame, EVENTS };
})();
