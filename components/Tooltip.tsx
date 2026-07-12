"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Shared tooltip primitive backing Term.tsx's glossary popovers AND the
// Variant/Horizon toggle buttons' hover explainers (previously two separate
// hand-rolled `group-hover` implementations). Fixes two bugs the old
// absolutely-positioned-inside-the-trigger approach had:
//
//  a) CLIPPING — an absolutely-positioned tooltip is clipped by ANY ancestor
//     with overflow-x/overflow-y set (e.g. ValueTable's `overflow-x-auto`
//     table wrapper, or its outer `overflow-hidden` card section, which is
//     what clipped the WACC knob's tooltip even though the knob itself isn't
//     inside the scrolling table). Fixed by rendering the bubble through a
//     React portal to `document.body` with `position: fixed` coordinates
//     computed from the trigger's `getBoundingClientRect()` — it never has
//     an overflow-clipping ancestor because it isn't inside one, and it
//     flips above/below and clamps horizontally to the viewport itself.
//  b) MOBILE — hover doesn't exist on touch. On a touch-primary device
//     (`(hover: none)`), the trigger becomes tap-to-toggle instead of
//     hover-to-show; a tap outside, a scroll, or a second tap on the same
//     trigger closes it.
const BUBBLE_WIDTH = 288; // matches the bubble's `w-72` Tailwind class, px
const VIEWPORT_MARGIN = 16; // matches `max-w-[calc(100vw-2rem)]`, px
const GAP = 6; // space between trigger and bubble, px

type Placement = "above" | "below";
interface Position {
  top: number;
  left: number;
  placement: Placement;
}

// Manages one tooltip trigger's open state, portal position, and touch vs.
// hover interaction — the trigger itself (span for Term, button for the
// toggle controls) owns its own markup and wires up whichever handlers fit
// its DOM shape (a `<button>` also needs its own onClick for the toggle
// action, which a plain glossary `<span>` doesn't have).
export function useTooltip<T extends HTMLElement>() {
  const triggerRef = useRef<T>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(hover: none)");
    const update = () => setIsTouch(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const computePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const bubbleW = bubbleRef.current?.offsetWidth || BUBBLE_WIDTH;
    const bubbleH = bubbleRef.current?.offsetHeight || 80;

    let left = rect.left + rect.width / 2 - bubbleW / 2;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - bubbleW - VIEWPORT_MARGIN));

    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placement: Placement =
      spaceBelow < bubbleH + GAP && spaceAbove > spaceBelow ? "above" : "below";
    const top = placement === "below" ? rect.bottom + GAP : rect.top - GAP;

    setPos({ top, left, placement });
  };

  // Recompute right before paint whenever the tooltip opens, so it never
  // flashes at a stale/absent position.
  useLayoutEffect(() => {
    if (open) computePosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep it glued to the trigger while open (scroll/resize reflow).
  useEffect(() => {
    if (!open) return;
    const reflow = () => computePosition();
    window.addEventListener("scroll", reflow, true);
    window.addEventListener("resize", reflow);
    return () => {
      window.removeEventListener("scroll", reflow, true);
      window.removeEventListener("resize", reflow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Touch only: a scroll anywhere, or a tap outside the trigger/bubble,
  // closes it (mirrors how hover-out closes it on desktop).
  useEffect(() => {
    if (!open || !isTouch) return;
    const close = () => setOpen(false);
    const closeOnOutsideTap = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (bubbleRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    document.addEventListener("pointerdown", closeOnOutsideTap);
    return () => {
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("pointerdown", closeOnOutsideTap);
    };
  }, [open, isTouch]);

  return {
    triggerRef,
    bubbleRef,
    open,
    pos,
    isTouch,
    openTooltip: () => setOpen(true),
    closeTooltip: () => setOpen(false),
    toggleTooltip: () => setOpen((o) => !o),
  };
}

// Portal-rendered bubble. Always mounted once on the client (visibility
// toggled via opacity) so `bubbleRef` has real dimensions to measure as soon
// as it opens, and so the same fade/scale transition the old group-hover
// version had still applies. `position: fixed` + document.body means no
// ancestor's overflow can ever clip it.
export function TooltipBubble({
  bubbleRef,
  pos,
  open,
  children,
}: {
  bubbleRef: React.RefObject<HTMLDivElement | null>;
  pos: Position | null;
  open: boolean;
  children: React.ReactNode;
}) {
  // Reason: gating on `typeof document` alone causes a hydration mismatch —
  // during hydration React's first client render already runs in the browser
  // (document exists), so it would emit this portal even though the actual
  // server-rendered HTML (rendered in Node, no document) never included it.
  // Gating on a mounted flag set by an effect instead means BOTH the server
  // render and the initial client (hydration) render agree on rendering
  // nothing; the portal only appears in a later, effect-driven update, which
  // hydration doesn't check against.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const visible = open && pos !== null;
  const scaleTransform = pos?.placement === "above" ? "translateY(-100%)" : undefined;
  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      aria-hidden={!visible}
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        transform: scaleTransform,
      }}
      className={`pointer-events-none z-50 w-72 max-w-[calc(100vw-2rem)] whitespace-normal break-words rounded-lg border border-line bg-card p-2.5 text-xs font-normal normal-case leading-snug tracking-normal text-ink3 shadow-lg transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      {children}
    </div>,
    document.body
  );
}
