"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { ValuationVariant } from "@/lib/finance/types";

// ---------------------------------------------------------------------------
// Site-wide calibrated/textbook selection. One toggle in the stock header
// (see VariantToggle) drives every tab's grading/advice: Overview's
// signal/verdict, the Intrinsic Value table, competitor/sector comparisons,
// The Story, SuperInvestor's quality profile, and AI Insight prompts all read
// the SAME variant off this context instead of each keeping its own state.
// Persisted to localStorage so it survives a refresh; default "calibrated".
// No network refetch on toggle: server pages compute BOTH variants up front
// (see lib/data/getStockData.ts's variantPair/bundleForVariant) and pass the
// pair down — this context only selects which half of that pair to render.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "valuation_variant";

interface VariantContextValue {
  variant: ValuationVariant;
  setVariant: (v: ValuationVariant) => void;
}

const VariantContext = createContext<VariantContextValue | null>(null);

function isVariant(v: string | null): v is ValuationVariant {
  return v === "calibrated" || v === "textbook";
}

export function VariantProvider({ children }: { children: React.ReactNode }) {
  // Reason: always start at the default "calibrated" during SSR/first paint
  // (a brief calibrated flash on hydration is acceptable per spec) — reading
  // localStorage synchronously here would cause a hydration mismatch since
  // the server has no localStorage to read.
  const [variant, setVariantState] = useState<ValuationVariant>("calibrated");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isVariant(stored)) setVariantState(stored);
  }, []);

  const setVariant = (v: ValuationVariant) => {
    setVariantState(v);
    window.localStorage.setItem(STORAGE_KEY, v);
  };

  return <VariantContext.Provider value={{ variant, setVariant }}>{children}</VariantContext.Provider>;
}

export function useVariant(): VariantContextValue {
  const ctx = useContext(VariantContext);
  if (!ctx) throw new Error("useVariant must be used within a VariantProvider");
  return ctx;
}
