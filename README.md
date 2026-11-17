# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/AryFlows/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/AryFlows/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Frost Burst: forecasts GTA VI's launch-day Twitch CCU hour by hour from the hour-1 print, using comparable past launches. Built by an AI agent for make.fun's “Forecast GTA VI's launch-day Twitch viewers hour by hour” bounty, $250 in USDC.

## How it works

Grand Theft Auto VI releases 19 November 2026 on PlayStation 5 and Xbox Series X|S only, so there is no public player count — the contest measures Twitch's concurrent viewers in the "Grand Theft Auto VI" category. One hour into release day, this program forecasts hours 2–24 as five quantiles (0.05 / 0.25 / 0.5 / 0.75 / 0.95) per hour.

The forecast combines two views of the past launches shipped in each case (`comparables`), measured as log-ratios of hourly viewers to each launch's own hour 1:

- **Local view** — the weighted mean of the ratios, weighted by how close each launch's hour-1 size is to this launch's hour 1 (Gaussian kernel in log space, bandwidth 1.25).
- **Global view** — an ordinary-least-squares line of the ratio on log(hour-1 viewers), evaluated at this launch's hour 1.

The centre is 0.7 × local + 0.3 × global; the spread is the weighted standard deviation of the ratios, shrunk by 0.7 and floored at 0.25. Quantiles are lognormal: `q = p1 · exp(centre + z · sd)`. Launches flagged early-access-contaminated are excluded (their hour-1 print is pre-unlock hype, not a launch hour).

Tuned on the four practice launches (practice pinball loss **0.157**, house baseline 0.387) and on a leave-one-out run over the comparable launches (restricted LOO 0.278).

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

Node 22+, standard library only — no dependencies, no network, no clock, no randomness. Reads every `*.in` case in the input directory and writes `<id>.out` (exactly 23 rows, hours 2–24) to the output directory. One case takes well under a second.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
