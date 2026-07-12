"use client";

import { ValuationVariant } from "@/lib/finance/types";
import { useVariant } from "@/components/VariantProvider";

// Exported so other views needing the plain label/tooltip text (e.g.
// ValueTable's composite-row caption) share these strings instead of
// duplicating them.
export const VARIANT_LABEL: Record<ValuationVariant, string> = {
  calibrated: "Calibrated",
  textbook: "Textbook (no caps)",
};

export const VARIANT_TOOLTIP: Record<ValuationVariant, string> = {
  calibrated:
    "Calibrated to a professional reference calculator: growth capped 30%, discount capped 12%, no value counted beyond year 20, TTM cash flows, sector multiples.",
  textbook:
    "Classic finance-textbook DCF: uncapped CAPM discount, uncapped growth, linear fade PLUS a terminal value for the business beyond year 20, audited fiscal-year figures, own-history multiples only. Punishes volatile stocks harder and rewards durable ones more.",
};

// Segmented variant toggle — the SINGLE global calibrated/textbook control.
// Rendered both in the stock header (near the classification badge) and
// inline in ValueTable (where the task brief says it must stay); both
// instances read/write the same VariantProvider context, so flipping either
// one flips both in lockstep. Mirrors Term.tsx's hover-tooltip pattern (same
// group/tooltip CSS classes) so the popover matches the app's design system.
function VariantButton({
  variant,
  active,
  align,
  onClick,
}: {
  variant: ValuationVariant;
  active: boolean;
  align: "left" | "right";
  onClick: () => void;
}) {
  const posClass = align === "left" ? "left-0 origin-top-left" : "right-0 origin-top-right";
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={VARIANT_TOOLTIP[variant]}
      className={`group relative tab-btn !px-3 !py-1.5 !text-xs ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {VARIANT_LABEL[variant]}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] scale-95 whitespace-normal break-words rounded-lg border border-line bg-card p-2.5 text-xs font-normal normal-case leading-snug tracking-normal text-ink3 opacity-0 shadow-lg transition-all duration-150 group-hover:scale-100 group-hover:opacity-100 ${posClass}`}
      >
        {VARIANT_TOOLTIP[variant]}
      </span>
    </button>
  );
}

export default function VariantToggle({ className }: { className?: string }) {
  const { variant, setVariant } = useVariant();
  return (
    <div
      className={`flex gap-1 ${className ?? ""}`}
      role="group"
      aria-label="Valuation methodology variant"
    >
      <VariantButton
        variant="calibrated"
        active={variant === "calibrated"}
        align="left"
        onClick={() => setVariant("calibrated")}
      />
      <VariantButton
        variant="textbook"
        active={variant === "textbook"}
        align="right"
        onClick={() => setVariant("textbook")}
      />
    </div>
  );
}
