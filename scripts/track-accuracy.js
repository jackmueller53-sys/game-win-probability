/* ══════════════════════════════════════════════════════════════════════════
   MODEL ACCURACY TRACKER  (game-winner predictions)

   Runs the EXACT client model (matchup-model + runs-predictor + simulator) in
   Node so the accuracy we report is the app's real predictions, not a proxy.

   Two records, written to data/prediction-log.json:

     • season  — a ROUGH, one-time backfill over every completed game this
                 season. It scores past games with current season-to-date
                 stats, so it carries mild hindsight bias (optimistic). Labeled
                 as an estimate in the UI.

     • tracked — the true, out-of-sample record. Each day we LOCK a prediction
                 for every game on the slate (before first pitch, since the
                 fetch runs in the morning), then GRADE it once the game is
                 Final. Predictions are never revised after the fact.

   Data source for schedule + results: MLB Stats API (public, no auth). The
   feature files (pitchers/batters/splits/…) are produced by fetch-data.js and
   use MLB team abbreviations, so the schedule joins to them directly.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';
global.window = global;
global.performance = { now: () => Date.now() };

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA = path.join(__dirname, '..', 'data');
const SEASON = 2026;
const OPENING_DAY = `${SEASON}-03-01`;      // wide lower bound; empty days are skipped
const SIMS_BACKFILL = 400;                  // enough to pick a favorite
const SIMS_DAILY = 1500;

// ── model modules (export onto window/global) ──
require('../js/matchup-model.js');
require('../js/runs-predictor.js');
require('../js/simulator.js');

// ── helpers ──
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { return fb; } }
function saveJSON(f, o) { fs.writeFileSync(path.join(DATA, f), JSON.stringify(o)); }
function todayUTC() { return new Date().toISOString().slice(0, 10); }
function getJSON(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: 30000, headers: { Accept: 'application/json' } }, (r) => {
      if (r.statusCode < 200 || r.statusCode >= 300) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } });
    });
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
    req.on('error', rej);
  });
}
async function getJSONRetry(url, n = 3) { let e; for (let i = 0; i < n; i++) { try { return await getJSON(url); } catch (x) { e = x; await new Promise(r => setTimeout(r, 400 * (i + 1))); } } throw e; }

// ── build MatchupData + indexes (mirror data-loader.js + ui.js) ──
const D = {
  pitchers: loadJSON('pitchers.json', []),
  batters:  loadJSON('batters.json', []),
  league:   loadJSON('league.json', null),
  bat_splits: loadJSON('bat_splits.json', {}),
  pit_splits: loadJSON('pit_splits.json', {}),
  bat_whiff:  loadJSON('bat_whiff.json', {}),
  pit_arsenal: loadJSON('pit_arsenal.json', {}),
  park_factors: loadJSON('park_factors.json', {}),
};
window.MatchupData = D;
const pArr = Array.isArray(D.pitchers) ? D.pitchers : Object.values(D.pitchers);
const bArr = Array.isArray(D.batters)  ? D.batters  : Object.values(D.batters);
const _pitchersById = new Map(pArr.map(p => [p.id, p]));
const _battersById  = new Map(bArr.map(b => [b.id, b]));
const _battersByTeam = new Map();
for (const b of bArr) { if (!_battersByTeam.has(b.team)) _battersByTeam.set(b.team, []); _battersByTeam.get(b.team).push(b); }

// computeBullpenComposites — copied from js/ui.js so the sim matches the app
function computeBullpenComposites(pitchers) {
  const byTeam = new Map();
  for (const p of pitchers) {
    const g = p.g || 0, gs = p.gs || 0;
    if (g === 0 || (gs / g) >= 0.5) continue;
    if ((p.ip || 0) < 5) continue;
    if (!byTeam.has(p.team)) byTeam.set(p.team, []);
    byTeam.get(p.team).push(p);
  }
  const w = (rows, k) => { let n = 0, d = 0; for (const r of rows) { const v = r[k], wt = r.ip || 1; if (v != null && isFinite(v)) { n += v * wt; d += wt; } } return d > 0 ? n / d : null; };
  const out = {};
  for (const [team, rows] of byTeam) {
    const ip = rows.reduce((s, r) => s + (r.ip || 0), 0);
    out[team] = { team, throws: 'R', ip, gs: 0, g: rows.length,
      k_pct: w(rows, 'k_pct'), bb_pct: w(rows, 'bb_pct'), babip: w(rows, 'babip'),
      hr_per_pa: w(rows, 'hr_per_pa') || ((w(rows, 'hr_per_9') || 0) / 38),
      era: w(rows, 'era'), fip: w(rows, 'fip'), stuff_plus: 100, location_plus: 100,
      name: team + ' bullpen', _composite: true };
  }
  return out;
}
const _bullpenByTeam = computeBullpenComposites(pArr);

function syntheticLeagueAvgBatter() {
  const lg = D.league;
  return { id: null, name: '(replacement)', team: '', bats: 'R', pa: 100, hr: lg.bat.hr_per_pa * 100,
    avg: 0.245, obp: 0.315, slg: 0.395, iso: 0.150, babip: lg.bat.babip || 0.295,
    woba: lg.bat.woba || 0.318, wrc_plus: 90, k_pct: lg.bat.k_pct || 0.22, bb_pct: lg.bat.bb_pct || 0.085 };
}
function syntheticLeagueAvgPitcher() {
  const lg = D.league;
  return { id: null, name: '(no probable)', team: '', throws: 'R', ip: 100, era: 4.20, fip: 4.20, xera: 4.20,
    k_pct: lg.pit.k_pct, bb_pct: lg.pit.bb_pct, babip: lg.pit.babip, hr_per_pa: lg.pit.hr_per_pa, stuff_plus: 100, location_plus: 100 };
}
function resolveSide(side) {
  const pitcher = side.probableId ? _pitchersById.get(side.probableId) : null;
  let lineup = [];
  if (Array.isArray(side.lineupIds) && side.lineupIds.length >= 8) lineup = side.lineupIds.map(id => _battersById.get(id)).filter(Boolean);
  if (lineup.length < 9) {
    const onTeam = (_battersByTeam.get(side.teamAbbrev) || []).slice().sort((a, b) => (b.pa || 0) - (a.pa || 0)).slice(0, 9);
    const have = new Set(lineup.map(b => b.id));
    for (const b of onTeam) { if (lineup.length >= 9) break; if (!have.has(b.id)) lineup.push(b); }
  }
  while (lineup.length < 9) lineup.push(syntheticLeagueAvgBatter());
  return { pitcher, lineup };
}
function buildCtx(b, pit, homeTeam) {
  return { bat_split: b && D.bat_splits[b.id], pit_split: pit && D.pit_splits[pit.id],
    bat_whiff: b && D.bat_whiff[b.id], pit_arsenal: pit && D.pit_arsenal[pit.id],
    park_factors: D.park_factors, home_team: homeTeam };
}

// Predict a game → { winner:'home'|'away', prob }. `g` = { home, away } sides
// each { teamAbbrev, probableId, lineupIds? }.
function predictGame(g, sims) {
  const home = resolveSide(g.home), away = resolveSide(g.away);
  const homeP = home.pitcher || syntheticLeagueAvgPitcher();
  const awayP = away.pitcher || syntheticLeagueAvgPitcher();
  const ctxFn = (b, pit) => buildCtx(b, pit, g.home.teamAbbrev);
  const r = window.WinProbSimulator.simulateGame(
    { pitcher: homeP, lineup: home.lineup, bullpen: _bullpenByTeam[g.home.teamAbbrev] || null },
    { pitcher: awayP, lineup: away.lineup, bullpen: _bullpenByTeam[g.away.teamAbbrev] || null },
    D.league, { sims, starterInnings: 6, ctxFn });
  const ph = r.winProb.home;
  return { winner: ph >= 0.5 ? 'home' : 'away', prob: Math.max(ph, 1 - ph) };
}

// ── schedule helpers (MLB Stats API) ──
// One request per date range; hydrate probable pitcher + linescore for results.
async function fetchSchedule(startDate, endDate) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`
    + `&season=${SEASON}&hydrate=probablePitcher,team,linescore`;
  const d = await getJSONRetry(url);
  const games = [];
  for (const dt of (d.dates || [])) {
    for (const g of (dt.games || [])) {
      const st = g.status && g.status.abstractGameState;
      const h = g.teams && g.teams.home, a = g.teams && g.teams.away;
      if (!h || !a || !h.team || !a.team) continue;
      games.push({
        gamePk: g.gamePk,
        date: (g.gameDate || dt.date || '').slice(0, 10),
        state: st,                       // 'Final' | 'Live' | 'Preview'
        home: { teamAbbrev: h.team.abbreviation, teamId: h.team.id, probableId: (h.probablePitcher || {}).id || null, score: h.score },
        away: { teamAbbrev: a.team.abbreviation, teamId: a.team.id, probableId: (a.probablePitcher || {}).id || null, score: a.score },
      });
    }
  }
  return games;
}
function actualWinner(g) {
  if (typeof g.home.score !== 'number' || typeof g.away.score !== 'number') return null;
  if (g.home.score === g.away.score) return null;     // shouldn't happen for a Final
  return g.home.score > g.away.score ? 'home' : 'away';
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('── Model accuracy tracker ──');
  if (!D.league) { console.error('  no league.json — aborting (data not built yet)'); process.exit(0); }

  const log = loadJSON('prediction-log.json', null) || {
    season: null,
    tracked: { startDate: todayUTC(), wins: 0, losses: 0, pct: null, entries: [] },
    pending: [],       // predictions locked, awaiting a Final result
    updatedAt: null,
  };
  if (!log.tracked) log.tracked = { startDate: todayUTC(), wins: 0, losses: 0, pct: null, entries: [] };
  if (!log.pending) log.pending = [];

  // ── 1) SEASON BACKFILL (once) ──
  if (!log.season || !log.season.games) {
    console.log('  Backfilling season (rough, one-time)…');
    const sched = await fetchSchedule(OPENING_DAY, todayUTC());
    const finals = sched.filter(g => g.state === 'Final' && actualWinner(g) != null);
    console.log(`    ${finals.length} completed games`);
    let games = 0, correct = 0;
    for (const g of finals) {
      let pred;
      try { pred = predictGame(g, SIMS_BACKFILL); } catch (_) { continue; }
      games++;
      if (pred.winner === actualWinner(g)) correct++;
    }
    log.season = { games, correct, pct: games ? correct / games : null, throughDate: todayUTC(),
      note: 'Rough in-sample estimate: past games scored with current season-to-date stats.' };
    console.log(`    season: ${correct}/${games} = ${(100 * log.season.pct).toFixed(1)}%`);
  }

  // ── 2) GRADE any pending predictions that are now Final ──
  if (log.pending.length) {
    const dates = [...new Set(log.pending.map(p => p.date))].sort();
    const sched = await fetchSchedule(dates[0], todayUTC());
    const byPk = new Map(sched.map(g => [g.gamePk, g]));
    const stillPending = [];
    for (const p of log.pending) {
      const g = byPk.get(p.gamePk);
      if (!g || g.state !== 'Final') { stillPending.push(p); continue; }
      const aw = actualWinner(g);
      if (aw == null) { stillPending.push(p); continue; }
      const correct = p.predWinner === aw;
      if (correct) log.tracked.wins++; else log.tracked.losses++;
      log.tracked.entries.push({ date: p.date, gamePk: p.gamePk, away: p.away, home: p.home,
        predWinner: p.predWinner === 'home' ? p.home : p.away, predProb: p.predProb,
        actualWinner: aw === 'home' ? p.home : p.away, correct });
      console.log(`    graded ${p.away}@${p.home} ${p.date}: pred ${p.predWinner} · actual ${aw} · ${correct ? 'HIT' : 'miss'}`);
    }
    log.pending = stillPending;
    const n = log.tracked.wins + log.tracked.losses;
    log.tracked.pct = n ? log.tracked.wins / n : null;
  }

  // ── 3) LOCK predictions for today's slate (out-of-sample, pre-game) ──
  const today = loadJSON('today.json', null);
  if (today && Array.isArray(today.games)) {
    const known = new Set([...log.pending.map(p => p.gamePk), ...log.tracked.entries.map(e => e.gamePk)]);
    let locked = 0;
    for (const tg of today.games) {
      if (known.has(tg.gamePk)) continue;
      const g = {
        home: { teamAbbrev: tg.home.teamAbbrev, probableId: tg.home.probableId, lineupIds: tg.home.lineupIds },
        away: { teamAbbrev: tg.away.teamAbbrev, probableId: tg.away.probableId, lineupIds: tg.away.lineupIds },
      };
      let pred; try { pred = predictGame(g, SIMS_DAILY); } catch (_) { continue; }
      log.pending.push({ gamePk: tg.gamePk, date: today.date, away: tg.away.teamAbbrev, home: tg.home.teamAbbrev,
        predWinner: pred.winner, predProb: Math.round(pred.prob * 1000) / 1000 });
      locked++;
    }
    if (locked) console.log(`    locked ${locked} prediction(s) for ${today.date}`);
  }

  // keep the tracked entries list from growing without bound (totals are kept)
  if (log.tracked.entries.length > 400) log.tracked.entries = log.tracked.entries.slice(-400);

  log.updatedAt = new Date().toISOString();
  saveJSON('prediction-log.json', log);
  const tn = log.tracked.wins + log.tracked.losses;
  console.log(`✅ season ~${log.season ? (100 * log.season.pct).toFixed(1) : '—'}% (${log.season ? log.season.games : 0}) · `
    + `tracked ${log.tracked.wins}-${log.tracked.losses}${tn ? ' (' + (100 * log.tracked.pct).toFixed(1) + '%)' : ''} · pending ${log.pending.length}`);
}

main().catch(e => { console.error('❌ track-accuracy failed:', e.message); process.exit(0); });
