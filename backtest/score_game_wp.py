"""
Game-level win-probability backtest.

For each 2025 regular-season game, build pre-game features from 2024-final
stats (no lookahead), simulate the game using the same matchup model the
production simulator uses, then compare predicted W% to actual outcome.

Metrics:
  - Brier score        Σ (pred − actual)² / N
  - Calibration table  10 buckets of predicted W%, observed actual W%
  - Log loss           Σ −[y log(p) + (1−y) log(1−p)] / N
  - Compared to two baselines:
      1) "Home team always 54%" (the historical HFA constant)
      2) "Naive 50/50"

Usage:  python3 score_game_wp.py [--n 500]
"""
import os
import sys
import json
import math
import argparse
import random
from pathlib import Path
from collections import defaultdict

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
CACHE = HERE / 'cache'
CACHE.mkdir(exist_ok=True)


# ─────────────────────── Statcast → PA outcome utility ───────────────────────
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
        if e in ('field_out','grounded_into_double_play','force_out','fielders_choice',
                 'fielders_choice_out','sac_fly','sac_bunt','sac_fly_double_play',
                 'double_play','triple_play','sac_bunt_double_play','field_error'):
            return 'out_in_play'
        return None
    last['outcome'] = last['events'].map(label)
    return last[last['outcome'].notna()].copy()


# ─────────────────────── Feature snapshot ───────────────────────
# Use 2024-final Statcast-derived stats as "frozen features" for predicting
# 2025 game outcomes. Mirrors what production does from current-season data.

LIN = {'BB': 0.690, 'HBP': 0.720, 'single': 0.890,
       'double': 1.271, 'triple': 1.616, 'HR': 2.101}

def derive_player_stats(pa):
    """Returns {bat_by_id, pit_by_id, league}, mirroring build_features.py."""
    bat_by_id, pit_by_id = {}, {}

    # Batter rates
    for bid, g in pa.groupby('batter'):
        n = len(g)
        if n < 25: continue
        c = {e: int((g['outcome'] == e).sum()) for e in
             ['K','BB','HBP','HR','triple','double','single','out_in_play']}
        ab = n - c['BB'] - c['HBP']
        h  = c['single'] + c['double'] + c['triple'] + c['HR']
        babip = (h - c['HR']) / (ab - c['K'] - c['HR']) if (ab - c['K'] - c['HR']) > 0 else None
        woba_num = sum(LIN[e] * c[e] for e in LIN)
        woba = woba_num / n if n > 0 else None
        bats = g['stand'].dropna().mode().iloc[0] if not g['stand'].dropna().empty else None
        bat_by_id[int(bid)] = {
            'id': int(bid), 'bats': bats, 'pa': n, 'ab': ab,
            'hr': c['HR'], 'k_pct': c['K']/n, 'bb_pct': c['BB']/n,
            'babip': babip, 'woba': woba, 'wrc_plus': None,
            'iso': None, 'avg': h/ab if ab > 0 else None,
        }

    # Pitcher rates + GS/G
    g_appears = pa.drop_duplicates(['game_pk','pitcher'])[['game_pk','pitcher']]
    g_counts = g_appears.groupby('pitcher').size().to_dict()
    gs_set = pa[pa['inning'] == 1][['game_pk','pitcher']].drop_duplicates()
    gs_counts = gs_set.groupby('pitcher').size().to_dict()

    for pid, g in pa.groupby('pitcher'):
        n = len(g)
        if n < 25: continue
        c = {e: int((g['outcome'] == e).sum()) for e in
             ['K','BB','HBP','HR','triple','double','single','out_in_play']}
        outs = c['K'] + c['out_in_play']
        ip = outs / 3.0
        ab = n - c['BB'] - c['HBP']
        h  = c['single'] + c['double'] + c['triple'] + c['HR']
        babip = (h - c['HR']) / (ab - c['K'] - c['HR']) if (ab - c['K'] - c['HR']) > 0 else None
        throws = g['p_throws'].dropna().mode().iloc[0] if not g['p_throws'].dropna().empty else None
        pit_by_id[int(pid)] = {
            'id': int(pid), 'throws': throws, 'ip': ip,
            'gs': int(gs_counts.get(pid, 0)),
            'g': int(g_counts.get(pid, 0)),
            'k_pct': c['K']/n, 'bb_pct': c['BB']/n,
            'hr_per_pa': c['HR']/n, 'hr_per_9': (c['HR']/outs*27) if outs else None,
            'babip': babip,
            'stuff_plus': None, 'location_plus': None,
        }

    # League
    rows_b = list(bat_by_id.values())
    rows_p = list(pit_by_id.values())
    def wmean(rows, k, wkey):
        n, d = 0, 0
        for r in rows:
            v, wt = r.get(k), r.get(wkey) or 1
            if v is not None and isinstance(v,(int,float)) and v == v:
                n += v*wt; d += wt
        return n/d if d > 0 else None
    league = {
        'bat': {
            'k_pct': wmean(rows_b, 'k_pct','pa'),
            'bb_pct': wmean(rows_b, 'bb_pct','pa'),
            'woba': wmean(rows_b, 'woba','pa'),
            'babip': wmean(rows_b, 'babip','ab'),
            'hr_per_pa': sum(r['hr'] for r in rows_b) / max(1, sum(r['pa'] for r in rows_b)),
        },
        'pit': {
            'k_pct': wmean(rows_p, 'k_pct','ip'),
            'bb_pct': wmean(rows_p, 'bb_pct','ip'),
            'babip': wmean(rows_p, 'babip','ip'),
            'hr_per_pa': wmean(rows_p, 'hr_per_pa','ip'),
        },
    }
    return {'bat': bat_by_id, 'pit': pit_by_id, 'league': league}


# ─────────────────────── Mini Monte Carlo simulator ───────────────────────
# Pure-Python equivalent of js/simulator.js. Per-PA outcome sampling +
# base-out state machine + per-team bullpen for innings 7-9.
sys.path.insert(0, str(HERE.parent / 'backtest'))
try:
    from model_v5 import matchup as _matchup_v5  # may not exist in winprob
except Exception:
    # Copy model from matchup repo's backtest dir if available
    matchup_backtest = Path('/tmp/matchup/backtest')
    if matchup_backtest.exists():
        sys.path.insert(0, str(matchup_backtest))
        from model_v5 import matchup as _matchup_v5
    else:
        raise RuntimeError('model_v5.py not found — run from matchup/backtest first')

EVENTS = ['K','BB','HBP','HR','triple','double','single','out_in_play']

def build_cdf(p):
    cum = 0; cdf = []
    for e in EVENTS:
        v = p.get(e) or 0
        cum += v; cdf.append(cum)
    if cum > 0 and abs(cum - 1) > 1e-6:
        cdf = [x/cum for x in cdf]
    return cdf

def sample_event(cdf, rng):
    r = rng()
    for i, c in enumerate(cdf):
        if r <= c: return EVENTS[i]
    return EVENTS[-1]

def apply_event(ev, bases, outs):
    b1, b2, b3 = bases; r = 0
    if ev in ('K','out_in_play'):
        return [b1,b2,b3], outs+1, 0
    if ev in ('BB','HBP'):
        if b1 and b2 and b3: r = 1
        elif b1 and b2: b3 = True
        elif b1: b2 = True; b1 = True
        else: b1 = True
        return [b1,b2,b3], outs, r
    if ev == 'single':
        if b3: r += 1
        if b2: r += 1
        b3 = b1; b2 = False; b1 = True
        return [b1,b2,b3], outs, r
    if ev == 'double':
        if b3: r += 1
        if b2: r += 1
        if b1: r += 1
        b3 = False; b2 = True; b1 = False
        return [b1,b2,b3], outs, r
    if ev == 'triple':
        if b3: r += 1
        if b2: r += 1
        if b1: r += 1
        b1 = False; b2 = False; b3 = True
        return [b1,b2,b3], outs, r
    if ev == 'HR':
        r = 1 + (1 if b1 else 0) + (1 if b2 else 0) + (1 if b3 else 0)
        return [False, False, False], outs, r
    return [b1,b2,b3], outs, 0


def sim_half(state, cdfs, rng):
    bases = [False, False, False]
    outs, runs = 0, 0
    while outs < 3:
        cdf = cdfs[state['idx']]
        ev = sample_event(cdf, rng)
        bases, outs, r = apply_event(ev, bases, outs)
        runs += r
        state['idx'] = (state['idx'] + 1) % len(cdfs)
        if runs > 25: break  # safety
    return runs


def simulate_game(home_lineup_cdfs_starter, home_lineup_cdfs_bullpen,
                  away_lineup_cdfs_starter, away_lineup_cdfs_bullpen,
                  sims=2000, starter_innings=6, rng=None):
    rng = rng or random.random
    h_wins = 0
    h_runs_total, a_runs_total = 0, 0
    for _ in range(sims):
        hR, aR = 0, 0
        h_state, a_state = {'idx': 0}, {'idx': 0}
        for inn in range(9):
            a_cdfs = away_lineup_cdfs_starter if inn < starter_innings else away_lineup_cdfs_bullpen
            h_cdfs = home_lineup_cdfs_starter if inn < starter_innings else home_lineup_cdfs_bullpen
            aR += sim_half(a_state, a_cdfs, rng)
            if inn == 8 and hR > aR: break
            hR += sim_half(h_state, h_cdfs, rng)
        if hR == aR:
            # one extra inning
            aR += sim_half(a_state, away_lineup_cdfs_bullpen, rng)
            hR += sim_half(h_state, home_lineup_cdfs_bullpen, rng)
            if hR == aR:
                hR += (1 if rng() < 0.5 else 0)  # break deterministic ties
        if hR > aR: h_wins += 1
        h_runs_total += hR; a_runs_total += aR
    return h_wins / sims, h_runs_total / sims, a_runs_total / sims


# ─────────────────────── Bullpen composite ───────────────────────
def bullpen_composite(team, pitchers_by_id, games_by_pitcher):
    """IP-weighted composite over relievers on this team."""
    relievers = []
    for pid, p in pitchers_by_id.items():
        if p.get('g',0) == 0 or (p.get('gs',0)/p['g']) >= 0.5: continue
        if p.get('ip',0) < 5: continue
        if games_by_pitcher.get(pid) != team: continue
        relievers.append(p)
    if not relievers:
        return None
    def w(k):
        n, d = 0, 0
        for r in relievers:
            v, wt = r.get(k), r.get('ip') or 1
            if v is not None and isinstance(v,(int,float)) and v == v:
                n += v*wt; d += wt
        return n/d if d > 0 else None
    return {
        'throws': 'R', 'ip': sum(r['ip'] for r in relievers),
        'gs': 0, 'g': len(relievers),
        'k_pct': w('k_pct'), 'bb_pct': w('bb_pct'),
        'babip': w('babip'), 'hr_per_pa': w('hr_per_pa'),
        'stuff_plus': 100, 'location_plus': 100,
    }


# ─────────────────────── Main backtest ───────────────────────
def main(sample_n=None, sims_per_game=1000):
    # Load 2024 frozen features + 2025 PA outcomes from matchup/backtest cache
    cache24 = Path('/tmp/matchup/backtest/cache/statcast_2024.parquet')
    cache25 = Path('/tmp/matchup/backtest/cache/statcast_2025.parquet')
    pa25cache = Path('/tmp/matchup/backtest/cache/pa_2025.parquet')

    if not pa25cache.exists() or not cache24.exists():
        print('Need cached Statcast data at /tmp/matchup/backtest/cache/')
        print('Run: cd /tmp/matchup/backtest && python3 build_features.py first')
        sys.exit(1)

    print('Loading 2024 features + 2025 game outcomes...')
    sc24 = pd.read_parquet(cache24)
    # Need full 2025 Statcast (with score columns) to derive game outcomes,
    # not the trimmed PA file. The PA file is only used by our trimmed model.
    sc25 = pd.read_parquet(cache25)
    print(f'  2024 pitches={len(sc24):,}  2025 pitches={len(sc25):,}')

    # Build 2024 frozen features (this is what we "know" before each 2025 game)
    pa24 = to_pa_outcomes(sc24)
    feats = derive_player_stats(pa24)
    print(f'  2024 frozen: batters={len(feats["bat"])} pitchers={len(feats["pit"])}')

    # Map pitcher -> team for 2024 (so we can build bullpen composites by team)
    pit_team = {}
    for _, r in sc24[['pitcher','home_team','away_team','inning_topbot']].dropna(
            subset=['pitcher','inning_topbot']).iterrows():
        pid = int(r['pitcher'])
        if pid in pit_team: continue
        pit_team[pid] = r['home_team'] if r['inning_topbot'] == 'Top' else r['away_team']

    # Determine 2025 game outcomes from the full Statcast frame.
    # The cleanest approach: per game, the FINAL post_home_score / post_away_score
    # is the final score. We don't need PA-level run aggregation.
    print('  computing 2025 game outcomes + starters...')
    pa25 = to_pa_outcomes(sc25)
    # Final scores per game from the last pitch of the game
    sc25_sorted = sc25.sort_values(['game_pk', 'at_bat_number', 'pitch_number'])
    final_rows = sc25_sorted.groupby('game_pk', as_index=False).tail(1)
    final_scores = {}
    if 'post_home_score' in final_rows.columns and 'post_away_score' in final_rows.columns:
        for _, r in final_rows.iterrows():
            try:
                final_scores[int(r['game_pk'])] = (
                    float(r['post_home_score']), float(r['post_away_score'])
                )
            except (ValueError, TypeError):
                pass
    print(f'  final-score games: {len(final_scores):,}')

    games = []
    by_game = pa25.groupby('game_pk')
    for game_pk, g in by_game:
        # team labels
        home_team = g['home_team'].iloc[0]
        away_team = g['away_team'].iloc[0]
        # Identify starting pitcher = first pitcher to face a batter in inning 1
        # of each side. Home starter pitches against away batters (top of 1st).
        inn1 = g[g['inning'] == 1]
        try:
            home_sp = int(inn1[inn1['inning_topbot'] == 'Top'].sort_values('at_bat_number').iloc[0]['pitcher'])
            away_sp = int(inn1[inn1['inning_topbot'] == 'Bot'].sort_values('at_bat_number').iloc[0]['pitcher'])
        except IndexError:
            continue
        # Lineup: first 9 unique batters per side (in PA order)
        home_lineup_ids = list(dict.fromkeys(
            g[g['inning_topbot'] == 'Bot'].sort_values(['inning','at_bat_number'])['batter'].astype(int)
        ))[:9]
        away_lineup_ids = list(dict.fromkeys(
            g[g['inning_topbot'] == 'Top'].sort_values(['inning','at_bat_number'])['batter'].astype(int)
        ))[:9]
        # Outcome: home runs vs away runs
        def runs_for(side_top):
            sg = g[g['inning_topbot'] == side_top]
            # Approximate runs by counting events using same linear values as wOBA?
            # Actual: just sum HR's runs + count any other runs. For simplicity use
            # post.score columns if present.
            return None
        # Final scores via last-pitch post_home/away_score
        scores = final_scores.get(int(game_pk))
        if not scores: continue
        home_runs, away_runs = scores
        if home_runs == away_runs: continue
        games.append({
            'game_pk': int(game_pk),
            'home_team': home_team, 'away_team': away_team,
            'home_sp': home_sp, 'away_sp': away_sp,
            'home_lineup_ids': home_lineup_ids,
            'away_lineup_ids': away_lineup_ids,
            'home_runs': home_runs, 'away_runs': away_runs,
            'home_won': home_runs > away_runs,
        })

    print(f'  decided games: {len(games):,}')
    if sample_n and sample_n < len(games):
        random.seed(42)
        games = random.sample(games, sample_n)
        print(f'  sampled {sample_n}')

    # Bullpen composites by team
    bullpens = {}
    teams = set(g['home_team'] for g in games) | set(g['away_team'] for g in games)
    for t in teams:
        bullpens[t] = bullpen_composite(t, feats['pit'], pit_team)

    # Simulate each game
    print(f'\nSimulating {len(games)} games at {sims_per_game} sims each...')
    PARK_FACTORS = {}  # park factors not critical for ranking; using flat
    preds = []
    actuals = []
    skipped = 0
    league = feats['league']

    for gi, g in enumerate(games):
        # Resolve pitchers
        home_sp = feats['pit'].get(g['home_sp'])
        away_sp = feats['pit'].get(g['away_sp'])
        if not home_sp or not away_sp:
            skipped += 1; continue
        # Lineups — fall back to top-9-by-PA if missing
        home_lineup = [feats['bat'].get(bid) for bid in g['home_lineup_ids']]
        away_lineup = [feats['bat'].get(bid) for bid in g['away_lineup_ids']]
        home_lineup = [b for b in home_lineup if b]
        away_lineup = [b for b in away_lineup if b]
        if len(home_lineup) < 7 or len(away_lineup) < 7:
            skipped += 1; continue
        # Pad if 7-8
        while len(home_lineup) < 9: home_lineup.append(home_lineup[-1])
        while len(away_lineup) < 9: away_lineup.append(away_lineup[-1])

        # Bullpens (fall back to league avg)
        home_bull = bullpens.get(g['home_team']) or {
            'throws':'R','ip':10,'gs':0,'g':1,
            'k_pct': league['pit']['k_pct'], 'bb_pct': league['pit']['bb_pct'],
            'babip': league['pit']['babip'], 'hr_per_pa': league['pit']['hr_per_pa'],
            'stuff_plus':100,'location_plus':100,
        }
        away_bull = bullpens.get(g['away_team']) or home_bull

        # Build CDFs
        def cdfs_for(lineup, pitcher):
            out = []
            for b in lineup:
                m = _matchup_v5(pitcher, b, league, ctx=None)
                if not m: return None
                out.append(build_cdf(m['p']))
            return out

        h_starter_cdfs = cdfs_for(home_lineup, away_sp)
        a_starter_cdfs = cdfs_for(away_lineup, home_sp)
        h_bull_cdfs    = cdfs_for(home_lineup, away_bull)
        a_bull_cdfs    = cdfs_for(away_lineup, home_bull)
        if not all([h_starter_cdfs, a_starter_cdfs, h_bull_cdfs, a_bull_cdfs]):
            skipped += 1; continue

        # Simulate
        rng = random.Random(g['game_pk'] + 17).random
        wp_h_raw, mh, ma = simulate_game(h_starter_cdfs, h_bull_cdfs,
                                         a_starter_cdfs, a_bull_cdfs,
                                         sims=sims_per_game, rng=rng)
        # Apply HFA blend matching js/simulator.js (hfaBlend=0.20, prior=0.540)
        HFA_BLEND, HFA_PRIOR = 0.20, 0.540
        wp_h = (1 - HFA_BLEND) * wp_h_raw + HFA_BLEND * HFA_PRIOR
        preds.append(wp_h)
        actuals.append(1.0 if g['home_won'] else 0.0)

        if (gi + 1) % 100 == 0:
            print(f'  {gi+1}/{len(games)} done')

    print(f'\nScored {len(preds)} games  (skipped {skipped}).')

    # ── Metrics ──
    preds = np.array(preds)
    y     = np.array(actuals)
    eps   = 1e-9
    brier_model    = float(np.mean((preds - y)**2))
    logloss_model  = float(-np.mean(y*np.log(np.clip(preds,eps,1-eps)) + (1-y)*np.log(np.clip(1-preds,eps,1-eps))))
    brier_naive    = float(np.mean((0.5 - y)**2))
    brier_hfa      = float(np.mean((0.54 - y)**2))
    base_home_rate = float(y.mean())

    print('\n=== Game-level WP metrics (2024 features → 2025 outcomes) ===')
    print(f'  Games scored: {len(preds):,}')
    print(f'  Actual home win rate: {base_home_rate:.1%}')
    print(f'  Mean predicted home W%: {preds.mean():.1%}')
    print(f'')
    print(f'  Brier score (model):    {brier_model:.4f}   ← lower is better')
    print(f'  Brier score (54% HFA):  {brier_hfa:.4f}')
    print(f'  Brier score (50/50):    {brier_naive:.4f}')
    print(f'')
    print(f'  Log loss (model):       {logloss_model:.4f}')

    # Calibration buckets
    print(f'\n  Calibration (10 buckets of predicted W%):')
    print(f'  {"bucket":<14}{"n":>6}{"avg pred":>11}{"actual":>10}{"diff":>10}')
    order = np.argsort(preds)
    n = len(preds)
    for i in range(10):
        a = i * n // 10
        b = (i + 1) * n // 10
        idx = order[a:b]
        if len(idx) == 0: continue
        ap = preds[idx].mean()
        ac = y[idx].mean()
        lo, hi = preds[idx].min(), preds[idx].max()
        bucket = f'{lo:.2f}-{hi:.2f}'
        print(f'  {bucket:<14}{len(idx):>6}{ap:>10.1%}{ac:>10.1%}{ac-ap:>+10.1%}')

    # Write report
    report = HERE / 'wp_report.md'
    with open(report, 'w') as f:
        f.write(f'# Game-level WP backtest\n\n')
        f.write(f'- {len(preds):,} 2025 games scored, 2024 frozen features\n')
        f.write(f'- Actual home win rate: **{base_home_rate:.1%}**\n')
        f.write(f'- Mean predicted: {preds.mean():.1%}\n\n')
        f.write(f'## Headline\n\n')
        f.write(f'| metric | value | naive | HFA |\n|---|---:|---:|---:|\n')
        f.write(f'| Brier score | **{brier_model:.4f}** | {brier_naive:.4f} | {brier_hfa:.4f} |\n')
        f.write(f'| Log loss   | **{logloss_model:.4f}** | 0.6931 | — |\n\n')
        f.write(f'## Calibration (10 prediction buckets)\n\n')
        f.write(f'| bucket | n | avg pred | actual | diff |\n|---|---:|---:|---:|---:|\n')
        for i in range(10):
            a = i * n // 10
            b = (i + 1) * n // 10
            idx = order[a:b]
            if len(idx) == 0: continue
            ap = preds[idx].mean()
            ac = y[idx].mean()
            lo, hi = preds[idx].min(), preds[idx].max()
            f.write(f'| {lo:.2f}–{hi:.2f} | {len(idx)} | {ap:.1%} | {ac:.1%} | {ac-ap:+.1%} |\n')
    print(f'\nWrote {report.relative_to(HERE.parent)}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=None,
                    help='Sample N games for a faster run')
    ap.add_argument('--sims', type=int, default=1000,
                    help='Sims per game (default 1000)')
    args = ap.parse_args()
    main(sample_n=args.n, sims_per_game=args.sims)
