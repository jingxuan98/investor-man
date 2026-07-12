import { cacheGet, cacheSet } from "@/lib/db";

// One fiscal year of annual figures from SEC EDGAR. Newest-first in arrays.
// Used ONLY to lengthen the growth-seed window (Yahoo's free API caps at ~4y);
// never used to replace Yahoo's statements.
export interface GrowthYear {
  year: number;
  revenue: number | null;
  netIncome: number | null;
}

const TTL_TICKERS = 30 * 24 * 3600; // 30 days
const TTL_HISTORY = 7 * 24 * 3600; // 7 days

// SEC requires an identifying User-Agent or it returns 403.
function secHeaders(): Record<string, string> {
  return {
    "User-Agent": `InvestSite/1.0 (${process.env.SEC_CONTACT ?? "research@investsite.local"})`,
    Accept: "application/json",
  };
}

// Map ticker → 10-digit zero-padded CIK using SEC's ticker directory.
// company_tickers.json is a JSON object keyed by index: {cik_str, ticker, title}.
export async function tickerToCik(ticker: string): Promise<string | null> {
  const up = ticker.toUpperCase();
  const cacheKey = "edgar:tickers";
  let map = cacheGet<Record<string, string>>(cacheKey);
  if (!map) {
    try {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        headers: secHeaders(),
        // Reason: a hung EDGAR must degrade to null, not stall page loads.
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as Record<
        string,
        { cik_str: number; ticker: string; title: string }
      >;
      // Reduce the multi-entry object to a compact TICKER→cik10 map before caching.
      map = {};
      for (const key of Object.keys(json)) {
        const entry = json[key];
        if (entry && typeof entry.ticker === "string") {
          map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, "0");
        }
      }
      cacheSet(cacheKey, map, TTL_TICKERS);
    } catch {
      return null;
    }
  }
  return map[up] ?? null;
}

// --- pure parser (offline-testable) -----------------------------------------
// Extract newest-first annual revenue/netIncome from an SEC companyfacts JSON.
// Revenue tags are resolved PER FISCAL YEAR in priority order:
// RevenueFromContractWithCustomerExcludingAssessedTax, then Revenues, then
// SalesRevenueNet — for each year the highest-priority tag with a valid annual
// entry wins. Reason: companies switch concepts over time (NVDA's recent FYs
// live only under `Revenues` while its older FYs sit under the ASC-606 tag);
// a whole-series "first tag with data" rule truncates such histories.
// Net income: NetIncomeLoss. Only true annual 10-K/FY rows (period ≥ 340 days)
// are kept; deduped by fiscal year keeping the latest end+filed.
export function extractGrowthHistory(companyFactsJson: unknown): GrowthYear[] {
  const facts = (companyFactsJson as any)?.facts?.["us-gaap"];
  if (!facts || typeof facts !== "object") return [];

  const revenueTags = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    // RMBS-style filers tag top-line tax-inclusive ("Including", not the
    // usual "Excluding") — without this the whole EDGAR history reads null
    // and the growth seed silently falls back to Yahoo's shorter window.
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "Revenues",
    // XOM-style filers tag top-line under this plural ASC-606 variant
    "RevenuesFromContractsWithCustomers",
    "SalesRevenueNet",
    // GS-style bank/broker-dealer filers have no ASC-606 revenue tag at all —
    // their top line is "total revenues net of interest expense" (30-ticker
    // sweep, task-43: GS revWindow was rejected, 0/8 non-null, before this).
    "RevenuesNetOfInterestExpense",
  ];

  // Annual figures for a single tag: Map<fiscalYear, value>, filtered to
  // 10-K/FY full-year rows and deduped by fy keeping latest end+filed.
  const annualForTag = (tag: string): Map<number, number> => {
    const out = new Map<number, number>();
    const usd: any[] = facts[tag]?.units?.USD;
    if (!Array.isArray(usd)) return out;
    const picked = new Map<
      number,
      { value: number; end: string; filed: string }
    >();
    for (const e of usd) {
      if (e?.form !== "10-K" || e?.fp !== "FY") continue;
      if (typeof e.val !== "number") continue;
      if (typeof e.start !== "string" || typeof e.end !== "string") continue;
      // Duration guard: quarterly rows also appear under 10-K forms.
      const days = (Date.parse(e.end) - Date.parse(e.start)) / 86400_000;
      if (!(days >= 340)) continue;
      const fy =
        typeof e.fy === "number" ? e.fy : new Date(e.end).getUTCFullYear();
      const prev = picked.get(fy);
      // Dedupe: keep the entry with the latest end, then latest filed.
      if (
        !prev ||
        e.end > prev.end ||
        (e.end === prev.end && (e.filed ?? "") > prev.filed)
      ) {
        picked.set(fy, { value: e.val, end: e.end, filed: e.filed ?? "" });
      }
    }
    for (const [fy, v] of picked) out.set(fy, v.value);
    return out;
  };

  // Per-year merge across tags: iterate in priority order; a lower-priority
  // tag only fills fiscal years the higher-priority tags didn't cover.
  const annualByYear = (tags: string[]): Map<number, number> => {
    const merged = new Map<number, number>();
    for (const tag of tags) {
      for (const [fy, v] of annualForTag(tag)) {
        if (!merged.has(fy)) merged.set(fy, v);
      }
    }
    return merged;
  };

  const revByYear = annualByYear(revenueTags);
  const niByYear = annualByYear([
    "NetIncomeLoss",
    // CAT-style filers stop tagging plain NetIncomeLoss after ~FY2010 and
    // report the common-attributable figure under this variant instead
    // (30-ticker sweep, task-43: CAT niWindow was rejected, 0/8 non-null
    // for FY2016-2025, despite 8/8 non-null revenue).
    "NetIncomeLossAvailableToCommonStockholdersBasic",
    // Lowest priority: includes noncontrolling interests, only used when
    // neither of the above (common-attributable) tags has a value.
    "ProfitLoss",
  ]);

  const years = new Set<number>([...revByYear.keys(), ...niByYear.keys()]);
  return [...years]
    .sort((a, b) => b - a) // newest first
    .slice(0, 8)
    .map((year) => ({
      year,
      revenue: revByYear.has(year) ? revByYear.get(year)! : null,
      netIncome: niByYear.has(year) ? niByYear.get(year)! : null,
    }));
}

// Fetch up to 8 years of annual revenue/net income from SEC EDGAR.
// Caches the EXTRACTED array (not the multi-MB raw companyfacts). Returns
// null when the CIK is unknown or the fetch/parse fails — callers must treat
// a null as "no EDGAR data" and never fail the snapshot on it.
export async function fetchGrowthHistory(
  ticker: string
): Promise<GrowthYear[] | null> {
  const up = ticker.toUpperCase();
  const cacheKey = `edgar:${up}`;
  const cached = cacheGet<GrowthYear[]>(cacheKey);
  if (cached) return cached;

  const cik = await tickerToCik(up);
  if (!cik) return null;

  try {
    const res = await fetch(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      // Reason: a hung EDGAR must degrade to null, not stall page loads.
      { headers: secHeaders(), signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const history = extractGrowthHistory(json);
    if (history.length === 0) return null;
    cacheSet(cacheKey, history, TTL_HISTORY);
    return history;
  } catch {
    return null;
  }
}
