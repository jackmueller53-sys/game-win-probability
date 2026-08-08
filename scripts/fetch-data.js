#!/usr/bin/env node
/**
 * Three fetches:
 *   1. FanGraphs batting (qual=50)        → data/batters.json
 *   2. FanGraphs pitching (qual=20)        → data/pitchers.json
 *      + FG Stuff+ (type=36) merged in
 *   3. MLB Stats API schedule + lineups    → data/today.json
 *
 * data/league.json + data/meta.json are also written.
 *
 * Adapted from the matchup repo. Self-contained — no cross-repo deps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const SEASON = parseInt(process.env.SEASON || new Date().getFullYear(), 10);
const TODAY_ISO = (process.env.DATE || new Date().toISOString().slice(0, 10));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ─────────────────────────── http ───────────────────────────
// FanGraphs is behind Cloudflare. It 403s requests that CLAIM to be a browser
// (Chrome UA + Sec-Ch-Ua hints) but have a Node/curl TLS fingerprint — the
// mismatch is the tell. Verified (2026-08): a plain/branded UA gets 200, a
// fake Chrome UA gets 403. So do NOT impersonate a browser. Plus a CORS-proxy
// fallback chain on 4xx. (Same fix as the baseball-hub repo.)
const BROWSER_HEADERS = {
  'User-Agent': 'game-win-probability/1.0 (+https://github.com/jackmueller53-sys/game-win-probability)',
  'Accept': 'application/json, text/csv, text/plain, */*',
  'Accept-Encoding': 'identity',
};
const PROXIES = [
  (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
];

function directFetch(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('too many redirects'));
    const parsed = new URL(url);
    const req = https.get(url, {
      headers: { ...BROWSER_HEADERS, 'Referer': `${parsed.origin}/` },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next = res.headers.location;
        if (next.startsWith('/')) next = parsed.origin + next;
        return resolve(directFetch(next, maxRedirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchText(url) {
  try { return await directFetch(url); }
  catch (e) {
    const is4xx = /HTTP 4\d\d/.test(e.message || '');
    if (!is4xx) {
      try { await new Promise(r => setTimeout(r, 300)); return await directFetch(url); }
      catch (_) { /* fall through */ }
    }
    for (let i = 0; i < PROXIES.length; i++) {
      try {
        const txt = await directFetch(PROXIES[i](url));
        console.warn(`    (recovered via proxy ${i + 1}/${PROXIES.length})`);
        return txt;
      } catch (_) { /* try next */ }
    }
    throw new Error(`${e.message} ${url.slice(0, 100)} (proxies also failed)`);
  }
}
async function fetchJSON(url) {
  const t = await fetchText(url);
  try { return JSON.parse(t); }
  catch (e) { throw new Error(`bad JSON from ${url}: ${t.slice(0, 200)}`); }
}

const stripHTML = (s) => s ? String(s).replace(/<[^>]*>/g, '').trim() : '';
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// ─────────────────────────── FanGraphs ───────────────────────
async function fetchFG(stats, qual, type = 8) {
  const url = `https://www.fangraphs.com/api/leaders/major-league/data`
    + `?pos=all&stats=${stats}&lg=all&qual=${qual}&type=${type}`
    + `&season=${SEASON}&season1=${SEASON}&ind=0&team=0&pageitems=2000&pagenum=1`;
  console.log(`  → FG ${stats} type=${type} qual=${qual}`);
  const j = await fetchJSON(url);
  return j.data || [];
}

function mapBatter(r) {
  return {
    id: r.xMLBAMID || r.playerid || null,
    name: stripHTML(r.PlayerName || r.Name),
    team: stripHTML(r.TeamNameAbb || r.Team || ''),
    bats: r.Bats || null,
    pa: num(r.PA), ab: num(r.AB), hr: num(r.HR),
    avg: num(r.AVG), obp: num(r.OBP), slg: num(r.SLG),
    iso: num(r.ISO), babip: num(r.BABIP),
    woba: num(r.wOBA), wrc_plus: num(r['wRC+']),
    k_pct: num(r['K%']), bb_pct: num(r['BB%']),
  };
}
function mapPitcher(r) {
  return {
    id: r.xMLBAMID || r.playerid || null,
    name: stripHTML(r.PlayerName || r.Name),
    team: stripHTML(r.TeamNameAbb || r.Team || ''),
    throws: r.Throws || null,
    ip: num(r.IP), gs: num(r.GS), g: num(r.G),
    era: num(r.ERA), fip: num(r.FIP), xera: num(r.xERA),
    war: num(r.WAR), babip: num(r.BABIP),
    k_pct: num(r['K%']), bb_pct: num(r['BB%']),
    hr_per_9: num(r['HR/9']),
  };
}
function mergeStuffPlus(pitchers, sp) {
  const idx = {};
  sp.forEach(r => { const id = r.xMLBAMID || r.playerid; if (id) idx[id] = r; });
  pitchers.forEach(p => {
    const s = idx[p.id]; if (!s) return;
    p.stuff_plus = num(s.sp_stuff);
    p.location_plus = num(s.sp_location);
    p.pitching_plus = num(s.sp_pitching);
  });
  return pitchers;
}
function computeLeague(batters, pitchers) {
  function wMean(rows, vKey, wKey) {
    let n = 0, d = 0;
    rows.forEach(r => { const v = r[vKey], w = r[wKey] || 1;
      if (v != null && isFinite(v)) { n += v * w; d += w; }
    });
    return d > 0 ? n / d : null;
  }
  return {
    season: SEASON,
    bat: {
      k_pct: wMean(batters, 'k_pct', 'pa'),
      bb_pct: wMean(batters, 'bb_pct', 'pa'),
      woba: wMean(batters, 'woba', 'pa'),
      babip: wMean(batters, 'babip', 'ab'),
      hr_per_pa: batters.reduce((s, r) => s + (r.hr || 0), 0)
                 / Math.max(1, batters.reduce((s, r) => s + (r.pa || 0), 0)),
    },
    pit: {
      k_pct: wMean(pitchers, 'k_pct', 'ip'),
      bb_pct: wMean(pitchers, 'bb_pct', 'ip'),
      babip: wMean(pitchers, 'babip', 'ip'),
      hr_per_pa: wMean(pitchers, 'hr_per_9', 'ip') / 38,
    },
    woba_scale: 1.24,
  };
}

// ─────────────────────────── MLB Stats API ───────────────────
// Schedule with probable pitchers and lineups (when posted).
async function fetchSchedule(dateISO) {
  const url = `https://statsapi.mlb.com/api/v1/schedule`
    + `?sportId=1&date=${dateISO}`
    + `&hydrate=probablePitcher,lineups,team,linescore`;
  console.log(`  → MLB schedule ${dateISO}`);
  const j = await fetchJSON(url);
  const dates = j.dates || [];
  if (!dates.length) return { date: dateISO, games: [] };

  const games = (dates[0].games || []).map(g => ({
    gamePk: g.gamePk,
    status: g.status?.detailedState || g.status?.abstractGameState || null,
    gameTime: g.gameDate || null,
    venue: g.venue?.name || null,
    away: extractSide(g.teams?.away, g.lineups?.awayPlayers),
    home: extractSide(g.teams?.home, g.lineups?.homePlayers),
  }));
  return { date: dateISO, games };
}

function extractSide(side, lineupPlayers) {
  if (!side) return null;
  return {
    teamId: side.team?.id || null,
    teamAbbrev: side.team?.abbreviation || side.team?.teamCode || null,
    teamName: side.team?.name || null,
    probableId: side.probablePitcher?.id || null,
    probableName: side.probablePitcher?.fullName || null,
    // lineup: when MLB has posted starting lineups (usually ~2 hrs before)
    lineupIds: (lineupPlayers || []).map(p => p.id).filter(Boolean),
  };
}

// ─────────────────────────── main ──────────────────────────
async function main() {
  console.log(`Season ${SEASON}, schedule date ${TODAY_ISO}`);
  const t0 = Date.now();
  const errors = [];
  let batters = [], pitchers = [], stuffplus = [];

  try { batters = (await fetchFG('bat', 50)).map(mapBatter).filter(b => b.id); }
  catch (e) { errors.push('bat: ' + e.message); console.error(' ERR', e.message); }
  try { pitchers = (await fetchFG('pit', 20)).map(mapPitcher).filter(p => p.id); }
  catch (e) { errors.push('pit: ' + e.message); console.error(' ERR', e.message); }
  try { stuffplus = await fetchFG('pit', 0, 36); }
  catch (e) { errors.push('stuffplus: ' + e.message); console.error(' ERR', e.message); }

  pitchers = mergeStuffPlus(pitchers, stuffplus);
  const league = computeLeague(batters, pitchers);

  let schedule = { date: TODAY_ISO, games: [] };
  try { schedule = await fetchSchedule(TODAY_ISO); }
  catch (e) { errors.push('schedule: ' + e.message); console.error(' ERR', e.message); }

  // Preserve existing FG-derived files when this run got 0 rows (Cloudflare
  // 403, etc.). today.json is always overwritten — schedule changes daily.
  // Note: build_features.py runs AFTER this script and will overwrite these
  // files with Statcast-derived data, which is the primary source.
  function writeOrPreserve(name, val) {
    const p = path.join(DATA_DIR, name);
    if (Array.isArray(val) ? val.length > 0 : val && Object.keys(val).length > 0) {
      fs.writeFileSync(p, JSON.stringify(val));
    } else {
      console.warn(`  preserving ${name} (this run returned empty)`);
    }
  }
  writeOrPreserve('batters.json',  batters);
  writeOrPreserve('pitchers.json', pitchers);
  writeOrPreserve('league.json',   league);
  fs.writeFileSync(path.join(DATA_DIR, 'today.json'), JSON.stringify(schedule));
  fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify({
    fetchedAt: new Date().toISOString(),
    season: SEASON, date: TODAY_ISO,
    counts: { batters: batters.length, pitchers: pitchers.length,
              games: schedule.games.length, stuffplus: stuffplus.length },
    errors, durationMs: Date.now() - t0,
  }, null, 2));

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. `
    + `batters=${batters.length} pitchers=${pitchers.length} games=${schedule.games.length} errors=${errors.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
