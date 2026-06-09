#!/usr/bin/env python3
"""
Production daily Statcast feature builder.

Pulls the CURRENT season's pitch-level data via pybaseball, derives the
v1.1 model features, and writes JSON into data/:

  - bat_splits.json       — vs-handedness rates per batter
  - pit_splits.json       — vs-handedness rates per pitcher
  - bat_whiff.json        — per-pitch-type whiff% per batter
  - pit_arsenal.json      — per-pitch-type usage per pitcher
  - park_factors.json     — static recent 3-yr park factors

Runs daily after fetch-data.js. CI installs pybaseball+pandas+numpy.

Env vars:
  SEASON   = 2026 (default = current year)
  PB_DAYS  = look back this many days only (for faster reruns during season)
"""
import os
import sys
import json
import time
from datetime import date, timedelta
from pathlib import Path
from collections import defaultdict

import pandas as pd
from pybaseball import statcast, cache as pb_cache

HERE = Path(__file__).parent
DATA = HERE.parent / 'data'
DATA.mkdir(exist_ok=True)
pb_cache.enable()

SEASON = int(os.environ.get('SEASON', date.today().year))
PB_DAYS = int(os.environ.get('PB_DAYS', '0'))

# Date range — full season or rolling N days
if PB_DAYS > 0:
    end = date.today()
    start = end - timedelta(days=PB_DAYS)
else:
    # Spring training out, regular season only
    start = date(SEASON, 3, 20)
    end = min(date.today(), date(SEASON, 10, 5))

if end <= start:
    print(f'Date range {start}..{end} is empty (season {SEASON} not started?).')
    sys.exit(0)


PITCH_GROUPS = {
    'FF': 'FF', 'FT': 'FF', 'SI': 'SI', 'FC': 'FC',
    'SL': 'SL', 'ST': 'SL', 'SV': 'SL', 'CU': 'CU', 'KC': 'CU', 'CS': 'CU',
    'CH': 'CH', 'FS': 'FS', 'FO': 'FS', 'SC': 'CH',
    'KN': 'OT', 'EP': 'OT',
}
PITCH_TYPES = ['FF', 'SI', 'FC', 'SL', 'CU', 'CH', 'FS']

# 2022-2024 3-yr park factors (FanGraphs basic)
PARK_FACTORS = {
    'COL': {'r': 116, 'hr': 117}, 'CIN': {'r': 110, 'hr': 119},
    'BOS': {'r': 108, 'hr': 95},  'BAL': {'r': 103, 'hr': 105},
    'TEX': {'r': 102, 'hr': 102}, 'TOR': {'r': 101, 'hr': 102},
    'CWS': {'r': 101, 'hr': 102}, 'KCR': {'r': 100, 'hr': 95},
    'KC':  {'r': 100, 'hr': 95},  'PHI': {'r': 100, 'hr': 102},
    'WSN': {'r': 99,  'hr': 99},  'MIN': {'r': 99,  'hr': 102},
    'CHC': {'r': 98,  'hr': 100}, 'ARI': {'r': 99,  'hr': 102},
    'HOU': {'r': 98,  'hr': 98},  'LAA': {'r': 97,  'hr': 95},
    'ATL': {'r': 97,  'hr': 100}, 'SDP': {'r': 96,  'hr': 92},
    'SD':  {'r': 96,  'hr': 92},  'CLE': {'r': 96,  'hr': 92},
    'STL': {'r': 96,  'hr': 92},  'NYY': {'r': 95,  'hr': 98},
    'NYM': {'r': 95,  'hr': 93},  'MIA': {'r': 94,  'hr': 90},
    'DET': {'r': 94,  'hr': 92},  'PIT': {'r': 96,  'hr': 92},
    'OAK': {'r': 94,  'hr': 92},  'ATH': {'r': 94,  'hr': 92},
    'TBR': {'r': 96,  'hr': 95},  'TB':  {'r': 96,  'hr': 95},
    'SEA': {'r': 92,  'hr': 90},  'SFG': {'r': 92,  'hr': 88},
    'SF':  {'r': 92,  'hr': 88},  'LAD': {'r': 98,  'hr': 102},
    'MIL': {'r': 99,  'hr': 100},
}


def to_pa_outcomes(df):
    df = df.sort_values(['game_pk', 'at_bat_number', 'pitch_number'])
    last = df.groupby(['game_pk', 'at_bat_number'], as_index=False).tail(1).copy()
    def label(evt):
        if pd.isna(evt): return None
        e = str(evt)
        if e in ('strikeout', 'strikeout_double_play'): return 'K'
        if e == 'walk': return 'BB'
        if e == 'hit_by_pitch': return 'HBP'
        if e == 'home_run': return 'HR'
        if e == 'triple': return 'triple'
        if e == 'double': return 'double'
        if e == 'single': return 'single'
        if e in ('field_out', 'grounded_into_double_play', 'force_out',
                 'fielders_choice', 'fielders_choice_out', 'sac_fly', 'sac_bunt',
                 'sac_fly_double_play', 'double_play', 'triple_play',
                 'sac_bunt_double_play', 'field_error'):
            return 'out_in_play'
        return None
    last['outcome'] = last['events'].map(label)
    return last[last['outcome'].notna()].copy()


def compute_splits(pa, by_col, vs_col):
    out = defaultdict(dict)
    for (pid, hand), g in pa.groupby([by_col, vs_col]):
        n = len(g)
        if n < 30: continue
        k = (g['outcome'] == 'K').mean()
        bb = (g['outcome'] == 'BB').mean()
        hr = (g['outcome'] == 'HR').mean()
        h_ip = g['outcome'].isin(['single', 'double', 'triple']).sum()
        n_ip = g['outcome'].isin(['single', 'double', 'triple', 'out_in_play']).sum()
        babip = (h_ip / n_ip) if n_ip > 0 else None
        out[int(pid)][hand] = {
            'pa': int(n), 'k_pct': float(k), 'bb_pct': float(bb),
            'hr_per_pa': float(hr),
            'babip': float(babip) if babip is not None else None,
        }
    return dict(out)


def compute_whiff(pitches):
    SW = {'swinging_strike', 'foul_tip', 'swinging_strike_blocked',
          'hit_into_play', 'foul', 'foul_bunt', 'missed_bunt'}
    WH = {'swinging_strike', 'foul_tip', 'swinging_strike_blocked',
          'swinging_pitchout', 'missed_bunt'}
    p = pitches.copy()
    p['ptype'] = p['pitch_type'].map(PITCH_GROUPS).fillna('OT')
    p['is_swing'] = p['description'].isin(SW)
    p['is_whiff'] = p['description'].isin(WH)
    out = defaultdict(dict)
    for (bid, pt), g in p.groupby(['batter', 'ptype']):
        if pt not in PITCH_TYPES: continue
        sw = int(g['is_swing'].sum())
        if sw < 30: continue
        wh = int(g['is_whiff'].sum())
        out[int(bid)][pt] = {'swings': sw, 'whiffs': wh,
                             'whiff_pct': wh / sw}
    return dict(out)


def compute_arsenal(pitches):
    p = pitches.copy()
    p['ptype'] = p['pitch_type'].map(PITCH_GROUPS).fillna('OT')
    out = {}
    for pid, g in p.groupby('pitcher'):
        total = len(g)
        if total < 50: continue
        rec = {'total_pitches': total, 'arsenal': {}}
        for pt in PITCH_TYPES:
            sub = g[g['ptype'] == pt]
            if len(sub) == 0: continue
            rec['arsenal'][pt] = {
                'usage_pct': float(len(sub) / total),
                'avg_velo': float(sub['release_speed'].mean()) if 'release_speed' in sub else None,
            }
        out[int(pid)] = rec
    return out


def mlb_people_lookup(ids):
    """Resolve {mlbam_id: {fullName, bats, throwHand}} via MLB Stats API.
    Free + unauthenticated; accepts up to ~1000 IDs at a time."""
    import urllib.request, ssl
    out = {}
    ids = list({int(i) for i in ids if i is not None})
    if not ids: return out
    # batch in 500s to keep URL length safe
    ctx = ssl.create_default_context()
    try: import certifi; ctx.load_verify_locations(certifi.where())
    except Exception: pass
    for i in range(0, len(ids), 500):
        chunk = ids[i:i+500]
        url = ('https://statsapi.mlb.com/api/v1/people?personIds='
               + ','.join(str(x) for x in chunk))
        try:
            raw = urllib.request.urlopen(
                urllib.request.Request(url, headers={'User-Agent': 'matchup/1.1'}),
                context=ctx, timeout=30).read()
            j = json.loads(raw.decode())
            for p in (j.get('people') or []):
                out[int(p['id'])] = {
                    'fullName': p.get('fullName'),
                    'bats': (p.get('batSide') or {}).get('code'),
                    'throws': (p.get('pitchHand') or {}).get('code'),
                }
        except Exception as e:
            print(f'  MLB people lookup chunk failed ({i}-{i+500}): {e}')
    return out


def player_meta(sc):
    """For each MLBAM id, latest seen (name, team, bats, throws)."""
    out = {'bat': {}, 'pit': {}}
    sc2 = sc.sort_values('game_date')  # latest-wins
    for _, r in sc2[['batter', 'stand']].drop_duplicates('batter').iterrows():
        out['bat'][int(r['batter'])] = {'bats': r.get('stand') or None}
    for _, r in sc2[['pitcher', 'p_throws']].drop_duplicates('pitcher').iterrows():
        out['pit'][int(r['pitcher'])] = {'throws': r.get('p_throws') or None}
    # Try to enrich with team + name from latest game.
    if 'home_team' in sc2.columns:
        last = sc2.sort_values(['game_pk', 'at_bat_number', 'pitch_number']).groupby(
            ['batter', 'inning_topbot'], as_index=False).tail(1)
        for _, r in last.iterrows():
            bid = int(r['batter'])
            tt = r['away_team'] if r.get('inning_topbot') == 'Top' else r['home_team']
            if bid in out['bat'] and tt: out['bat'][bid]['team'] = tt
        last_p = sc2.sort_values(['game_pk', 'at_bat_number', 'pitch_number']).groupby(
            ['pitcher', 'inning_topbot'], as_index=False).tail(1)
        for _, r in last_p.iterrows():
            pid = int(r['pitcher'])
            tt = r['home_team'] if r.get('inning_topbot') == 'Top' else r['away_team']
            if pid in out['pit'] and tt: out['pit'][pid]['team'] = tt
    return out


def compute_batters_from_statcast(pa, meta):
    """Derive seasonal batter rows from PA outcomes.

    Uses linear-weights wOBA (FG values, close enough year to year):
        BB=0.69, HBP=0.72, 1B=0.89, 2B=1.27, 3B=1.62, HR=2.10
    """
    LIN = {'BB': 0.690, 'HBP': 0.720, 'single': 0.890,
           'double': 1.271, 'triple': 1.616, 'HR': 2.101}
    out = []
    for bid, g in pa.groupby('batter'):
        n = len(g)
        if n < 25: continue  # min PA threshold
        c = {e: int((g['outcome'] == e).sum()) for e in
             ['K', 'BB', 'HBP', 'HR', 'triple', 'double', 'single', 'out_in_play']}
        ab = n - c['BB'] - c['HBP']
        h = c['single'] + c['double'] + c['triple'] + c['HR']
        bip_n = c['single'] + c['double'] + c['triple'] + c['out_in_play']
        avg = h / ab if ab > 0 else None
        obp = (h + c['BB'] + c['HBP']) / n
        tb = c['single'] + 2 * c['double'] + 3 * c['triple'] + 4 * c['HR']
        slg = tb / ab if ab > 0 else None
        iso = (slg - avg) if (slg is not None and avg is not None) else None
        babip = (h - c['HR']) / (ab - c['K'] - c['HR']) if (ab - c['K'] - c['HR']) > 0 else None
        woba_num = sum(LIN[e] * c[e] for e in LIN)
        woba_den = n - 0  # no IBB column; treat all BB as included
        woba = woba_num / woba_den if woba_den > 0 else None
        m = meta['bat'].get(int(bid), {})
        out.append({
            'id': int(bid), 'name': m.get('name'), 'team': m.get('team'),
            'bats': m.get('bats'),
            'pa': n, 'ab': ab, 'hr': c['HR'],
            'avg': round(avg, 4) if avg is not None else None,
            'obp': round(obp, 4),
            'slg': round(slg, 4) if slg is not None else None,
            'iso': round(iso, 4) if iso is not None else None,
            'babip': round(babip, 4) if babip is not None else None,
            'woba': round(woba, 4) if woba is not None else None,
            'wrc_plus': None,        # FG augmentation fills this when available
            'k_pct': round(c['K'] / n, 4),
            'bb_pct': round(c['BB'] / n, 4),
        })
    return out


def compute_pitchers_from_statcast(pa, sc, meta):
    """Derive seasonal pitcher rows + classify starters vs relievers from
    appearance pattern. A pitcher's GS = # of games where they recorded
    the first PA of any half-inning where the inning was 1; G = # games."""
    # Determine G + GS per pitcher
    appear = pa.drop_duplicates(['game_pk', 'pitcher'])[['game_pk', 'pitcher']]
    g_counts = appear.groupby('pitcher').size().to_dict()
    # GS = games where pitcher faced a batter in inning 1
    starters_set = pa[pa['inning'] == 1][['game_pk', 'pitcher']].drop_duplicates()
    gs_counts = starters_set.groupby('pitcher').size().to_dict()

    # IP via outs recorded (out_in_play + K) / 3
    out = []
    for pid, g in pa.groupby('pitcher'):
        n = len(g)
        if n < 25: continue
        c = {e: int((g['outcome'] == e).sum()) for e in
             ['K', 'BB', 'HBP', 'HR', 'triple', 'double', 'single', 'out_in_play']}
        outs_recorded = c['K'] + c['out_in_play']
        # 1 IP ≈ 3 outs. Use integer 'whole' + remainder * .1 for FG-style display.
        ip_whole = outs_recorded // 3
        ip_rem = outs_recorded % 3
        ip = ip_whole + (ip_rem / 10.0)
        ab = n - c['BB'] - c['HBP']
        h = c['single'] + c['double'] + c['triple'] + c['HR']
        babip = (h - c['HR']) / (ab - c['K'] - c['HR']) if (ab - c['K'] - c['HR']) > 0 else None
        hr_per_pa = c['HR'] / n
        hr_per_9 = (c['HR'] / outs_recorded * 27) if outs_recorded > 0 else None
        m = meta['pit'].get(int(pid), {})
        gp = g_counts.get(pid, 0)
        gs = gs_counts.get(pid, 0)
        out.append({
            'id': int(pid), 'name': m.get('name'), 'team': m.get('team'),
            'throws': m.get('throws'),
            'ip': round(ip, 1), 'gs': int(gs), 'g': int(gp),
            'era': None, 'fip': None, 'xfip': None, 'xera': None,  # FG fills these
            'war': None, 'whip': None,
            'k_pct': round(c['K'] / n, 4),
            'bb_pct': round(c['BB'] / n, 4),
            'hr_per_9': round(hr_per_9, 3) if hr_per_9 is not None else None,
            'hr_per_pa': round(hr_per_pa, 4),
            'babip': round(babip, 4) if babip is not None else None,
            'gb_pct': None, 'lob_pct': None,
            'stuff_plus': None, 'location_plus': None, 'pitching_plus': None,  # FG augments
        })
    return out


def compute_league(batters, pitchers):
    def w(rows, k, wkey):
        n, d = 0, 0
        for r in rows:
            v, wt = r.get(k), r.get(wkey) or 1
            if v is not None and isinstance(v, (int, float)) and v == v:
                n += v * wt; d += wt
        return round(n / d, 4) if d > 0 else None
    total_pa = sum((r.get('pa') or 0) for r in batters)
    total_hr = sum((r.get('hr') or 0) for r in batters)
    return {
        'bat': {
            'k_pct':  w(batters, 'k_pct',  'pa'),
            'bb_pct': w(batters, 'bb_pct', 'pa'),
            'woba':   w(batters, 'woba',   'pa'),
            'babip':  w(batters, 'babip',  'ab'),
            'iso':    w(batters, 'iso',    'ab'),
            'avg':    w(batters, 'avg',    'ab'),
            'obp':    w(batters, 'obp',    'pa'),
            'slg':    w(batters, 'slg',    'ab'),
            'hr_per_pa': round(total_hr / max(1, total_pa), 4),
        },
        'pit': {
            'k_pct':  w(pitchers, 'k_pct',  'ip'),
            'bb_pct': w(pitchers, 'bb_pct', 'ip'),
            'babip':  w(pitchers, 'babip',  'ip'),
            'hr_per_pa': w(pitchers, 'hr_per_pa', 'ip'),
        },
        'season': SEASON,
    }


def augment_from_fg(batters, pitchers):
    """Pull wRC+, Stuff+/Location+/Pitching+ from FG JSON files if present
    on disk. When FG was reachable, these files have content; when blocked,
    they're empty arrays and this is a no-op."""
    by_b = {b['id']: b for b in batters}
    by_p = {p['id']: p for p in pitchers}
    fg_bat = DATA / 'fg-bat.json'
    fg_pit = DATA / 'fg-pit.json'
    fg_sp  = DATA / 'fg-stuffplus.json'
    augmented_b, augmented_p = 0, 0

    if fg_bat.exists():
        try:
            fg = json.loads(fg_bat.read_text() or '[]')
            for r in fg:
                bid = r.get('xMLBAMID') or r.get('playerid')
                if not bid or bid not in by_b: continue
                if 'wRC+' in r and r['wRC+'] is not None: by_b[bid]['wrc_plus'] = r['wRC+']
                augmented_b += 1
        except Exception as e:
            print(f'  FG-bat augment skipped: {e}')
    if fg_pit.exists():
        try:
            fg = json.loads(fg_pit.read_text() or '[]')
            for r in fg:
                pid = r.get('xMLBAMID') or r.get('playerid')
                if not pid or pid not in by_p: continue
                # Fill in FG-only fields when available
                for src, dst in [('ERA', 'era'), ('FIP', 'fip'), ('xFIP', 'xfip'),
                                 ('xERA', 'xera'), ('WAR', 'war'), ('WHIP', 'whip')]:
                    v = r.get(src)
                    if v is not None: by_p[pid][dst] = v
                augmented_p += 1
        except Exception as e:
            print(f'  FG-pit augment skipped: {e}')
    if fg_sp.exists():
        try:
            sp = json.loads(fg_sp.read_text() or '[]')
            for r in sp:
                pid = r.get('xMLBAMID') or r.get('playerid')
                if not pid or pid not in by_p: continue
                for src, dst in [('sp_stuff', 'stuff_plus'), ('sp_location', 'location_plus'),
                                 ('sp_pitching', 'pitching_plus')]:
                    v = r.get(src)
                    if v is not None: by_p[pid][dst] = v
        except Exception as e:
            print(f'  FG-sp augment skipped: {e}')
    print(f'  FG augmented: {augmented_b} batters, {augmented_p} pitchers')


def main():
    print(f'Season {SEASON} · pulling Statcast {start}..{end}')
    t0 = time.time()
    sc = statcast(start_dt=str(start), end_dt=str(end))
    print(f'  {len(sc):,} pitches in {time.time()-t0:.0f}s')
    if len(sc) == 0:
        print('No pitches — leaving existing files intact.')
        (DATA / 'park_factors.json').write_text(json.dumps(PARK_FACTORS))
        return

    pa = to_pa_outcomes(sc)
    print(f'  {len(pa):,} labeled PAs')

    # ─── primary stats (Statcast-derived) ───
    meta = player_meta(sc)
    batters  = compute_batters_from_statcast(pa, meta)
    pitchers = compute_pitchers_from_statcast(pa, sc, meta)

    # Resolve names + canonical bats/throws via MLB Stats API
    all_ids = [b['id'] for b in batters] + [p['id'] for p in pitchers]
    people = mlb_people_lookup(all_ids)
    print(f'  resolved {len(people):,} player names via MLB Stats API')
    for b in batters:
        p = people.get(b['id']) or {}
        if p.get('fullName'): b['name'] = p['fullName']
        if p.get('bats'):     b['bats'] = p['bats']
    for p_row in pitchers:
        p = people.get(p_row['id']) or {}
        if p.get('fullName'): p_row['name'] = p['fullName']
        if p.get('throws'):   p_row['throws'] = p['throws']

    augment_from_fg(batters, pitchers)
    league   = compute_league(batters, pitchers)

    # ─── matchup-context features ───
    bat_splits  = compute_splits(pa, 'batter', 'p_throws')
    pit_splits  = compute_splits(pa, 'pitcher', 'stand')
    bat_whiff   = compute_whiff(sc)
    pit_arsenal = compute_arsenal(sc)

    print(f'  batters={len(batters)} pitchers={len(pitchers)} '
          f'bat_splits={len(bat_splits)} pit_splits={len(pit_splits)} '
          f'bat_whiff={len(bat_whiff)} pit_arsenal={len(pit_arsenal)}')

    (DATA / 'batters.json').write_text(json.dumps(batters))
    (DATA / 'pitchers.json').write_text(json.dumps(pitchers))
    (DATA / 'league.json').write_text(json.dumps(league))
    (DATA / 'bat_splits.json').write_text(json.dumps(bat_splits))
    (DATA / 'pit_splits.json').write_text(json.dumps(pit_splits))
    (DATA / 'bat_whiff.json').write_text(json.dumps(bat_whiff))
    (DATA / 'pit_arsenal.json').write_text(json.dumps(pit_arsenal))
    (DATA / 'park_factors.json').write_text(json.dumps(PARK_FACTORS))

    sizes = {f.name: f.stat().st_size for f in DATA.glob('*.json')}
    print('Wrote:')
    for n, s in sorted(sizes.items()):
        print(f'  {n:<25} {s/1024:>6.0f} KB')
    print(f'Total feature-builder time: {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
