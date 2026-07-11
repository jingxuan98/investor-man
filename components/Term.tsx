import { glossary } from "@/lib/glossary";

// Hover-glossary wrapper for a technical label. Pure CSS (group-hover), so
// this is safe to use from server components too — no client boundary
// needed. The custom card below is the only tooltip UI; `aria-label` (not
// `title`) carries the same text for assistive tech so we never show a
// native browser tooltip stacked on top of the custom one.
// Renders children unwrapped if the key isn't in the glossary, so a typo
// degrades gracefully instead of throwing.
export default function Term({ k, children }: { k: string; children: React.ReactNode }) {
  const def = glossary[k];
  if (!def) return <>{children}</>;

  return (
    <span
      className="group relative inline-block cursor-help border-b border-dotted border-ink2/60"
      aria-label={def}
    >
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] origin-top-left scale-95 whitespace-normal break-words rounded-lg border border-line bg-card p-2.5 text-xs font-normal normal-case leading-snug tracking-normal text-ink3 opacity-0 shadow-lg transition-all duration-150 group-hover:scale-100 group-hover:opacity-100"
      >
        {def}
      </span>
    </span>
  );
}
