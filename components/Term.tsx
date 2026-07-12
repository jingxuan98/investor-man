"use client";

import { glossary } from "@/lib/glossary";
import { useTooltip, TooltipBubble } from "@/components/Tooltip";

// Hover-glossary wrapper for a technical label. Client component (needed for
// the portal/tap-toggle tooltip below), but every existing usage from a
// server component (EpvCard, GateCard, MultiplesCard, metrics/page.tsx, etc.)
// still works unchanged — Next.js just renders it as a client island. The
// custom bubble is the only tooltip UI; `aria-label` (not `title`) carries
// the same text for assistive tech so we never show a native browser
// tooltip stacked on top of the custom one.
// Renders children unwrapped if the key isn't in the glossary, so a typo
// degrades gracefully instead of throwing.
export default function Term({ k, children }: { k: string; children: React.ReactNode }) {
  const def = glossary[k];
  const { triggerRef, bubbleRef, open, pos, isTouch, openTooltip, closeTooltip, toggleTooltip } =
    useTooltip<HTMLSpanElement>();

  if (!def) return <>{children}</>;

  return (
    <span
      ref={triggerRef}
      className="relative inline-block cursor-help border-b border-dotted border-ink2/60"
      aria-label={def}
      onMouseEnter={!isTouch ? openTooltip : undefined}
      onMouseLeave={!isTouch ? closeTooltip : undefined}
      onClick={isTouch ? toggleTooltip : undefined}
    >
      {children}
      <TooltipBubble bubbleRef={bubbleRef} pos={pos} open={open}>
        {def}
      </TooltipBubble>
    </span>
  );
}
