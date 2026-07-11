"use client";

import { useMemo, useState } from "react";
import { generalThreeStagePv } from "@/lib/finance/insights";
import { FinancialSnapshot } from "@/lib/finance/types";
import { fmtMoney, fmtPct } from "@/lib/format";
import KnobField from "@/components/KnobField";
import SignalBadge from "@/components/SignalBadge";
import Term from "@/components/Term";

// Raw text state for the editable inputs — kept as strings (not numbers) so a
// field can hold transient/partial input without losing keystrokes. Parsing
// happens in the `resolved` useMemo below (same pattern as ValueTable.tsx).
interface DcfInputs {
  ocf: string; // Operating CF TTM ($M)
  debt: string; // Total debt ($M)
  cash: string; // Cash & ST investments ($M)
  wacc: string; // Discount rate %
  shares: string; // Shares outstanding (M)
  g1: string; // Growth Y1-5 %
  g2: string; // Growth Y6-10 %
  g3: string; // Growth Y11-20 %
}

const EMPTY: DcfInputs = { ocf: "", debt: "", cash: "", wacc: "", shares: "", g1: "", g2: "", g3: "" };

function parseNumber(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parsePercent(raw: string): number | undefined {
  const n = parseNumber(raw);
  return n === undefined ? undefined : n / 100;
}

// The snapshot stores raw dollars and a raw share count, but the reference
// UI (and this card) edits Operating CF / debt / cash / shares in millions —
// convert a user-entered "millions" figure back to the snapshot's raw units.
function parseMillions(raw: string): number | undefined {
  const n = parseNumber(raw);
  return n === undefined ? undefined : n * 1e6;
}

export default function LongHorizonDcf({
  snapshot,
  autoNormalGrowth,
  autoWacc,
  impliedGrowth,
}: {
  snapshot: FinancialSnapshot;
  autoNormalGrowth: number; // decimal, e.g. 0.12 — from valuation.autoNormalGrowth(snapshot)
  autoWacc: number; // decimal — from assumptions.autoWacc(snapshot)
  impliedGrowth: number | null; // reverseDcf(snapshot).impliedGrowth, server-computed
}) {
  const y0 = snapshot.years[0];
  const autoOcf = snapshot.ttm?.operatingCashFlow ?? y0?.operatingCashFlow ?? null;
  const autoDebt = y0?.totalDebt ?? 0;
  const autoCash = y0?.cash ?? 0;
  const autoShares = snapshot.sharesOutstanding;
  const autoG2 = 0.7 * autoNormalGrowth;
  const autoG3 = 0.04; // terminal default, matches valuation.ts's resolveAssumptions

  const [inputs, setInputs] = useState<DcfInputs>(EMPTY);
  const setField = (key: keyof DcfInputs) => (v: string) =>
    setInputs((prev) => ({ ...prev, [key]: v }));

  const resolved = useMemo(() => {
    return {
      ocf: parseMillions(inputs.ocf) ?? autoOcf,
      debt: parseMillions(inputs.debt) ?? autoDebt,
      cash: parseMillions(inputs.cash) ?? autoCash,
      wacc: parsePercent(inputs.wacc) ?? autoWacc,
      shares: parseMillions(inputs.shares) ?? autoShares,
      g1: parsePercent(inputs.g1) ?? autoNormalGrowth,
      g2: parsePercent(inputs.g2) ?? autoG2,
      g3: parsePercent(inputs.g3) ?? autoG3,
    };
  }, [inputs, autoOcf, autoDebt, autoCash, autoWacc, autoShares, autoNormalGrowth, autoG2]);

  const { ocf, debt, cash, wacc, shares, g1, g2, g3 } = resolved;

  const intrinsicPerShare = useMemo(() => {
    if (ocf === null || ocf <= 0 || !shares || shares <= 0) return null;
    // ocf/debt/cash/shares are all resolved back to the snapshot's raw units
    // (see parseMillions) so this division is already dollars per share.
    const pv = generalThreeStagePv(ocf, g1, g2, g3, wacc);
    if (pv === null) return null;
    const equity = pv + cash - debt;
    if (equity <= 0) return null;
    return equity / shares;
  }, [ocf, debt, cash, wacc, shares, g1, g2, g3]);

  const price = snapshot.price;
  const upside = intrinsicPerShare !== null ? intrinsicPerShare / price - 1 : null;
  const upsideClass = upside === null ? undefined : upside >= 0 ? "text-green" : "text-red";

  const reset = () => setInputs(EMPTY);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kpi-label">Intrinsic value / share</p>
          <p className="num mt-1 text-3xl font-semibold text-ink">
            {intrinsicPerShare === null ? (
              <span className="text-lg italic text-ink2">n/a</span>
            ) : (
              fmtMoney(intrinsicPerShare, snapshot.currency)
            )}
          </p>
          {intrinsicPerShare !== null && (
            <p className={`mt-1 text-sm font-medium ${upsideClass}`}>
              {upside! >= 0 ? "Discount" : "Premium"} {Math.abs(upside! * 100).toFixed(1)}% vs
              price {fmtMoney(price, snapshot.currency)}
            </p>
          )}
        </div>
        <SignalBadge upside={upside} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KnobField
          label={<Term k="ocf">Operating CF TTM ($M)</Term>}
          value={inputs.ocf}
          placeholder={autoOcf !== null ? `${(autoOcf / 1e6).toFixed(0)} (auto)` : "n/a"}
          onChange={setField("ocf")}
        />
        <KnobField
          label="Total debt ($M)"
          value={inputs.debt}
          placeholder={`${(autoDebt / 1e6).toFixed(0)} (auto)`}
          onChange={setField("debt")}
        />
        <KnobField
          label="Cash ($M)"
          value={inputs.cash}
          placeholder={`${(autoCash / 1e6).toFixed(0)} (auto)`}
          onChange={setField("cash")}
        />
        <KnobField
          label={<Term k="discountRate">Discount rate %</Term>}
          value={inputs.wacc}
          placeholder={`${(autoWacc * 100).toFixed(1)} (auto)`}
          onChange={setField("wacc")}
        />
        <KnobField
          label="Shares (M)"
          value={inputs.shares}
          placeholder={`${(autoShares / 1e6).toFixed(0)} (auto)`}
          onChange={setField("shares")}
        />
        <KnobField
          label={<Term k="cagr">Growth Y1-5 %</Term>}
          value={inputs.g1}
          placeholder={`${(autoNormalGrowth * 100).toFixed(1)} (auto)`}
          onChange={setField("g1")}
        />
        <KnobField
          label="Growth Y6-10 %"
          value={inputs.g2}
          placeholder={`${(autoG2 * 100).toFixed(1)} (auto)`}
          onChange={setField("g2")}
        />
        <KnobField
          label={<Term k="terminalGrowth">Growth Y11-20 %</Term>}
          value={inputs.g3}
          placeholder={`${(autoG3 * 100).toFixed(1)} (auto)`}
          onChange={setField("g3")}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={reset} className="btn btn-outline !px-3 !py-1.5 text-xs">
          Reset to auto values
        </button>
        {impliedGrowth !== null && (
          <p className="text-xs text-ink2">
            Market prices in {fmtPct(impliedGrowth)} (Y1–5) growth — your model assumes{" "}
            {fmtPct(autoNormalGrowth)}.
          </p>
        )}
      </div>
    </div>
  );
}
