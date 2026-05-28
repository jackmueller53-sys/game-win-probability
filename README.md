# Game Win-Probability

Pulls today's MLB schedule, probable starters, and (when posted) starting
lineups. For each game, runs a 2,000-iteration Monte Carlo PA-by-PA
simulation using the matchup model from `pitcher-batter-matchup`. Outputs
mean expected runs per team and pre-game W%.

## How the simulation works

For each side of each game we build a 9-batter lineup. We then build
`MatchupModel.matchup(pitcher, batter, league)` for every batter against
the *opposing* starter, which gives a per-PA probability distribution
over **{K, BB, HBP, HR, 3B, 2B, 1B, OutInPlay}**.

For each simulated half-inning we iterate the lineup, sample an event
per PA, and update a 24-state base-out chain. Runs cross the plate as
runners advance. Half-inning ends at 3 outs.

After `starterInnings` (default 6), batters face a league-average
pitcher proxy instead of the starter — a rough bullpen model. Full
nine innings per side; ties resolved with up to 5 extra innings.

2,000 iterations per game gives a W% standard error of about ±1.1%,
which is more than precise enough for our purposes given the model's
own modeling error.

## Data

- **FanGraphs** (same pulls as the matchup repo) — batter and pitcher
  season-to-date stats + Stuff+/Location+/Pitching+.
- **MLB Stats API** — `/api/v1/schedule?hydrate=probablePitcher,lineups,team`
  returns the day's games, probable starters, and lineups when posted
  (usually ~2 hours before first pitch).

All four data files (`pitchers.json`, `batters.json`, `league.json`,
`today.json`) are refreshed twice daily by `.github/workflows/fetch-data.yml`
(8 AM UTC overnight stats; 2 PM UTC catches posted lineups for evening
games).

## v1 limitations

- No bullpen-specific modeling (uses league-average proxy after starter exits).
- No park factors, weather, or umpire effects.
- No injury / lineup-shuffle awareness beyond what the MLB API publishes.
- Treats every PA as independent — no count state, no fatigue.

## Run locally

```bash
node scripts/fetch-data.js          # current day
DATE=2026-06-15 node scripts/fetch-data.js   # specific date
npx serve .
```

## Deploy

`.github/workflows/deploy.yml` ships `_site/` to GitHub Pages with an
esbuild minify pass.

> Note: GitHub Pages on a private repo requires **GitHub Pro**. On a
> free plan, deploy to Cloudflare Pages or Vercel instead — both will
> serve a static `_site/` directory in one command.
