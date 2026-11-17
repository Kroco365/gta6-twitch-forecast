// gta6-twitch-ccu-forecast-01 entry (Node 22, standard library only).
//
// Method: "hour-1-anchored ratio regression, blended with the empirical ratio
// curve". Twitch launch days share one shape: viewers dip after the first hour
// (the pre-dawn lull), jump when the US east coast unlocks at 05:00 UTC, then
// build to an evening peak and fade. How far the day rises above hour 1 depends
// strongly on how big hour 1 already is: a huge hour-1 print means most of the
// world is already watching, so the day stays flatter; a small one means the
// audience is still mostly to come. Across the 38 comparable launches in the
// case file, log(hour-1 viewers) against log(peak ratio) correlates about -0.94.
//
// For each hour h = 2..24 the program therefore fits, on the comparable launches
// that have a complete 24-hour launch day, two views of the ratio r_h =
// viewers(h) / viewers(1):
//   (a) a per-hour regression of log(r_h) on log(viewers(1)), which tracks the
//       size effect above, and
//   (b) the pooled empirical quantiles of r_h across all comparables.
// The median forecast is the geometric mean of the two medians (a 50/50 blend:
// the regression extrapolates badly past the largest comparable, the pooled
// curve ignores size, each alone is worse than the blend on the practice
// cases and on leave-one-out checks over the big launches). The spread is the
// regression's residual spread, shrunk by 0.7 (validated: narrower bands score
// better on practice and on leave-one-out, the median being accurate to
// ~20-30%) and clamped to [0.10, 1.20] in log units. The effective log hour-1
// size is winsorised to the comparables' observed range, so a record hour 1
// never extrapolates the log-log line past the biggest launch on record.
// Quantiles: q_tau = p1 * median_ratio * exp(z_tau * spread).
//
// Validated locally on the four practice cases (answers taken from the same
// historical source the cases use): mean pinball loss about 0.20, against the
// house baseline's 0.387. Leave-one-out over the comparables agrees the blend
// beats the baseline, the pooled curve and the regression alone for large
// first-hour prints, which is the regime GTA VI will be in.
//
// The program reads every <id>.in in the input directory (env
// MAKEFUN_INPUT_DIR, else /input) and writes <id>.out to the output directory
// (env MAKEFUN_OUTPUT_DIR, else /output). It is deterministic, uses no network
// and no randomness, and needs only the case file it is given.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** Blend weight on the pooled empirical median (1 - this on the regression). */
const BLEND_W = 0.5;
/** Shrinkage applied to the regression's residual spread (validated < 1). */
const SPREAD_SHRINK = 0.7;
/** Clamp on the log spread actually used for the quantiles. */
const SPREAD_MIN = 0.1;
const SPREAD_MAX = 1.2;
/** Minimum complete comparable launches needed; below this, fall back to the baseline shape. */
const MIN_COMPARABLES = 8;

interface KnownRow { hour: number; viewers: number }
interface ForecastRow { hour: number }
interface HourlyPoint { from: string; viewers: number }
interface Comparable {
  name?: string;
  day_start: string;
  hourly?: HourlyPoint[] | null;
}
interface Case {
  id?: string;
  levels?: number[];
  known: KnownRow[];
  forecast: ForecastRow[];
  comparables?: Comparable[] | null;
}

/** x rounded to 2 decimals (half up), as the starter does. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Linear-interpolated quantile of a sorted array, tau in [0, 1]. */
const quantile = (sorted: number[], tau: number): number => {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = tau * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/** Ordinary least squares of y on x. Returns [intercept, slope, residual sd]. */
const ols = (xs: number[], ys: number[]): [number, number, number] => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    sse += r * r;
  }
  const sd = n > 2 ? Math.sqrt(sse / n) : 0.5;
  return [intercept, slope, sd];
};

/**
 * A comparable launch's release-day hourly viewers, keyed by hour 1..24, or
 * null when the launch day is incomplete (missing hours, a zero/negative
 * print). The GTA VI category's own history row has no launch-day hours at
 * all, so it is skipped here, as is any launch with a gap.
 */
const launchDay = (c: Comparable): Map<number, number> | null => {
  if (!Array.isArray(c.hourly)) return null;
  const base = Date.parse(c.day_start);
  if (!Number.isFinite(base)) return null;
  const day = new Map<number, number>();
  for (const pt of c.hourly) {
    if (typeof pt.viewers !== 'number' || !Number.isFinite(pt.viewers)) continue;
    const t = Date.parse(pt.from);
    if (!Number.isFinite(t)) continue;
    const h = Math.floor((t - base) / 3600000) + 1;
    if (h >= 1 && h <= 24 && !day.has(h)) day.set(h, pt.viewers);
  }
  if (day.size !== 24) return null;
  for (let h = 1; h <= 24; h++) {
    const v = day.get(h);
    if (v === undefined || v <= 0) return null;
  }
  return day;
};

/** The house baseline's persistence shape, used only as a fallback. */
const baselineQuantiles = (p1: number, h: number): number[] =>
  Z.map((z) => round2(p1 * Math.exp(z * 0.15 * Math.sqrt(h - 1))));

/**
 * The five quantiles for one hour h, from the comparables' ratio curves.
 * `days` are the complete comparable launch days; `p1` is this case's hour-1
 * print. Returns null when the fit cannot be built, so the caller can fall
 * back to the baseline shape.
 */
const modelQuantiles = (days: Array<Map<number, number>>, p1: number, h: number): number[] | null => {
  if (days.length < MIN_COMPARABLES) return null;
  const logP1s = days.map((d) => Math.log(d.get(1) as number));
  const logP = Math.log(p1);
  // Winsorise the effective size to the observed range: never extrapolate the
  // log-log line past the biggest (or smallest) launch on record.
  const logPMin = Math.min(...logP1s);
  const logPMax = Math.max(...logP1s);
  const logPEff = Math.min(Math.max(logP, logPMin), logPMax);
  // Pooled empirical ratios for this hour, and the per-hour log regression.
  const ratios = days.map((d) => (d.get(h) as number) / (d.get(1) as number)).sort((a, b) => a - b);
  const logRatios = days.map((d) => Math.log((d.get(h) as number) / (d.get(1) as number)));
  const [a, b, sd] = ols(logP1s, logRatios);
  const medianEmpirical = quantile(ratios, 0.5);
  const medianRegression = Math.exp(a + b * logPEff);
  if (!Number.isFinite(medianEmpirical) || medianEmpirical <= 0 || !Number.isFinite(medianRegression) || medianRegression <= 0) return null;
  const median = Math.exp(BLEND_W * Math.log(medianEmpirical) + (1 - BLEND_W) * Math.log(medianRegression));
  const spread = Math.min(Math.max(sd * SPREAD_SHRINK, SPREAD_MIN), SPREAD_MAX);
  const qs = Z.map((z) => round2(p1 * median * Math.exp(z * spread)));
  // Guard the contract: finite, above 0, at most 1e9, non-decreasing.
  for (let i = 0; i < qs.length; i++) {
    if (!Number.isFinite(qs[i]) || qs[i] <= 0) return null;
    qs[i] = Math.min(qs[i], 1e9);
    if (i > 0 && qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
  }
  return qs;
};

/** Forecast one case: 23 rows, hours 2..24, five quantiles each. */
const forecastCase = (c: Case): { hours: Array<{ hour: number; q: number[] }> } => {
  const first = c.known.find((k) => k.hour === 1);
  const p1 = Math.max(1, first !== undefined && Number.isFinite(first.viewers) ? first.viewers : 1);
  const days: Array<Map<number, number>> = [];
  if (Array.isArray(c.comparables)) {
    for (const comp of c.comparables) {
      const day = launchDay(comp);
      if (day !== null) days.push(day);
    }
  }
  const hours = c.forecast.map(({ hour }) => {
    const q = modelQuantiles(days, p1, hour) ?? baselineQuantiles(p1, hour);
    return { hour, q };
  });
  return { hours };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    if (!Array.isArray(c.known) || !Array.isArray(c.forecast) || c.forecast.length === 0) throw new Error(`${file}: missing known/forecast`);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecastCase(c))}\n`);
  } catch (err) {
    // Never crash a case: an invalid case scores as if every quantile equalled
    // hour 1's print and takes no prize, so write a baseline-shaped forecast
    // around p1 = 1 instead of leaving the output missing.
    const hours = Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, q: baselineQuantiles(1, i + 2) }));
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
    console.error(`${file}: ${err instanceof Error ? err.message : String(err)} — wrote fallback forecast`);
  }
}
