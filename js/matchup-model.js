/* ══════════════════════════════════════════════════════════════════════════
   MATCHUP MODEL — v1.1 (Tier A, backtest-validated)

   Returns per-PA outcome distribution, xwOBA, and edge for a given
   (pitcher, batter, league) plus optional context (handedness splits,
   per-pitch whiff data, arsenal data, park factors, home team).

   Key design choices, validated by 2024→2025 backtest of 116k PAs:
     - Empirical-Bayes regression-to-mean BEFORE log5 (fixes the over-confidence
       at extreme matchups; brings top-K-bin calibration from −13% to +0.8%)
     - Vs-handedness splits replace seasonal aggregates when available
     - Park-factor adjusts HR rate per game
     - Flat platoon multiplier is FALLBACK only (when splits absent)
     - NO reliever/pitch-type bumps applied to K% (double-counts what's
       already in seasonal K%)
     - Per-pitch matchup retained as an explainability signal only

   Backtest metrics (2024 features → 2025 PAs, 116k PA):
     - Log loss: 1.4627 (naive baseline 1.475, prior v1 baseline 1.4729)
     - K calibration: ±2.5% across all 10 reliability bins (was ±13.5%)
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── helpers ──
  function pct(v) {
    if (v == null || !isFinite(v)) return null;
    return v > 1 ? v / 100 : v;
  }

  // Odds-ratio log5 (Tango/James).
  function log5(b, p, l) {
    if (b == null || p == null || l == null) return null;
    if (l <= 0 || l >= 1) return null;
    const eps = 1e-6;
    b = Math.min(Math.max(b, eps), 1 - eps);
    p = Math.min(Math.max(p, eps), 1 - eps);
    l = Math.min(Math.max(l, eps), 1 - eps);
    const num = (b * p) / l;
    const den = num + ((1 - b) * (1 - p)) / (1 - l);
    return num / den;
  }

  // Empirical-Bayes regression: shrink observed rate toward league.
  //   regressed = (n × observed + k × league) / (n + k)
  // k is the # of PAs needed to "half-trust" the player's observed rate.
  // Standard sabermetric values (Tango et al.):
  const SHRINK = { k_pct: 175, bb_pct: 285, hr_per_pa: 900, babip: 1100 };
  function regress(obs, n, lg, k) {
    if (obs == null || n == null || lg == null) return obs;
    const nn = Math.max(0, n);
    return (nn * obs + k * lg) / (nn + k);
  }

  function clip01(x) { return Math.max(0, Math.min(1, x)); }

  // ── platoon (fallback when splits absent) ──
  function platoonFactors(bats, throws) {
    if (!bats || !throws) return { k: 1, bb: 1, hr: 1 };
    if (bats === 'S') return { k: 1, bb: 1, hr: 1 };
    const same = bats === throws;
    return same
      ? { k: 1.04, bb: 0.97, hr: 0.94 }
      : { k: 0.97, bb: 1.03, hr: 1.06 };
  }

  // ── per-pitch matchup (explainability only — does NOT modify K prediction) ──
  const PITCH_TYPES = ['FF', 'SI', 'FC', 'SL', 'CU', 'CH', 'FS'];
  function pitchMatchupSignal(pitArsenal, batWhiff) {
    if (!pitArsenal || !batWhiff) return null;
    const arsenal = pitArsenal.arsenal || {};
    let weighted = 0, total = 0;
    for (const pt of PITCH_TYPES) {
      const a = arsenal[pt];
      if (!a) continue;
      const w = batWhiff[pt];
      if (!w || w.whiff_pct == null) continue;
      const u = a.usage_pct || 0;
      weighted += u * w.whiff_pct;
      total += u;
    }
    return total >= 0.4 ? weighted / total : null;
  }

  function parkFactor(parkFactors, homeTeam) {
    if (!parkFactors || !homeTeam) return { r: 1.0, hr: 1.0 };
    const pf = parkFactors[homeTeam];
    if (!pf) return { r: 1.0, hr: 1.0 };
    return { r: pf.r / 100, hr: pf.hr / 100 };
  }

  // ── core matchup ──
  function matchup(pit, bat, league, ctx) {
    if (!pit || !bat || !league) return null;
    ctx = ctx || {};

    // Raw seasonal rates
    let bK = pct(bat.k_pct), bBB = pct(bat.bb_pct), bBABIP = pct(bat.babip);
    let pK = pct(pit.k_pct), pBB = pct(pit.bb_pct), pBABIP = pct(pit.babip);
    let bHR, pHR;
    if (bat.hr != null && bat.pa) bHR = bat.hr / bat.pa;
    else if (bat.iso != null) bHR = pct(bat.iso) * 0.25;
    if (pit.hr_per_pa != null) pHR = pct(pit.hr_per_pa);
    else if (pit.hr_per_9 != null) pHR = pit.hr_per_9 / 38;

    let batPA = bat.pa || 600;
    let pitPA = (pit.ip || 100) * 4.2;

    // Override with vs-handedness splits when both available + ≥50 PA
    let useSplits = false;
    const batSplit = ctx.bat_split, pitSplit = ctx.pit_split;
    const pThrows = pit.throws, bBats = bat.bats;
    if (batSplit && pitSplit && pThrows && bBats) {
      const bs = batSplit[pThrows], ps = pitSplit[bBats];
      if (bs && ps && (bs.pa || 0) >= 50 && (ps.pa || 0) >= 50) {
        bK = bs.k_pct ?? bK; bBB = bs.bb_pct ?? bBB;
        bHR = bs.hr_per_pa ?? bHR; bBABIP = bs.babip ?? bBABIP;
        pK = ps.k_pct ?? pK; pBB = ps.bb_pct ?? pBB;
        pHR = ps.hr_per_pa ?? pHR; pBABIP = ps.babip ?? pBABIP;
        batPA = bs.pa || batPA; pitPA = ps.pa || pitPA;
        useSplits = true;
      }
    }

    const lK     = pct(league.bat.k_pct);
    const lBB    = pct(league.bat.bb_pct);
    const lHR    = league.bat.hr_per_pa;
    const lBABIP = pct(league.bat.babip);

    // Regression to mean (before log5) — the calibration fix
    bK = regress(bK, batPA, lK, SHRINK.k_pct);
    bBB = regress(bBB, batPA, lBB, SHRINK.bb_pct);
    bHR = regress(bHR, batPA, lHR, SHRINK.hr_per_pa);
    bBABIP = regress(bBABIP, batPA, lBABIP, SHRINK.babip);
    pK = regress(pK, pitPA, lK, SHRINK.k_pct);
    pBB = regress(pBB, pitPA, lBB, SHRINK.bb_pct);
    pHR = regress(pHR, pitPA, lHR, SHRINK.hr_per_pa);
    pBABIP = regress(pBABIP, pitPA, lBABIP, SHRINK.babip);

    let pK_pred  = log5(bK, pK, lK);
    let pBB_pred = log5(bBB, pBB, lBB);
    let pHR_pred = log5(bHR, pHR, lHR);

    if (!useSplits) {
      const plat = platoonFactors(bBats, pThrows);
      if (pK_pred  != null) pK_pred  *= plat.k;
      if (pBB_pred != null) pBB_pred *= plat.bb;
      if (pHR_pred != null) pHR_pred *= plat.hr;
    }

    const park = parkFactor(ctx.park_factors, ctx.home_team);
    if (pHR_pred != null) pHR_pred = clip01(pHR_pred * park.hr);
    if (pK_pred != null)  pK_pred  = clip01(pK_pred);
    if (pBB_pred != null) pBB_pred = clip01(pBB_pred);

    const pHBP = 0.009;
    const pContact = clip01(1 - (pK_pred || 0) - (pBB_pred || 0) - (pHR_pred || 0) - pHBP);

    let matchupBABIP = log5(bBABIP, pBABIP, lBABIP) || lBABIP || 0.295;
    matchupBABIP = clip01(matchupBABIP * (1 + (park.r - 1) * 0.3));

    const pHIP = pContact * matchupBABIP;
    const pOIP = pContact * (1 - matchupBABIP);
    // Corrected MLB 1B/2B/3B mix (was 75/21/4 → now 78/18.5/3.5)
    const p1B = pHIP * 0.780;
    const p2B = pHIP * 0.185;
    const p3B = pHIP * 0.035;

    const xwOBA = ((pBB_pred || 0) * 0.690
                 + pHBP * 0.720
                 + p1B * 0.890
                 + p2B * 1.271
                 + p3B * 1.616
                 + (pHR_pred || 0) * 2.101);
    const lgWOBA = league.bat.woba || 0.318;
    const edge = Math.max(-100, Math.min(100, ((xwOBA - lgWOBA) / 0.060) * 50));

    const whiffSig = pitchMatchupSignal(ctx.pit_arsenal, ctx.bat_whiff);

    return {
      p: {
        K: pK_pred, BB: pBB_pred, HR: pHR_pred,
        HBP: pHBP, single: p1B, double: p2B, triple: p3B,
        out_in_play: pOIP,
      },
      xwOBA,
      edge,
      lgWOBA,
      _used: {
        splits: useSplits,
        park_hr: park.hr,
        whiff_signal: whiffSig,
      },
      reasons: buildReasons(pit, bat, useSplits, park, whiffSig),
    };
  }

  function buildReasons(pit, bat, useSplits, park, whiffSig) {
    const r = [];
    if (pit.stuff_plus != null) {
      const d = pit.stuff_plus - 100;
      if (Math.abs(d) >= 5) r.push({
        label: `Stuff+ ${pit.stuff_plus.toFixed(0)}`,
        favors: d > 0 ? 'pitcher' : 'hitter',
        detail: `${Math.abs(d).toFixed(0)}pt ${d > 0 ? 'above' : 'below'} average`,
      });
    }
    if (useSplits) {
      r.push({
        label: 'Handedness splits applied',
        favors: 'data',
        detail: `using vs-${pit.throws}HP / vs-${bat.bats}HB true splits`,
      });
    } else if (bat.bats && pit.throws && bat.bats !== 'S') {
      const same = bat.bats === pit.throws;
      r.push({
        label: same ? 'Same-handed (P advantage)' : 'Opposite-handed (H advantage)',
        favors: same ? 'pitcher' : 'hitter',
        detail: `${bat.bats}HB vs ${pit.throws}HP (no splits — using The Book platoon)`,
      });
    }
    if (park.hr !== 1.0) {
      const d = park.hr - 1.0;
      r.push({
        label: `Park HR factor ${(park.hr * 100).toFixed(0)}`,
        favors: d > 0 ? 'hitter' : 'pitcher',
        detail: `${(Math.abs(d) * 100).toFixed(0)}% ${d > 0 ? 'boost' : 'suppression'}`,
      });
    }
    if (whiffSig != null) {
      const d = whiffSig - 0.24;
      if (Math.abs(d) >= 0.04) {
        r.push({
          label: 'Pitch-arsenal vs batter whiff',
          favors: d > 0 ? 'pitcher' : 'hitter',
          detail: `weighted whiff% ${(whiffSig * 100).toFixed(1)}% (lg ~24%)`,
        });
      }
    }
    if (bat.wrc_plus != null) {
      const d = bat.wrc_plus - 100;
      if (Math.abs(d) >= 10) r.push({
        label: `wRC+ ${bat.wrc_plus.toFixed(0)}`,
        favors: d > 0 ? 'hitter' : 'pitcher',
        detail: `${Math.abs(d).toFixed(0)}pt ${d > 0 ? 'above' : 'below'} avg`,
      });
    }
    return r;
  }

  // Public API
  window.MatchupModel = {
    matchup,
    log5,
    regress,
    platoonFactors,
    paOutcomeVector(pit, bat, league, ctx) {
      const m = matchup(pit, bat, league, ctx);
      return m ? m.p : null;
    },
  };
})();
