export type Signal = "undervalued" | "fair" | "overvalued" | "unknown";

/** Upside is composite fair value / price - 1. Thresholds per spec: >+15% undervalued, <-15% overvalued, else fair. */
export function getSignal(upside: number | null): Signal {
  if (upside === null || !Number.isFinite(upside)) return "unknown";
  if (upside > 0.15) return "undervalued";
  if (upside < -0.15) return "overvalued";
  return "fair";
}

export const SIGNAL_LABEL: Record<Signal, string> = {
  undervalued: "Undervalued",
  fair: "Fairly valued",
  overvalued: "Overvalued",
  unknown: "n/a",
};

/** Lowercase phrase form for verdict sentences, e.g. "trading below fair value". */
export const SIGNAL_VALUATION_PHRASE: Record<Signal, string> = {
  undervalued: "below fair value",
  fair: "near fair value",
  overvalued: "above fair value",
  unknown: "at an undetermined valuation",
};

const SIGNAL_STYLE: Record<Signal, string> = {
  undervalued: "chip-pos",
  fair: "chip-warn",
  overvalued: "chip-neg",
  unknown: "chip-neutral",
};

export default function SignalBadge({ upside }: { upside: number | null }) {
  const signal = getSignal(upside);
  return <span className={`chip ${SIGNAL_STYLE[signal]}`}>{SIGNAL_LABEL[signal]}</span>;
}
