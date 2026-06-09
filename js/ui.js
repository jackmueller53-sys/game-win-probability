/* Win-probability UI.
   Renders today's game slate; on click, runs the Monte Carlo simulator
   client-side and shows the matchup grid + W% bars. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const escHTML = (s) => s == null ? '' : String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Build an index of player → row, lazily.
  let _battersById, _pitchersById, _battersByTeam, _bullpenByTeam;
  function buildIndexes() {
    _battersById = new Map();
    _pitchersById = new Map();
    _battersByTeam = new Map();
    for (const b of window.MatchupData.batters) {
      if (b.id) _battersById.set(b.id, b);
      const t = b.team || '';
      if (!_battersByTeam.has(t)) _battersByTeam.set(t, []);
      _battersByTeam.get(t).push(b);
    }
    for (const p of window.MatchupData.pitchers) {
      if (p.id) _pitchersById.set(p.id, p);
    }
    _bullpenByTeam = computeBullpenComposites(window.MatchupData.pitchers);
  }

  // IP-weighted composite of all pitchers with GS/G < 0.5 (relievers).
  function computeBullpenComposites(pitchers) {
    const byTeam = new Map();
    for (const p of pitchers) {
      const g = p.g || 0, gs = p.gs || 0;
      if (g === 0 || (gs / g) >= 0.5) continue;
      if ((p.ip || 0) < 5) continue;
      if (!byTeam.has(p.team)) byTeam.set(p.team, []);
      byTeam.get(p.team).push(p);
    }
    function w(rows, k) {
      let n = 0, d = 0;
      for (const r of rows) {
        const v = r[k], wt = r.ip || 1;
        if (v != null && isFinite(v)) { n += v * wt; d += wt; }
      }
      return d > 0 ? n / d : null;
    }
    const out = {};
    for (const [team, rows] of byTeam) {
      const ip = rows.reduce((s, r) => s + (r.ip || 0), 0);
      out[team] = {
        team, throws: 'R', ip, gs: 0, g: rows.length,
        k_pct: w(rows, 'k_pct'), bb_pct: w(rows, 'bb_pct'),
        babip: w(rows, 'babip'),
        hr_per_pa: w(rows, 'hr_per_pa') || ((w(rows, 'hr_per_9') || 0) / 38),
        era: w(rows, 'era'), fip: w(rows, 'fip'),
        stuff_plus: 100, location_plus: 100,
        name: team + ' bullpen', _composite: true,
      };
    }
    return out;
  }

  function buildCtx(b, pit, homeTeam) {
    const D = window.MatchupData;
    return {
      bat_split:   b   && D.bat_splits[b.id],
      pit_split:   pit && D.pit_splits[pit.id],
      bat_whiff:   b   && D.bat_whiff[b.id],
      pit_arsenal: pit && D.pit_arsenal[pit.id],
      park_factors: D.park_factors,
      home_team:   homeTeam,
    };
  }

  // Resolve a side's pitcher + lineup. If lineup IDs are missing or stale,
  // fall back to the team's top 9 by PA.
  function resolveSide(side) {
    if (!side) return null;
    const pitcher = side.probableId ? _pitchersById.get(side.probableId) : null;
    let lineup = [];
    if (Array.isArray(side.lineupIds) && side.lineupIds.length >= 8) {
      lineup = side.lineupIds.map(id => _battersById.get(id)).filter(Boolean);
    }
    if (lineup.length < 9) {
      // Fallback: top 9 by PA on this team. Pad with synthetic league-avg batter.
      const onTeam = (_battersByTeam.get(side.teamAbbrev) || []).slice()
        .sort((a, b) => (b.pa || 0) - (a.pa || 0)).slice(0, 9);
      // If we got lineup IDs but missing some, fill out from onTeam
      const haveIds = new Set(lineup.map(b => b.id));
      for (const b of onTeam) {
        if (lineup.length >= 9) break;
        if (!haveIds.has(b.id)) lineup.push(b);
      }
    }
    // Pad with synthetic league-avg if still short
    while (lineup.length < 9) lineup.push(syntheticLeagueAvgBatter());
    return { side, pitcher, lineup, lineupIsProjected: !(Array.isArray(side.lineupIds) && side.lineupIds.length >= 8) };
  }

  function syntheticLeagueAvgBatter() {
    const lg = window.MatchupData.league;
    return {
      id: null, name: '(replacement)', team: '', bats: 'R',
      pa: 100, hr: lg.bat.hr_per_pa * 100,
      avg: 0.245, obp: 0.315, slg: 0.395,
      iso: 0.150, babip: lg.bat.babip || 0.295,
      woba: lg.bat.woba || 0.318, wrc_plus: 90,
      k_pct: lg.bat.k_pct || 0.22, bb_pct: lg.bat.bb_pct || 0.085,
    };
  }

  function syntheticLeagueAvgPitcher() {
    const lg = window.MatchupData.league;
    return {
      id: null, name: '(no probable)', team: '', throws: 'R',
      ip: 100, era: 4.20, fip: 4.20, xera: 4.20,
      k_pct: lg.pit.k_pct, bb_pct: lg.pit.bb_pct,
      babip: lg.pit.babip, hr_per_pa: lg.pit.hr_per_pa,
      stuff_plus: 100, location_plus: 100,
    };
  }

  // ─── Render slate ───
  function renderSlate() {
    const today = window.MatchupData.today;
    const root = $('slate');
    if (!today || !today.games || !today.games.length) {
      root.innerHTML = `<div class="hint">No games found for ${escHTML(today?.date || 'today')}.
        Try setting <code>DATE=YYYY-MM-DD</code> when running <code>scripts/fetch-data.js</code>.</div>`;
      return;
    }

    root.innerHTML = `
      <div class="slate-head">
        <div class="slate-title">Slate — ${escHTML(today.date)}</div>
        <div class="slate-meta">${today.games.length} games</div>
      </div>
      <div class="games" id="games"></div>
    `;

    const gamesEl = $('games');
    today.games.forEach((g, gi) => {
      const home = resolveSide(g.home);
      const away = resolveSide(g.away);
      if (!home || !away) return;

      const card = document.createElement('div');
      card.className = 'game-card';
      card.id = 'g-' + gi;
      card.innerHTML = renderGameCard(g, home, away, gi);
      gamesEl.appendChild(card);

      // Defer sim so cards render fast
      setTimeout(() => simulateAndFill(g, home, away, gi), 50 * gi);
    });
  }

  function renderGameCard(g, home, away, gi) {
    return `
      <div class="game-head">
        <div class="team team-away">
          <div class="team-name">${escHTML(away.side.teamAbbrev || '???')}</div>
          <div class="team-sp">${escHTML(away.pitcher?.name || away.side.probableName || 'TBD')}
            ${away.pitcher ? `<span class="sp-meta">${escHTML(away.pitcher.throws || '?')}HP · ${away.pitcher.era?.toFixed(2) || '—'} ERA</span>` : ''}
          </div>
        </div>
        <div class="game-at">@</div>
        <div class="team team-home">
          <div class="team-name">${escHTML(home.side.teamAbbrev || '???')}</div>
          <div class="team-sp">${escHTML(home.pitcher?.name || home.side.probableName || 'TBD')}
            ${home.pitcher ? `<span class="sp-meta">${escHTML(home.pitcher.throws || '?')}HP · ${home.pitcher.era?.toFixed(2) || '—'} ERA</span>` : ''}
          </div>
        </div>
      </div>
      <div class="wp-bar" id="wp-${gi}">
        <div class="wp-side wp-away" id="wp-a-${gi}">
          <span class="wp-pct">…</span>
        </div>
        <div class="wp-side wp-home" id="wp-h-${gi}">
          <span class="wp-pct">…</span>
        </div>
      </div>
      <div class="runs-line">
        <span id="runs-a-${gi}">— R</span>
        <span class="lineup-note">${away.lineupIsProjected ? 'projected lineup' : 'confirmed lineup'} · ${home.lineupIsProjected ? 'projected' : 'confirmed'}</span>
        <span id="runs-h-${gi}">— R</span>
      </div>
      <details class="matchup-detail">
        <summary>Matchup grid</summary>
        <div class="grid-wrap">
          ${renderMatchupGrid('away', away, home.pitcher || syntheticLeagueAvgPitcher(), home.side.teamAbbrev)}
          ${renderMatchupGrid('home', home, away.pitcher || syntheticLeagueAvgPitcher(), home.side.teamAbbrev)}
        </div>
      </details>
    `;
  }

  function renderMatchupGrid(side, sideObj, pitcher, homeTeamAbbrev) {
    const lg = window.MatchupData.league;
    const rows = sideObj.lineup.map((b, i) => {
      const ctx = buildCtx(b, pitcher, homeTeamAbbrev);
      const m = window.MatchupModel.matchup(pitcher, b, lg, ctx);
      if (!m) return `<tr><td>${i + 1}</td><td>${escHTML(b.name)}</td><td colspan="4">—</td></tr>`;
      return `<tr>
        <td>${i + 1}</td>
        <td class="b-name">${escHTML(b.name)}<span class="b-meta">${escHTML(b.bats || '?')}HB ${b.wrc_plus != null ? '· ' + b.wrc_plus.toFixed(0) + ' wRC+' : ''}</span></td>
        <td>${(m.p.K * 100).toFixed(1)}%</td>
        <td>${(m.p.BB * 100).toFixed(1)}%</td>
        <td>${(m.p.HR * 100).toFixed(1)}%</td>
        <td>${m.xwOBA.toFixed(3)}</td>
        <td class="edge-cell edge-${m.edge < -10 ? 'pitcher' : (m.edge > 10 ? 'hitter' : 'neutral')}">
          ${m.edge > 0 ? '+' : ''}${m.edge.toFixed(0)}</td>
      </tr>`;
    }).join('');
    return `
      <div class="grid-side">
        <div class="grid-head">${escHTML(sideObj.side.teamAbbrev)} vs ${escHTML(pitcher.name || 'avg')} (${escHTML(pitcher.throws || '?')}HP)</div>
        <table class="lineup-grid">
          <thead><tr><th>#</th><th>Batter</th><th>K%</th><th>BB%</th><th>HR%</th><th>xwOBA</th><th>Edge</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function simulateAndFill(g, home, away, gi) {
    const t0 = performance.now();
    const lg = window.MatchupData.league;

    // Use a league-avg synthetic pitcher if probable starter isn't in our data
    const homeP = home.pitcher || syntheticLeagueAvgPitcher();
    const awayP = away.pitcher || syntheticLeagueAvgPitcher();

    const homeBullpen = _bullpenByTeam[home.side.teamAbbrev] || null;
    const awayBullpen = _bullpenByTeam[away.side.teamAbbrev] || null;
    const homeTeamAbbrev = home.side.teamAbbrev;
    const ctxFn = (b, pit) => buildCtx(b, pit, homeTeamAbbrev);

    let result;
    try {
      result = window.WinProbSimulator.simulateGame(
        { pitcher: homeP, lineup: home.lineup, bullpen: homeBullpen },
        { pitcher: awayP, lineup: away.lineup, bullpen: awayBullpen },
        lg,
        { sims: 2000, starterInnings: 6, ctxFn }
      );
    } catch (e) {
      console.error('[sim]', g.gamePk, e);
      $('wp-a-' + gi).innerHTML = '<span class="wp-pct">—</span>';
      $('wp-h-' + gi).innerHTML = '<span class="wp-pct">—</span>';
      return;
    }

    const wHome = result.winProb.home;
    const wAway = result.winProb.away;
    const aPct = (wAway * 100).toFixed(0) + '%';
    const hPct = (wHome * 100).toFixed(0) + '%';
    $('wp-a-' + gi).style.width = (wAway * 100) + '%';
    $('wp-h-' + gi).style.width = (wHome * 100) + '%';
    $('wp-a-' + gi).innerHTML = `<span class="wp-pct">${aPct}</span>`;
    $('wp-h-' + gi).innerHTML = `<span class="wp-pct">${hPct}</span>`;
    $('runs-a-' + gi).textContent = `${result.meanRuns.away.toFixed(2)} R`;
    $('runs-h-' + gi).textContent = `${result.meanRuns.home.toFixed(2)} R`;

    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[sim] game ${gi} (${away.side.teamAbbrev}@${home.side.teamAbbrev}) `
      + `home=${(wHome*100).toFixed(1)}% mean=${result.meanRuns.home.toFixed(2)}-${result.meanRuns.away.toFixed(2)} in ${dt}ms`);
  }

  // ─── Boot ───
  document.addEventListener('DOMContentLoaded', () => {
    const meta = $('meta-line');
    window.MatchupData.ready.then(() => {
      if (!window.MatchupData.league || !window.MatchupData.today) {
        $('slate').innerHTML = `<div class="hint err">Data not available. Run
          <code>node scripts/fetch-data.js</code> or wait for the daily refresh.</div>`;
        return;
      }
      buildIndexes();
      const m = window.MatchupData.meta;
      if (meta && m) {
        meta.textContent = `Season ${m.season} · ${m.counts.games || 0} games today · `
          + `data fetched ${new Date(m.fetchedAt).toLocaleString()}`;
      }
      renderSlate();
    });
  });
})();
