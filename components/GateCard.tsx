import { GateOutput } from "@/lib/finance/gate";
import Term from "@/components/Term";

// Letter grade → text color (green/amber/red tiers), matching the gate's
// pass/fail semantics (A/B = pass tones, C = caution, D/F = fail).
const GRADE_CLASS: Record<string, string> = {
  A: "text-green",
  B: "text-green",
  C: "text-amber",
  D: "text-red",
  F: "text-red",
};

function scoreClass(score: number): string {
  if (score >= 16) return "text-green";
  if (score >= 10) return "text-amber";
  return "text-red";
}

// Wraps the three glossary-eligible reading labels (ROIC, WACC, Spread) in a
// hover Term; every other reading label (Trend, Gross margin, 5Y CAGR, ...)
// renders as plain text.
function ReadingLabel({ label }: { label: string }) {
  if (label === "ROIC") return <Term k="roic">ROIC</Term>;
  if (label === "WACC (est)")
    return (
      <>
        <Term k="wacc">WACC</Term> (est)
      </>
    );
  if (label === "Spread") return <Term k="spread">Spread</Term>;
  return <>{label}</>;
}

export default function GateCard({ gate }: { gate: GateOutput }) {
  const gaugePct = Math.min(100, Math.max(0, gate.score));
  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-5 border-b border-line p-6">
        <span className={`num text-[54px] font-semibold leading-none ${GRADE_CLASS[gate.grade]}`}>
          {gate.grade}
        </span>
        <div className="min-w-[220px] flex-1">
          <p className="font-semibold text-ink">Quality Gate · 4 sub-factors · 25 pts each</p>
          <p className="num mt-1 text-sm text-ink2">
            {gate.score} / 100 · Pass ≥ {gate.passThreshold}
          </p>
          <div className="relative mt-2 h-1.5 w-full max-w-xs rounded-full bg-track">
            <div
              className={`h-1.5 rounded-full ${gate.passed ? "bg-green" : "bg-red"}`}
              style={{ width: `${gaugePct}%` }}
            />
          </div>
        </div>
        <span className={`text-sm font-semibold ${gate.passed ? "text-green" : "text-red"}`}>
          {gate.passed ? "Passed" : "Failed"}
        </span>
      </div>

      {/* Factor rows */}
      <div className="divide-y divide-line">
        {gate.factors.map((f) => (
          <div key={f.key} className="flex flex-wrap items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{f.name}</p>
              {f.readings.length > 0 && (
                <p className="mt-1 text-sm text-ink2">
                  {f.readings.map((r, i) => (
                    <span key={r.label}>
                      {i > 0 && <span className="text-line"> · </span>}
                      <ReadingLabel label={r.label} /> {r.value}
                    </span>
                  ))}
                </p>
              )}
            </div>
            <div className="text-right">
              <p className={`num text-base font-semibold ${scoreClass(f.score)}`}>{f.score} / 25</p>
              <p className={`text-sm ${scoreClass(f.score)}`}>{f.status}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
