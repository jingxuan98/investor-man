"use client";

import { useVariant } from "@/components/VariantProvider";
import { fmtMoney, fmtPct } from "@/lib/format";

// The stock header's price/upside line, made variant-aware: "upside vs fair
// value" must track the SAME global calibrated/textbook toggle as every
// other tab, not stay pinned to calibrated after the header renders once
// server-side. `composites` is the pre-computed pair (both variants, no
// refetch on toggle) — see lib/data/getStockData.ts's variantPair.
export default function HeaderPriceLine({
  price,
  currency,
  composites,
}: {
  price: number;
  currency: string;
  composites: { calibrated: number | null; textbook: number | null };
}) {
  const { variant } = useVariant();
  const composite = composites[variant];
  const upside = composite !== null ? composite / price - 1 : null;
  return (
    <p className="num text-lg text-ink">
      {fmtMoney(price, currency)}{" "}
      <span className={upside !== null && upside > 0 ? "text-green" : "text-red"}>
        {upside !== null ? `${fmtPct(upside)} vs fair value` : ""}
      </span>
    </p>
  );
}
