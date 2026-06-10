/* ══════════════════════════════════════════════════════════════════════════
   PREDICTED-RUNS FEATURE

   Given a "hitting team" (top 9 by PA on that team) + a single pitcher,
   simulate a 9-inning game using per-PA outcome distributions from the
   matchup model. Output:
     - expected runs (mean + 95% CI)
     - per-batter expected wOBA, K%, BB%, edge
     - histogram of simulated game runs

   Recent-form + H2H are wired through the matchup model context. Both
   are deliberately under-weighted (recent ≤ 25%, H2H ≤ ±3% on K%/HR%)
   so seasonal stats remain the dominant signal.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const escHTML = (s) => s == null ? '' : String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ─── MLB team metadata (display names; abbr → full + park abbr) ───
  const TEAM_INFO = {
    ARI: { name: 'Arizona Diamondbacks' }, ATL: { name: 'Atlanta Braves' },
    BAL: { name: 'Baltimore Orioles' },   BOS: { name: 'Boston Red Sox' },
    CHC: { name: 'Chicago Cubs' },        CWS: { name: 'Chicago White Sox' },
    CIN: { name: 'Cincinnati Reds' },     CLE: { name: 'Cleveland Guardians' },
    COL: { name: 'Colorado Rockies' },    DET: { name: 'Detroit Tigers' },
    HOU: { name: 'Houston Astros' },      KC:  { name: 'Kansas City Royals' },
    KCR: { name: 'Kansas City Royals' },  LAA: { name: 'Los Angeles Angels' },
    LAD: { name: 'Los Angeles Dodgers' }, MIA: { name: 'Miami Marlins' },
    MIL: { name: 'Milwaukee Brewers' },   MIN: { name: 'Minnesota Twins' },
    NYM: { name: 'New York Mets' },       NYY: { name: 'New York Yankees' },
    OAK: { name: 'Oakland Athletics' },   ATH: { name: 'Athletics' },
    PHI: { name: 'Philadelphia Phillies' }, PIT: { name: 'Pittsburgh Pirates' },
    SD:  { name: 'San Diego Padres' },    SDP: { name: 'San Diego Padres' },
    SEA: { name: 'Seattle Mariners' },    SF:  { name: 'San Francisco Giants' },
    SFG: { name: 'San Francisco Giants' }, STL: { name: 'St. Louis Cardinals' },
    TB:  { name: 'Tampa Bay Rays' },      TBR: { name: 'Tampa Bay Rays' },
    TEX: { name: 'Texas Rangers' },       TOR: { name: 'Toronto Blue Jays' },
    WSN: { name: 'Washington Nationals' },
  };

  // ─── Team list — pulled from batters' actual teams (no empty rows) ───
  function teamsFromBatters(batters) {
    const cnt = new Map();
    for (const b of batters) {
      const t = (b.team || '').trim();
      if (!t) continue;
      cnt.set(t, (cnt.get(t) || 0) + 1);
    }
    return [...cnt.entries()]
      .filter(([, n]) => n >= 5)              // require ≥5 batters on team
      .map(([abbr, n]) => ({
        abbr, name: (TEAM_INFO[abbr] || {}).name || abbr,
        n_batters: n,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ─── Normal lineup: top 9 batters by PA on this team ───
  function normalLineup(team, batters) {
    return batters.filter(b => b.team === team)
      .sort((a, b) => (b.pa || 0) - (a.pa || 0))
      .slice(0, 9);
  }

  // ─── Sim: 9 innings, batting order through PAs, base-out chain ───
  const EVENTS = ['K','BB','HBP','HR','triple','double','single','out_in_play'];

  function buildCDF(p) {
    let cum = 0; const cdf = [];
    for (const e of EVENTS) {
      cum += Math.max(0, p[e] || 0);
      cdf.push(cum);
    }
    if (cum > 0 && Math.abs(cum - 1) > 1e-6) {
      for (let i = 0; i < cdf.length; i++) cdf[i] /= cum;
    }
    return cdf;
  }

  function sampleEvent(cdf, rng) {
    const r = rng();
    for (let i = 0; i < cdf.length; i++) if (r <= cdf[i]) return EVENTS[i];
    return EVENTS[EVENTS.length - 1];
  }

  function applyEvent(ev, bases, outs) {
    let [b1, b2, b3] = bases, r = 0;
    if (ev === 'K' || ev === 'out_in_play')
      return { bases: [b1, b2, b3], outs: outs + 1, r: 0 };
    if (ev === 'BB' || ev === 'HBP') {
      if (b1 && b2 && b3) r = 1;
      else if (b1 && b2)  b3 = true;
      else if (b1)        { b2 = true; b1 = true; }
      else                b1 = true;
      return { bases: [b1, b2, b3], outs, r };
    }
    if (ev === 'single') {
      if (b3) r++; if (b2) r++;
      b3 = b1; b2 = false; b1 = true;
      return { bases: [b1, b2, b3], outs, r };
    }
    if (ev === 'double') {
      if (b3) r++; if (b2) r++; if (b1) r++;
      b3 = false; b2 = true; b1 = false;
      return { bases: [b1, b2, b3], outs, r };
    }
    if (ev === 'triple') {
      if (b3) r++; if (b2) r++; if (b1) r++;
      b1 = false; b2 = false; b3 = true;
      return { bases: [b1, b2, b3], outs, r };
    }
    if (ev === 'HR') {
      r = 1 + (b1 ? 1 : 0) + (b2 ? 1 : 0) + (b3 ? 1 : 0);
      return { bases: [false, false, false], outs, r };
    }
    return { bases: [b1, b2, b3], outs, r: 0 };
  }

  function simHalf(state, cdfs, rng) {
    let bases = [false, false, false], outs = 0, runs = 0;
    while (outs < 3) {
      const cdf = cdfs[state.idx];
      const ev = sampleEvent(cdf, rng);
      const out = applyEvent(ev, bases, outs);
      bases = out.bases; outs = out.outs; runs += out.r;
      state.idx = (state.idx + 1) % cdfs.length;
      if (runs > 25) break; // safety
    }
    return runs;
  }

  // ─── Main public function ───
  function predictRuns(lineup, pitcher, league, opts = {}) {
    const sims = opts.sims || 3000;
    const innings = opts.innings || 9;
    const ctxBuilder = opts.ctxBuilder || (() => null);
    const rng = opts.rng || Math.random;

    // Per-batter matchup analysis (used for both CDFs + display table)
    const perBatter = lineup.map(b => {
      const ctx = ctxBuilder(b, pitcher);
      const m = window.MatchupModel.matchup(pitcher, b, league, ctx);
      return { b, m, ctx };
    }).filter(x => x.m);

    if (perBatter.length < 9) return { error: 'lineup too short or model returned null for some batters' };

    const cdfs = perBatter.map(x => buildCDF(x.m.p));

    // Run sims
    const runsArr = new Array(sims);
    for (let s = 0; s < sims; s++) {
      let total = 0;
      const state = { idx: 0 };
      for (let i = 0; i < innings; i++) total += simHalf(state, cdfs, rng);
      runsArr[s] = total;
    }

    // Stats
    runsArr.sort((a, b) => a - b);
    const mean = runsArr.reduce((s, x) => s + x, 0) / sims;
    const median = runsArr[Math.floor(sims / 2)];
    const p05 = runsArr[Math.floor(sims * 0.05)];
    const p95 = runsArr[Math.floor(sims * 0.95)];

    // Histogram: 0..max+1 buckets of width 1
    const max = runsArr[runsArr.length - 1];
    const hist = new Array(max + 1).fill(0);
    for (const r of runsArr) hist[r]++;

    return {
      sims, mean, median, p05, p95, max,
      hist, perBatter,
    };
  }

  // ═════════ UI module ═════════
  const Mod = {};

  Mod.init = function (pitchers, batters) {
    const teams = teamsFromBatters(batters);

    // Team typeahead
    window.Typeahead.attach({
      inputEl: document.getElementById('runs-team-input'),
      items: teams,
      matchFn: (row, q) => row.name.toLowerCase().includes(q)
                          || row.abbr.toLowerCase().includes(q),
      renderRow: (row, q) => `
        <div class="ta-row-name">${escHTML(row.name)}
          <span class="ta-team">${escHTML(row.abbr)}</span></div>
        <div class="ta-row-meta">
          <span class="ta-stat">${row.n_batters} batters w/ PA</span>
        </div>
      `,
      onSelect: (row) => { _team = row; render(); },
    });

    // Pitcher typeahead (separate input from the single-matchup one)
    window.Typeahead.attach({
      inputEl: document.getElementById('runs-pitcher-input'),
      items: pitchers.slice().sort((a, b) => (b.ip || 0) - (a.ip || 0)),
      renderRow: (p, q) => `
        <div class="ta-row-name">${escHTML(p.name)}</div>
        <div class="ta-row-meta">
          <span class="ta-team">${escHTML(p.team || '?')}</span>
          <span class="ta-hand">${escHTML(p.throws || '?')}HP</span>
          ${p.ip != null ? `<span class="ta-stat">${p.ip.toFixed(1)} IP</span>` : ''}
          ${p.k_pct != null ? `<span class="ta-stat">${(p.k_pct > 1 ? p.k_pct : p.k_pct * 100).toFixed(1)} K%</span>` : ''}
          ${p.stuff_plus != null ? `<span class="ta-stat">Stuff+ ${p.stuff_plus.toFixed(0)}</span>` : ''}
        </div>
      `,
      onSelect: (p) => { _pitcher = p; render(); },
    });

    _allBatters = batters;
  };

  let _team = null, _pitcher = null, _allBatters = [];

  function buildCtx(b, p, homeTeam) {
    const D = window.MatchupData;
    return {
      bat_split:    D.bat_splits && D.bat_splits[b.id],
      pit_split:    D.pit_splits && D.pit_splits[p.id],
      bat_whiff:    D.bat_whiff && D.bat_whiff[b.id],
      pit_arsenal:  D.pit_arsenal && D.pit_arsenal[p.id],
      park_factors: D.park_factors,
      home_team:    homeTeam,
      // recent-form & H2H — populated by Tier B builder if present
      bat_recent:   D.bat_recent && D.bat_recent[b.id],
      pit_recent:   D.pit_recent && D.pit_recent[p.id],
      h2h:          D.h2h && D.h2h[p.id + '|' + b.id],
    };
  }

  function render() {
    const out = document.getElementById('runs-result');
    if (!_team || !_pitcher) {
      out.innerHTML = '<div class="hint">Pick a team and a pitcher to project expected runs.</div>';
      return;
    }
    const lineup = normalLineup(_team.abbr, _allBatters);
    if (lineup.length < 9) {
      out.innerHTML = `<div class="hint err">${escHTML(_team.abbr)} has only ${lineup.length} qualified batters in our data — need ≥9 for a lineup.</div>`;
      return;
    }
    const lg = window.MatchupData.league;
    // Use pitcher's team as "home" — venue effects flow through park factor.
    // This is an approximation since we don't know the actual game venue here.
    const homeTeam = _pitcher.team || null;
    const result = predictRuns(lineup, _pitcher, lg, {
      sims: 3000,
      ctxBuilder: (b, p) => buildCtx(b, p, homeTeam),
    });
    if (result.error) {
      out.innerHTML = '<div class="hint err">' + escHTML(result.error) + '</div>';
      return;
    }
    out.innerHTML = renderResult(result, lineup, _pitcher, _team);
  }

  function renderResult(r, lineup, pit, team) {
    return `
      <div class="runs-summary">
        <div class="runs-stat-card">
          <div class="runs-stat-num">${r.mean.toFixed(2)}</div>
          <div class="runs-stat-lbl">Expected runs</div>
          <div class="runs-stat-sub">across 9 innings, ${r.sims.toLocaleString()} sims</div>
        </div>
        <div class="runs-stat-card">
          <div class="runs-stat-num">${r.p05}–${r.p95}</div>
          <div class="runs-stat-lbl">90% range</div>
          <div class="runs-stat-sub">median ${r.median}</div>
        </div>
        <div class="runs-stat-card">
          <div class="runs-stat-num">${avgEdge(r.perBatter).toFixed(0)}</div>
          <div class="runs-stat-lbl">Avg matchup edge</div>
          <div class="runs-stat-sub">+ hitter / − pitcher</div>
        </div>
      </div>

      <div class="runs-hist">
        <div class="card-h">Runs distribution</div>
        ${renderHistogram(r)}
      </div>

      <div class="runs-lineup-card">
        <div class="card-h">${escHTML(team.abbr)} vs ${escHTML(pit.name)} (${escHTML(pit.throws || '?')}HP) — per-batter projection</div>
        ${renderLineupTable(r.perBatter)}
        <div class="runs-stat-sub" style="margin-top:8px">
          Recent-form blended at ≤25% weight when last-30d has ≥30 PA.
          Matchup history applied at ±3% max on K%/HR% when ≥25 H2H PAs exist.
          Seasonal stats remain the dominant signal in all cases.
        </div>
      </div>
    `;
  }

  function avgEdge(pb) {
    let s = 0, n = 0;
    for (const x of pb) { s += x.m.edge; n++; }
    return n ? s / n : 0;
  }

  function renderHistogram(r) {
    const W = 600, H = 140, PAD = { l: 30, r: 10, t: 10, b: 24 };
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    const maxBar = Math.max(...r.hist);
    const bw = innerW / r.hist.length;
    let bars = '', ticks = '';
    for (let i = 0; i < r.hist.length; i++) {
      const h = (r.hist[i] / maxBar) * innerH;
      const x = PAD.l + i * bw;
      const y = PAD.t + innerH - h;
      bars += `<rect class="runs-hist-bar" x="${x + 1}" y="${y}" width="${bw - 2}" height="${h}"></rect>`;
      // x-axis ticks every 2 runs
      if (i % 2 === 0) {
        ticks += `<text class="runs-hist-axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${i}</text>`;
      }
    }
    // mean line
    const meanX = PAD.l + (r.mean / r.hist.length) * innerW;
    return `<svg class="runs-hist-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of simulated runs">
      ${bars}
      <line x1="${meanX}" y1="${PAD.t}" x2="${meanX}" y2="${PAD.t + innerH}"
            stroke="#1d1916" stroke-width="2" stroke-dasharray="4 3" opacity="0.6"></line>
      <text class="runs-hist-axis" x="${meanX + 4}" y="${PAD.t + 12}">mean ${r.mean.toFixed(2)}</text>
      ${ticks}
      <text class="runs-hist-axis" x="${PAD.l}" y="${PAD.t + innerH + 18}" text-anchor="start">runs scored</text>
    </svg>`;
  }

  function renderLineupTable(perBatter) {
    const rows = perBatter.map((x, i) => {
      const b = x.b, m = x.m;
      const flag = recentFlag(x.ctx && x.ctx.bat_recent, b);
      return `<tr>
        <td>${i + 1}</td>
        <td class="b-name">${escHTML(b.name)}${flag}
          <small>${escHTML(b.bats || '?')}HB${b.wrc_plus != null ? ' · ' + b.wrc_plus.toFixed(0) + ' wRC+' : ''}</small></td>
        <td class="num">${(m.p.K * 100).toFixed(1)}%</td>
        <td class="num">${(m.p.BB * 100).toFixed(1)}%</td>
        <td class="num">${(m.p.HR * 100).toFixed(1)}%</td>
        <td class="num">${m.xwOBA.toFixed(3)}</td>
        <td class="num"><b>${m.edge > 0 ? '+' : ''}${m.edge.toFixed(0)}</b></td>
      </tr>`;
    }).join('');
    return `<table class="runs-lineup-table">
      <thead><tr>
        <th>#</th><th>Batter</th><th class="num">K%</th><th class="num">BB%</th>
        <th class="num">HR%</th><th class="num">xwOBA</th><th class="num">Edge</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Tag a batter as "hot" / "cold" if last-30d wOBA deviates ≥30 pts from season.
  function recentFlag(recent, b) {
    if (!recent || !b.woba || recent.pa < 30) return '';
    const delta = (recent.woba || b.woba) - b.woba;
    if (delta >= 0.030) return '<span class="recent-flag hot">HOT</span>';
    if (delta <= -0.030) return '<span class="recent-flag cold">COLD</span>';
    return '';
  }

  Mod.predictRuns = predictRuns;
  window.RunsPredictorUI = Mod;
})();
