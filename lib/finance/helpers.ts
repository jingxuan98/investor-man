export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// CAGR from oldest to latest; null when not computable (needs both > 0)
export function cagr(latest: number, oldest: number, years: number): number | null {
  if (years <= 0 || oldest <= 0 || latest <= 0) return null;
  return Math.pow(latest / oldest, 1 / years) - 1;
}

// coefficient of variation (population sd / |mean|); null if <2 points or mean 0
export function coefVar(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (m === 0) return null;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
  return sd / Math.abs(m);
}

// linear map: x0 -> 0, x1 -> 100, clamped. Works reversed (x0 > x1).
export function linearBand(x: number, x0: number, x1: number): number {
  return clamp(((x - x0) / (x1 - x0)) * 100, 0, 100);
}

// Composite average for an arbitrary subset of implied-value methods (used by
// the Intrinsic Value table's investor-style sub-tabs, one per growth-fit
// group). Mirrors the whole-table composite's trimmed-mean semantics (drop
// the single min + max) once the subset is large enough for a trim to still
// leave a meaningful sample; below that, a plain mean; below 3, nothing
// meaningful can be averaged.
export function styleComposite(
  values: number[]
): { value: number | null; method: "trimmed" | "mean" | null } {
  if (values.length < 3) return { value: null, method: null };
  if (values.length >= 5) {
    const sorted = [...values].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return { value: mean(trimmed), method: "trimmed" };
  }
  return { value: mean(values), method: "mean" };
}

// picks metric series oldest->latest from newest-first YearData-like array
export function seriesOldestFirst<T>(
  years: T[],
  pick: (y: T) => number | null
): number[] {
  return [...years]
    .reverse()
    .map(pick)
    .filter((v): v is number => v !== null && Number.isFinite(v));
}
