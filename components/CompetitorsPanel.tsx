"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fmtMoney, fmtPct, fmtRatio } from "@/lib/format";
import { geminiHeaders } from "@/lib/geminiKeyHeader";
import { useVariant } from "@/components/VariantProvider";
import { SECTOR_MULTIPLES } from "@/lib/finance/valuation";
import Term from "@/components/Term";

interface Competitor {
  ticker: string;
  name: string;
}

interface Summary {
  ticker: string;
  name: string;
  price: number | null;
  fairValue: number | null;
  upside: number | null;
  trailingPE: number | null;
  peg: number | null;
}

// Subject stock's own row — computed server-side by page.tsx (same
// fair-value/upside formula app/api/summary/[ticker]/route.ts uses for
// peers), for BOTH variants so this component can pick calibrated vs
// textbook from its own useVariant() state without an extra fetch (mirrors
// OverviewStats's `stats={{ calibrated, textbook }}` prop pattern). P/E and
// PEG aren't variant-dependent, so those are plain numbers.
export interface SelfSummary {
  ticker: string;
  name: string;
  price: number | null;
  trailingPE: number | null;
  peg: number | null;
  calibrated: { fairValue: number | null; upside: number | null };
  textbook: { fairValue: number | null; upside: number | null };
}

// A row is either still loading its summary (undefined), failed (null),
// or resolved (Summary).
type RowState = Summary | null | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function upsideClass(upside: number | null): string {
  if (upside === null || !Number.isFinite(upside)) return "text-ink2";
  return upside >= 0 ? "text-green" : "text-red";
}

// Cheap/expensive convention: PEG < 1 tinted green (cheap for the growth),
// PEG > 2 tinted red (expensive); the 1-2 band is unremarkable, default ink.
function pegClass(peg: number | null): string {
  if (peg === null || !Number.isFinite(peg)) return "text-ink2";
  if (peg < 1) return "text-green";
  if (peg > 2) return "text-red";
  return "text-ink";
}

export default function CompetitorsPanel({
  ticker,
  sector,
  self,
}: {
  ticker: string;
  sector?: string | null;
  self: SelfSummary;
}) {
  // Global calibrated/textbook selection — peer fair-value/upside must match
  // the SAME variant as the subject stock's own tabs (task brief: "sector-
  // average + competitor comparisons" reads the selected variant's
  // composite). Unlike the subject stock's own numbers (server-computed pair,
  // no refetch on toggle), each peer's summary is already a client-side
  // per-row fetch, so a variant flip re-fetches those rows — same round-trip
  // this panel already makes on every ticker change.
  const { variant } = useVariant();
  const [listState, setListState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [noApiKey, setNoApiKey] = useState(false);
  // Set when the list fetch failed with a rate-limited/model-unavailable
  // upstream error (as opposed to a missing key) — lets the error message
  // say "try again shortly" instead of hinting at a key that's already there.
  const [transient, setTransient] = useState(false);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Monotonic token for the latest effect run. A StrictMode remount (or a
  // ticker change) bumps it, retiring older runs: their setStates are skipped
  // while the fresh run proceeds. Unlike a cleanup-set `cancelled` flag, a
  // remount cannot poison the new run — it always gets a live token.
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    // Reason: checked before every setState so only the latest run mutates state.
    const active = () => runId.current === id;
    setListState("loading");
    setNoApiKey(false);
    setTransient(false);
    setCompetitors([]);
    setRows({});

    (async () => {
      let list: Competitor[];
      try {
        const res = await fetch(`/api/competitors/${ticker}`, { headers: geminiHeaders() });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          if (active()) {
            if (res.status === 503 && data?.error === "no_api_key") setNoApiKey(true);
            else if (res.status === 429 || data?.error === "model_unavailable") setTransient(true);
          }
          throw new Error("list_failed");
        }
        const data = await res.json();
        list = Array.isArray(data.competitors) ? data.competitors : [];
      } catch {
        if (active()) setListState("error");
        return;
      }
      if (!active()) return;
      setCompetitors(list);
      setListState("ready");
      // Seed every row as loading (undefined).
      setRows(Object.fromEntries(list.map((c) => [c.ticker, undefined])));

      // Fetch each summary sequentially with a small gap so rows stream in
      // one at a time rather than all at once.
      for (const c of list) {
        if (!active()) return;
        let summary: RowState = null;
        try {
          const res = await fetch(`/api/summary/${c.ticker}?variant=${variant}`);
          if (res.ok) summary = (await res.json()) as Summary;
        } catch {
          summary = null;
        }
        if (!active()) return;
        setRows((prev) => ({ ...prev, [c.ticker]: summary }));
        await sleep(300);
      }
    })();
    // No cleanup: the next run bumping runId is what retires this one.
  }, [ticker, variant]);

  // Subject stock's own row — calibrated vs textbook picked from this
  // component's own useVariant() state (same idea as InsightPeerPanel's
  // metricOf picking quality vs upside off its own `view` state). No fetch
  // needed: all fields come from the server-computed `self` prop, so this
  // row is independent of listState and renders in every branch below.
  const selfVariant = self[variant];
  const selfRow = (
    <tr className="border-t border-line bg-accent-tint">
      <td className="px-4 py-3">
        <span className="font-semibold text-ink">{self.name}</span>
        <span className="ml-2 text-ink2">{self.ticker}</span>
        <span className="ml-2 text-xs text-ink2">· this stock</span>
      </td>
      <td className="num px-4 py-3 text-right font-semibold text-ink">
        {fmtMoney(selfVariant.fairValue)}
      </td>
      <td className="num px-4 py-3 text-right font-semibold text-ink">{fmtMoney(self.price)}</td>
      <td
        className={`num px-4 py-3 text-right font-semibold ${upsideClass(selfVariant.upside)}`}
      >
        {fmtPct(selfVariant.upside)}
      </td>
      <td className="num px-4 py-3 text-right font-semibold text-ink">
        {fmtRatio(self.trailingPE)}
      </td>
      <td className={`num px-4 py-3 text-right font-semibold ${pegClass(self.peg)}`}>
        {fmtRatio(self.peg)}
      </td>
    </tr>
  );

  const tableHead = (
    <thead className="bg-page text-left text-ink2">
      <tr>
        <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide">Company</th>
        <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wide">
          Fair value
        </th>
        <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wide">
          Price
        </th>
        <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wide">
          Upside
        </th>
        <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wide">
          P/E
        </th>
        <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wide">
          <Term k="pegVsSector">PEG</Term>
        </th>
      </tr>
    </thead>
  );

  if (listState === "error") {
    return (
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            {tableHead}
            <tbody>{selfRow}</tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-sm text-ink2">
          Competitors unavailable
          {noApiKey &&
            " — click the key icon in the header to add your free Gemini API key (aistudio.google.com/apikey)."}
          {transient && " — try again shortly."}
        </p>
      </div>
    );
  }

  if (listState === "loading") {
    return (
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            {tableHead}
            <tbody>{selfRow}</tbody>
          </table>
        </div>
        <div className="space-y-2 p-4">
          <p className="text-sm text-ink2">
            Generating — can take a minute or two when free-tier models are busy…
          </p>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border border-line bg-track" />
          ))}
        </div>
      </div>
    );
  }

  if (competitors.length === 0) {
    return (
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            {tableHead}
            <tbody>{selfRow}</tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-sm text-ink2">No competitors found</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      {/* overflow-x-auto + min-w-max so this wide table scrolls within the
          card on narrow viewports instead of clipping/squishing. */}
      <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
        {tableHead}
        <tbody>
          {selfRow}
          {competitors.map((c) => {
            const row = rows[c.ticker];
            const loading = row === undefined;
            const failed = row === null;
            return (
              <tr key={c.ticker} className="border-t border-line">
                <td className="px-4 py-3">
                  <Link href={`/stock/${c.ticker}`} className="font-medium text-accent hover:underline">
                    {c.name}
                  </Link>
                  <span className="ml-2 text-ink2">{c.ticker}</span>
                </td>
                {loading ? (
                  <td colSpan={5} className="px-4 py-3 text-right">
                    <span
                      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-ink2 align-middle"
                      aria-label="Loading"
                    />
                  </td>
                ) : failed ? (
                  <td colSpan={5} className="px-4 py-3 text-right text-ink2">
                    n/a
                  </td>
                ) : (
                  <>
                    <td className="num px-4 py-3 text-right">{fmtMoney(row!.fairValue)}</td>
                    <td className="num px-4 py-3 text-right">{fmtMoney(row!.price)}</td>
                    <td
                      className={`num px-4 py-3 text-right font-medium ${upsideClass(row!.upside)}`}
                    >
                      {fmtPct(row!.upside)}
                    </td>
                    <td className="num px-4 py-3 text-right">{fmtRatio(row!.trailingPE)}</td>
                    <td className={`num px-4 py-3 text-right font-medium ${pegClass(row!.peg)}`}>
                      {fmtRatio(row!.peg)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-page">
            <td className="px-4 py-3 text-ink2">Sector median</td>
            <td className="px-4 py-3 text-right text-ink2">—</td>
            <td className="px-4 py-3 text-right text-ink2">—</td>
            <td className="px-4 py-3 text-right text-ink2">—</td>
            <td className="num px-4 py-3 text-right text-ink2">
              {fmtRatio(sector != null ? SECTOR_MULTIPLES[sector]?.pe ?? null : null)}
            </td>
            {/* PEG has no sector-level analog (growth varies stock by stock within a sector). */}
            <td className="px-4 py-3 text-right text-ink2">—</td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  );
}
