"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fmtMoney, fmtPct } from "@/lib/format";
import { geminiHeaders } from "@/lib/geminiKeyHeader";
import { useVariant } from "@/components/VariantProvider";

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
}

// A row is either still loading its summary (undefined), failed (null),
// or resolved (Summary).
type RowState = Summary | null | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function upsideClass(upside: number | null): string {
  if (upside === null || !Number.isFinite(upside)) return "text-ink2";
  return upside >= 0 ? "text-green" : "text-red";
}

export default function CompetitorsPanel({ ticker }: { ticker: string }) {
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

  if (listState === "error") {
    return (
      <p className="text-sm text-ink2">
        Competitors unavailable
        {noApiKey &&
          " — click the key icon in the header to add your free Gemini API key (aistudio.google.com/apikey)."}
        {transient && " — the AI model is rate-limited or temporarily unavailable, try again shortly."}
      </p>
    );
  }

  if (listState === "loading") {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-line bg-track" />
        ))}
      </div>
    );
  }

  if (competitors.length === 0) {
    return <p className="text-sm text-ink2">No competitors found</p>;
  }

  return (
    <div className="card overflow-hidden">
      {/* overflow-x-auto + min-w-max so this wide table scrolls within the
          card on narrow viewports instead of clipping/squishing. */}
      <div className="overflow-x-auto">
      <table className="w-full min-w-max text-sm">
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
          </tr>
        </thead>
        <tbody>
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
                  <td colSpan={3} className="px-4 py-3 text-right">
                    <span
                      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-ink2 align-middle"
                      aria-label="Loading"
                    />
                  </td>
                ) : failed ? (
                  <td colSpan={3} className="px-4 py-3 text-right text-ink2">
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
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
