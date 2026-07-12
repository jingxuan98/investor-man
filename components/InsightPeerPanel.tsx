"use client";

import { useEffect, useRef, useState } from "react";
import { geminiHeaders } from "@/lib/geminiKeyHeader";
import { useVariant } from "@/components/VariantProvider";
import { fmtRatio } from "@/lib/format";
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
  qualityScore: number | null;
  trailingPE: number | null;
  peg: number | null;
}

// A row is either still loading its summary (undefined), failed (null), or resolved.
type RowState = Summary | null | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BarRow {
  ticker: string;
  name: string;
  isSelf: boolean;
  loading: boolean;
  failed: boolean;
  quality: number | null;
  upside: number | null; // decimal, e.g. 0.186
  pe: number | null;
  peg: number | null;
}

// Cheap/expensive convention: PEG < 1 tinted green (cheap for the growth),
// PEG > 2 tinted red (expensive); the 1-2 band is unremarkable, default ink.
function pegClass(peg: number | null): string {
  if (peg === null || !Number.isFinite(peg)) return "text-ink2";
  if (peg < 1) return "text-green";
  if (peg > 2) return "text-red";
  return "text-ink";
}

export default function InsightPeerPanel({
  ticker,
  name,
  sector,
  ownQualityScore,
  ownUpside,
  ownPE,
  ownPEG,
}: {
  ticker: string;
  name: string;
  sector: string | null;
  ownQualityScore: number | null;
  ownUpside: number | null;
  ownPE: number | null;
  ownPEG: number | null;
}) {
  // Global calibrated/textbook selection — same rationale as CompetitorsPanel:
  // peer rows are an independent client-side fetch per ticker, so a variant
  // flip re-fetches them to match the same variant driving ownQualityScore/
  // ownUpside (computed server-side by the caller).
  const { variant } = useVariant();
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [noApiKey, setNoApiKey] = useState(false);
  const [transient, setTransient] = useState(false);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [view, setView] = useState<"quality" | "valuation">("quality");
  // Monotonic token: see CompetitorsPanel for the rationale (StrictMode remount safety).
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
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
      setRows(Object.fromEntries(list.map((c) => [c.ticker, undefined])));

      // Sequential with a small gap so rows stream in one at a time (same
      // pattern as CompetitorsPanel) rather than firing 5 requests at once.
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
  }, [ticker, variant]);

  if (listState === "error") {
    return (
      <p className="text-sm text-ink2">
        Peer comparison unavailable
        {noApiKey &&
          " — click the key icon in the header to add your free Gemini API key (aistudio.google.com/apikey)."}
        {transient && " — try again shortly."}
      </p>
    );
  }

  if (listState === "loading") {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg border border-line bg-track" />
        ))}
      </div>
    );
  }

  if (competitors.length === 0) {
    return <p className="text-sm text-ink2">No competitors found</p>;
  }

  const barRows: BarRow[] = [
    {
      ticker,
      name,
      isSelf: true,
      loading: false,
      failed: false,
      quality: ownQualityScore,
      upside: ownUpside,
      pe: ownPE,
      peg: ownPEG,
    },
    ...competitors.map((c) => {
      const row = rows[c.ticker];
      return {
        ticker: c.ticker,
        name: c.name,
        isSelf: false,
        loading: row === undefined,
        failed: row === null,
        quality: row ? row.qualityScore : null,
        upside: row ? row.upside : null,
        pe: row ? row.trailingPE : null,
        peg: row ? row.peg : null,
      };
    }),
  ];

  const metricOf = (r: BarRow): number | null => {
    if (view === "quality") return r.quality;
    return r.upside !== null ? r.upside * 100 : null;
  };
  const maxAbs = Math.max(...barRows.map((r) => Math.abs(metricOf(r) ?? 0)), 1e-9);

  return (
    <div>
      <div className="mb-4 flex gap-2">
        {(["quality", "valuation"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              view === v
                ? "border border-accent bg-accent-tint text-accent"
                : "border border-line bg-card text-ink3 hover:bg-track"
            }`}
          >
            {v === "quality" ? "Quality" : "Valuation"}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {barRows.map((r) => {
          const m = metricOf(r);
          const widthPct = m === null ? 0 : (Math.abs(m) / maxAbs) * 100;
          const barColor =
            view === "quality"
              ? r.isSelf
                ? "bg-accent"
                : "bg-track"
              : m !== null && m < 0
              ? "bg-red"
              : "bg-green";
          return (
            <div key={r.ticker}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className={r.isSelf ? "font-semibold text-ink" : "text-ink3"}>
                  {r.ticker} <span className="text-ink2">{r.name}</span>
                  {r.isSelf && <span className="ml-2 text-xs text-ink2">· this stock</span>}
                </span>
                <span className={`num ${r.isSelf ? "font-semibold text-ink" : "text-ink2"}`}>
                  {r.loading
                    ? "…"
                    : r.failed || m === null
                    ? "n/a"
                    : view === "quality"
                    ? m.toFixed(1)
                    : `${m >= 0 ? "+" : ""}${m.toFixed(1)}%`}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-track">
                {!r.loading && !r.failed && m !== null && (
                  <div className={`h-2 rounded-full ${barColor}`} style={{ width: `${widthPct}%` }} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* overflow-x-auto so this table scrolls within the panel on narrow
          viewports instead of clipping/squishing (mirrors CompetitorsPanel). */}
      <div className="mt-6 overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-page text-left text-ink2">
            <tr>
              <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide">Company</th>
              <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wide">
                P/E
              </th>
              <th className="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wide">
                <Term k="pegVsSector">PEG</Term>
              </th>
            </tr>
          </thead>
          <tbody>
            {barRows.map((r) => (
              <tr key={r.ticker} className="border-t border-line">
                <td className="px-4 py-3">
                  <span className={r.isSelf ? "font-semibold text-ink" : "text-ink3"}>
                    {r.ticker} <span className="text-ink2">{r.name}</span>
                    {r.isSelf && <span className="ml-2 text-xs text-ink2">· this stock</span>}
                  </span>
                </td>
                <td className="num px-4 py-3 text-right">
                  {r.loading ? "…" : r.failed ? "n/a" : fmtRatio(r.pe)}
                </td>
                <td className={`num px-4 py-3 text-right font-medium ${pegClass(r.peg)}`}>
                  {r.loading ? "…" : r.failed ? "n/a" : fmtRatio(r.peg)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-page">
              <td className="px-4 py-3 text-ink2">Sector median</td>
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
