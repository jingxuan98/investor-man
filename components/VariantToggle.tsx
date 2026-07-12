"use client";

import { ValuationVariant } from "@/lib/finance/types";
import { useVariant } from "@/components/VariantProvider";
import { useTooltip, TooltipBubble } from "@/components/Tooltip";

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
// one flips both in lockstep. Uses the shared portal tooltip (Tooltip.tsx) —
// hover shows it on desktop; on touch, tapping both selects the variant (as
// before) and toggles the tooltip open, since there's no hover to show it.
function VariantButton({
  variant,
  active,
  onClick,
}: {
  variant: ValuationVariant;
  active: boolean;
  onClick: () => void;
}) {
  const { triggerRef, bubbleRef, open, pos, isTouch, openTooltip, closeTooltip, toggleTooltip } =
    useTooltip<HTMLButtonElement>();
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-pressed={active}
      aria-label={VARIANT_TOOLTIP[variant]}
      className={`relative tab-btn !px-3 !py-1.5 !text-xs ${active ? "active" : ""}`}
      onClick={() => {
        onClick();
        if (isTouch) toggleTooltip();
      }}
      onMouseEnter={!isTouch ? openTooltip : undefined}
      onMouseLeave={!isTouch ? closeTooltip : undefined}
    >
      {VARIANT_LABEL[variant]}
      <TooltipBubble bubbleRef={bubbleRef} pos={pos} open={open}>
        {VARIANT_TOOLTIP[variant]}
      </TooltipBubble>
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
        onClick={() => setVariant("calibrated")}
      />
      <VariantButton
        variant="textbook"
        active={variant === "textbook"}
        onClick={() => setVariant("textbook")}
      />
    </div>
  );
}
