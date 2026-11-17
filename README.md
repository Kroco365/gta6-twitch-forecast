# GTA VI Twitch launch-day forecaster

[![make.fun bounty](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![make.fun rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Kroco365/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![make.fun reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Kroco365/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

Entry for the [make.fun bounty gta6-twitch-ccu-forecast-01](https://make.fun/bounty/gta6-twitch-ccu-forecast-01): forecast how many people watch Grand Theft Auto VI live on Twitch in each hour of its release day (19 Nov 2026 UTC), after the first hour, as five quantiles per hour (0.05, 0.25, 0.5, 0.75, 0.95).

## Method

`main.ts` (Node 22, standard library only) implements an **hour-1-anchored ratio regression, blended with the empirical ratio curve**:

- Twitch launch days share one shape: viewers dip after hour 1, jump when the US east coast unlocks at 05:00 UTC, then build to an evening peak and fade. How far the day rises above hour 1 depends strongly on how big hour 1 already is — across the comparable launches in the case file, log(hour-1 viewers) vs log(peak ratio) correlates about −0.94.
- For each hour h = 2..24 the program fits, on the comparable launches with a complete 24-hour launch day, (a) a per-hour regression of log(viewers(h)/viewers(1)) on log(viewers(1)) and (b) the pooled empirical quantiles of that ratio. The median forecast is the geometric mean of the two medians; the spread is the regression's residual spread, shrunk by 0.7 and clamped to [0.10, 1.20] log units. The effective log hour-1 size is winsorised to the comparables' observed range, so a record hour 1 never extrapolates the log-log line past the biggest launch on record.
- The program reads every `<id>.in` in the input directory (`$MAKEFUN_INPUT_DIR`, else `/input`) and writes `<id>.out` to the output directory (`$MAKEFUN_OUTPUT_DIR`, else `/output`). Deterministic, no network, no randomness; a malformed case falls back to the house baseline's shape instead of crashing.

## Local results (practice cases)

Scored against the practice answers (same historical source the cases use):

| case | this entry | house baseline |
| --- | --- | --- |
| p00 Wolverine | 0.2466 | 0.7436 |
| p01 Red Dead Redemption 2 | 0.1901 | 0.2868 |
| p02 God of War Ragnarök | 0.1515 | 0.2146 |
| p03 Marvel's Spider-Man 2 | 0.1953 | 0.3033 |
| **mean pinball loss** | **0.1959** | **0.3871** |

Run locally with:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
