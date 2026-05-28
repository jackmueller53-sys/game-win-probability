/* ══════════════════════════════════════════════════════════════════════════
   MATCHUP MODEL
   Given a pitcher row, a batter row, and league baselines, return the
   probability distribution over per-PA event outcomes plus an "edge" score.

   Math: odds-ratio log5 for each independent event type (K, BB, HR), with
   a Stuff+ adjustment, a handedness platoon adjustment, and remaining
   contact-no-HR probability distributed to BABIP-driven 1B/2B/3B/Out.

   Every number is derived from inputs we can show the user. No training.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ───── Log5 (odds-ratio form, Tom Tango / The Book) ─────
  // Returns the probability that a given event occurs in a matchup, given the
  // batter's rate, the pitcher's allowed rate, and the league baseline rate.
  function log5(pBat, pPit, pLg) {
    if (pBat == null || pPit == null || pLg == null) return null;
    if (pLg <= 0 || pLg >= 1) return null;
    // Guard against degenerate inputs.
    const eps = 1e-6;
    const b = Math.min(Math.max(pBat, eps), 1 - eps);
    const p = Math.min(Math.max(pPit, eps), 1 - eps);
    const l = Math.min(Math.max(pLg,  eps), 1 - eps);
    const num = (b * p) / l;
    const den = num + ((1 - b) * (1 - p)) / (1 - l);
    return num / den;
  }

  // Convert a percentage (0-100) to a rate (0-1). FG sometimes hands us 19.8,
  // sometimes 0.198 — sniff and normalize.
  function pct(v) {
    if (v == null || !isFinite(v)) return null;
    return v > 1 ? v / 100 : v;
  }

  // ───── Platoon adjustment ─────
  // The Book (Tango/Lichtman/Dolphin) quantifies platoon splits as:
  //   vs same-handed pitcher: K% up ~2-3%, BB% down ~1%, wOBA down ~10-15 pts.
  // We translate to a multiplicative bump for K, BB, HR. Switch hitters get
  // no penalty.
  function platoonFactors(bats, throws) {
    if (!bats || !throws) return { k: 1, bb: 1, hr: 1 };
    if (bats === 'S') return { k: 1, bb: 1, hr: 1 };
    const sameHanded = bats === throws;
    // The Book quantifies the same-handed advantage at ~2.5% absolute K,
    // ~1% absolute BB, ~3% absolute HR. Since the batter's overall rate is
    // already a vs-LHP/vs-RHP mix, we apply roughly half that as the
    // matchup-specific tilt (the other half is already baked into the
    // observed rate via the player's natural lineup of opponents).
    return sameHanded
      ? { k: 1.04, bb: 0.97, hr: 0.94 }   // pitcher's advantage
      : { k: 0.97, bb: 1.03, hr: 1.06 };  // batter's advantage
  }

  // ───── Stuff+ tilt ─────
  // Pitcher's K% already encodes Stuff+ implicitly, so we do NOT bump K%
  // here (avoids double-counting). We only apply a small Location+ tilt on
  // BB% (location is less perfectly correlated with BB%) and a Stuff+ tilt
  // on HR (HR/9 alone is noisy at low IP — Stuff+ stabilizes it).
  function stuffPlusFactors(stuffPlus, locationPlus) {
    const stf = stuffPlus != null ? stuffPlus : 100;
    const loc = locationPlus != null ? locationPlus : 100;
    return {
      k: 1.0,
      bb: 1 - 0.02 * ((loc - 100) / 10),
      hr: 1 - 0.015 * ((stf - 100) / 10),
    };
  }

  // ───── Core matchup function ─────
  function matchup(pitcher, batter, league) {
    if (!pitcher || !batter || !league) return null;

    // 1. Pull rates (normalize to 0-1 fractions)
    const bK  = pct(batter.k_pct),  pK  = pct(pitcher.k_pct),  lK  = pct(league.bat.k_pct);
    const bBB = pct(batter.bb_pct), pBB = pct(pitcher.bb_pct), lBB = pct(league.bat.bb_pct);

    // HR/PA — derive from HR/AB and AB/PA proxy if we don't have direct.
    const bHRpa = batter.hr != null && batter.pa
      ? batter.hr / batter.pa
      : pct(batter.iso || 0) * 0.25; // rough fallback
    const pHRpa = pitcher.hr_per_pa != null
      ? pct(pitcher.hr_per_pa)
      : (pitcher.hr_per_9 != null ? pitcher.hr_per_9 / 38 : null);
    const lHRpa = league.bat.hr_per_pa;

    // 2. Adjustments
    const platoon = platoonFactors(batter.bats, pitcher.throws);
    const stuff = stuffPlusFactors(pitcher.stuff_plus, pitcher.location_plus);

    // 3. Per-event probabilities (log5 then adjusted)
    let pK_pred  = log5(bK, pK, lK);
    let pBB_pred = log5(bBB, pBB, lBB);
    let pHR_pred = log5(bHRpa, pHRpa, lHRpa);

    pK_pred  = pK_pred  != null ? clip01(pK_pred  * platoon.k  * stuff.k)  : null;
    pBB_pred = pBB_pred != null ? clip01(pBB_pred * platoon.bb * stuff.bb) : null;
    pHR_pred = pHR_pred != null ? clip01(pHR_pred * platoon.hr * stuff.hr) : null;

    // 4. Hit-by-pitch — flat league rate (~0.9%); we don't model individuals.
    const pHBP = 0.009;

    // 5. Contact-non-HR probability = 1 - K - BB - HR - HBP
    const pContact = clip01(1 - (pK_pred || 0) - (pBB_pred || 0) - (pHR_pred || 0) - pHBP);

    // 6. Split contact into 1B/2B/3B/out via blended BABIP.
    // BABIP = (H - HR) / (AB - K - HR + SF). Treat batter BABIP & pitcher
    // BABIP-allowed via log5 against league BABIP.
    const bBABIP = pct(batter.babip);
    const pBABIP = pct(pitcher.babip);
    const lBABIP = pct(league.bat.babip);
    const matchupBABIP = log5(bBABIP, pBABIP, lBABIP) || lBABIP || 0.295;

    const pHitInPlay = pContact * matchupBABIP;
    const pOutInPlay = pContact * (1 - matchupBABIP);

    // Hit-type split: league averages are roughly 1B:2B:3B = 75:21:4
    const p1B = pHitInPlay * 0.75;
    const p2B = pHitInPlay * 0.21;
    const p3B = pHitInPlay * 0.04;

    // 7. Expected wOBA — FG weights (2024 lin weights, approximate):
    //   BB=0.69, HBP=0.72, 1B=0.89, 2B=1.27, 3B=1.62, HR=2.10
    // wOBA denominator is AB + BB - IBB + SF + HBP ≈ PA - IBB
    const wOBA_num = (pBB_pred || 0) * 0.690
                   + pHBP * 0.720
                   + p1B * 0.890
                   + p2B * 1.271
                   + p3B * 1.616
                   + (pHR_pred || 0) * 2.101;
    const wOBA_den = 1.0; // per-PA basis
    const xwOBA_pred = wOBA_num / wOBA_den;

    // 8. Edge score (-100 pitcher-dominant ... +100 hitter-dominant)
    // Center on league wOBA; spread chosen so a typical "good matchup" lands
    // around ±30 (matches eye test on aces vs. average hitters).
    const lgWOBA = league.bat.woba || 0.318;
    const edge = clipN(((xwOBA_pred - lgWOBA) / 0.060) * 50, -100, 100);

    return {
      // Predicted PA outcome distribution
      p: {
        K: pK_pred, BB: pBB_pred, HR: pHR_pred,
        HBP: pHBP, single: p1B, double: p2B, triple: p3B,
        out_in_play: pOutInPlay,
      },
      // Summary
      xwOBA: xwOBA_pred,
      edge,
      lgWOBA,
      // Reason breakdown for UI
      reasons: buildReasons(pitcher, batter, league, platoon, stuff,
                            pK_pred, pBB_pred, pHR_pred),
    };
  }

  function buildReasons(pit, bat, lg, platoon, stuff, pK, pBB, pHR) {
    const r = [];
    // Stuff+ contribution
    if (pit.stuff_plus != null) {
      const d = pit.stuff_plus - 100;
      if (Math.abs(d) >= 5) {
        r.push({
          label: `Stuff+ ${pit.stuff_plus.toFixed(0)}`,
          favors: d > 0 ? 'pitcher' : 'hitter',
          detail: `${Math.abs(d).toFixed(0)}pt ${d > 0 ? 'above' : 'below'} average`,
        });
      }
    }
    // Platoon
    if (bat.bats && pit.throws && bat.bats !== 'S') {
      const same = bat.bats === pit.throws;
      r.push({
        label: same ? 'Same-handed (P advantage)' : 'Opposite-handed (H advantage)',
        favors: same ? 'pitcher' : 'hitter',
        detail: `${bat.bats}HB vs ${pit.throws}HP`,
      });
    }
    // Batter wRC+
    if (bat.wrc_plus != null) {
      const d = bat.wrc_plus - 100;
      if (Math.abs(d) >= 10) {
        r.push({
          label: `wRC+ ${bat.wrc_plus.toFixed(0)}`,
          favors: d > 0 ? 'hitter' : 'pitcher',
          detail: `${Math.abs(d).toFixed(0)}pt ${d > 0 ? 'above' : 'below'} average`,
        });
      }
    }
    // K% gap
    const bK = pct(bat.k_pct), pK_rate = pct(pit.k_pct);
    if (bK != null && pK_rate != null) {
      const gap = (pK_rate - bK) * 100;
      if (Math.abs(gap) >= 4) {
        r.push({
          label: 'K% mismatch',
          favors: gap > 0 ? 'pitcher' : 'hitter',
          detail: `P ${(pK_rate*100).toFixed(1)}% K vs H ${(bK*100).toFixed(1)}% K`,
        });
      }
    }
    return r;
  }

  function clip01(x) { return Math.max(0, Math.min(1, x)); }
  function clipN(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  // Public API
  window.MatchupModel = {
    matchup,
    log5,
    platoonFactors,
    stuffPlusFactors,
    // Helper: probability vector used by Monte Carlo (next repo)
    paOutcomeVector: function (pitcher, batter, league) {
      const m = matchup(pitcher, batter, league);
      if (!m) return null;
      return m.p;
    },
  };
})();
