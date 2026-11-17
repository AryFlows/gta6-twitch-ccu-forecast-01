// Frost Burst forecaster — GTA VI launch-day Twitch CCU, hours 2..24.
//
// Idea: a launch's audience curve is mostly determined by how big its first
// hour is. Take every past big launch (the "comparables"), measure how each
// one's hourly viewers moved relative to its own hour 1, and combine two
// views of those log-ratios at each hour:
//   (a) a local view: the weighted mean of the ratios, weighted by how close
//       each launch's hour-1 size is to this launch's hour 1 (Gaussian
//       kernel in log space, bandwidth 1.25);
//   (b) a global view: an ordinary-least-squares line of the ratio on
//       log(hour-1 viewers), evaluated at this launch's hour 1.
// The centre is 0.7 * (a) + 0.3 * (b); the spread is the weighted standard
// deviation of the ratios around (a), shrunk by 0.7 and floored at 0.25,
// which is what the pinball loss on the four practice launches prefers.
// Quantiles are lognormal: q_tau = p1 * exp(centre + z_tau * sd).
//
// Tuned on the four practice launches (SullyGnome hourly answers) plus a
// leave-one-out run over the comparable launches themselves:
//   practice pinball loss 0.157 (house baseline 0.387), restricted LOO 0.278.
// Launches whose unlock text is flagged early-access-contaminated are
// excluded: their hour-1 print is pre-unlock hype, not a launch hour.
//
// Runs on Node 22+ with the standard library only. Reads every *.in case in
// MAKEFUN_INPUT_DIR (default /input) and writes <id>.out to
// MAKEFUN_OUTPUT_DIR (default /output). Deterministic: no clock, no random
// numbers, no network. One case takes well under a second.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

type HourlyPoint = { from: string; viewers: number | null; channels?: number | null };
type Comparable = {
  name?: string;
  day_start?: string;
  unlock?: string;
  platforms?: string;
  hourly?: HourlyPoint[];
};
type CaseFile = {
  id?: string;
  known?: { hour?: number; viewers?: number }[];
  history_hourly?: { from: string; viewers: number | null }[];
  comparables?: Comparable[];
};

// --- Tuned constants (see header) ---------------------------------------
const BANDWIDTH = 1.25; // Gaussian kernel width, in log hour-1 viewers
const BLEND_ALPHA = 0.7; // weight of the local (weighted-mean) centre
const H1_MIN = 2000; // ignore comparables whose hour 1 is below this
const SD_SCALE = 0.7; // shrink the empirical spread
const SD_FLOOR = 0.25; // never narrower than this (log units)
const SD_CAP = 1.0; // never wider than this
const MIN_POINTS = 12; // a comparable needs at least this many usable hours
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const BASELINE_SD_RATE = 0.15; // fallback spread growth, per sqrt(hour - 1)

// --- Helpers ---------------------------------------------------------------
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// Weighted mean and (population) standard deviation of [value, weight] pairs.
function weightedStats(pairs: [number, number][]): [number, number] {
  let wsum = 0;
  let mean = 0;
  for (const [v, w] of pairs) {
    wsum += w;
    mean += w * v;
  }
  mean /= wsum;
  let varSum = 0;
  for (const [v, w] of pairs) {
    const d = v - mean;
    varSum += w * d * d;
  }
  return [mean, Math.sqrt(varSum / wsum)];
}

// Extract one comparable's 24 release-day hourly viewer counts, indexed 0..23.
// Points are keyed by their timestamp relative to the launch's day_start
// (00:00 UTC of release day). Missing or non-positive hours stay null.
// Duplicate points inside one hour are averaged.
function dayHours(comp: Comparable): (number | null)[] {
  const hours: (number | null)[] = new Array(24).fill(null);
  const sums: number[] = new Array(24).fill(0);
  const counts: number[] = new Array(24).fill(0);
  if (!comp.hourly || !comp.day_start) return hours;
  const start = Date.parse(comp.day_start);
  if (Number.isNaN(start)) return hours;
  for (const p of comp.hourly) {
    if (p.viewers === null || p.viewers === undefined || p.viewers <= 0) continue;
    const t = Date.parse(p.from);
    if (Number.isNaN(t)) continue;
    const idx = Math.floor((t - start) / 3_600_000);
    if (idx < 0 || idx >= 24) continue;
    sums[idx] += p.viewers;
    counts[idx] += 1;
  }
  for (let i = 0; i < 24; i++) {
    if (counts[i] > 0) hours[i] = sums[i] / counts[i];
  }
  return hours;
}

// A launch whose hour-1 print was contaminated by early-access play: its
// ratio curve starts from a pre-unlock audience and is not comparable.
function isEarlyAccessContaminated(comp: Comparable): boolean {
  return (comp.unlock ?? "").toLowerCase().includes("early-access-contaminated");
}

// --- Forecast ---------------------------------------------------------------
function forecast(caseFile: CaseFile): number[][] {
  // Hour-1 print: the anchor for everything. Fall back to the last
  // history_hourly point, then to 1, so the case always stays valid.
  let p1 = 1;
  const known = caseFile.known ?? [];
  if (known.length > 0 && known[0].viewers !== undefined && known[0].viewers !== null && known[0].viewers > 0) {
    p1 = known[0].viewers;
  } else if (caseFile.history_hourly) {
    const hist = caseFile.history_hourly.filter((p) => p.viewers !== null && p.viewers !== undefined && p.viewers > 0);
    if (hist.length > 0) p1 = hist[hist.length - 1].viewers as number;
  }
  const logP1 = Math.log(p1);

  // Build the weighted log-ratio curves of the usable comparables.
  // Each curve also keeps its launch's log hour-1 size, for the OLS view.
  const curves: { lr: (number | null)[]; w: number; logH1: number }[] = [];
  for (const comp of caseFile.comparables ?? []) {
    const hrs = dayHours(comp);
    const h1 = hrs[0];
    if (h1 === null || h1 <= 0) continue;
    if (h1 < H1_MIN) continue;
    if (isEarlyAccessContaminated(comp)) continue;
    let usable = 0;
    for (const v of hrs) if (v !== null && v > 0) usable++;
    if (usable < MIN_POINTS) continue;
    const dlog = Math.log(h1) - logP1;
    const w = Math.exp(-((dlog / BANDWIDTH) * (dlog / BANDWIDTH)));
    const lr: (number | null)[] = hrs.map((v) => (v !== null && v > 0 ? Math.log(v / h1) : null));
    curves.push({ lr, w, logH1: Math.log(h1) });
  }

  // Forecast each hour 2..24 from the comparable ratios at that hour.
  const out: number[][] = [];
  for (let h = 2; h <= 24; h++) {
    const pairs: [number, number][] = [];
    const regPts: [number, number][] = [];
    for (const c of curves) {
      const v = c.lr[h - 1];
      if (v !== null) {
        pairs.push([v, c.w]);
        regPts.push([c.logH1, v]);
      }
    }
    let qs: number[];
    if (pairs.length === 0) {
      // No comparable covers this hour: fall back to the house shape.
      const sd = BASELINE_SD_RATE * Math.sqrt(h - 1);
      qs = Z.map((z) => p1 * Math.exp(z * sd));
    } else {
      // Local view: weighted mean and spread of this hour's log-ratios.
      const [centreLocal, sdRaw] = weightedStats(pairs);
      const sd = clamp(SD_SCALE * sdRaw, SD_FLOOR, SD_CAP);
      // Global view: OLS line of the ratio on log hour-1 size, at this
      // launch's hour 1. With fewer than 5 points the line is unusable and
      // the centre falls back to the flat (ratio 0) anchor.
      let centreReg = 0;
      if (regPts.length >= 5) {
        let mx = 0;
        let my = 0;
        for (const [x, y] of regPts) {
          mx += x;
          my += y;
        }
        mx /= regPts.length;
        my /= regPts.length;
        let sxx = 0;
        let sxy = 0;
        for (const [x, y] of regPts) {
          sxx += (x - mx) * (x - mx);
          sxy += (x - mx) * (y - my);
        }
        const b = sxx > 0 ? sxy / sxx : 0;
        const a = my - b * mx;
        centreReg = a + b * logP1;
      }
      const centre = BLEND_ALPHA * centreLocal + (1 - BLEND_ALPHA) * centreReg;
      qs = Z.map((z) => p1 * Math.exp(centre + z * sd));
    }
    // Output rules: finite, > 0, <= 1e9, non-decreasing, 2-decimal rounding.
    const clean: number[] = [];
    let prev = 0;
    for (const q of qs) {
      let v = q;
      if (!Number.isFinite(v) || v <= 0) v = prev > 0 ? prev : 1;
      v = clamp(v, 1, 1e9);
      v = Math.round(v * 100) / 100;
      if (v < prev) v = prev;
      clean.push(v);
      prev = v;
    }
    out.push(clean);
  }
  return out;
}

// --- Driver -----------------------------------------------------------------
function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inDir).filter((f) => f.endsWith(".in")).sort();
  if (files.length === 0) throw new Error(`no .in cases found in ${inDir}`);
  for (const file of files) {
    const id = basename(file, ".in");
    const caseFile: CaseFile = JSON.parse(readFileSync(join(inDir, file), "utf8"));
    const qs = forecast(caseFile);
    const hours = qs.map((q, i) => ({ hour: i + 2, q }));
    const text = JSON.stringify({ hours });
    if (text.length > 65536) throw new Error(`output for ${id} exceeds 65536 bytes`);
    writeFileSync(join(outDir, `${id}.out`), text);
    console.log(`${id}: wrote ${text.length} bytes`);
  }
}

main();
