"use client";

import { formatModelCaption } from "@/lib/modelCaption";

// Muted caption rendered above every AI-generated report/draft, naming which
// model in the chain actually served the request (see lib/ai/gemini.ts's
// ChainResult) and whether it came from cache. Renders nothing until a
// model is known (e.g. before the first response header arrives).
//
// `grounded` = this report type is supposed to use live Google Search
// (playbook/story/research/bear/bull/risks). Only gemini-* models can ground;
// when a fallback like gemma served such a report, its "current" catalysts /
// sentiment come from training data (~2025 cutoff) — warn the user so a stale
// narrative is never mistaken for live market info.
export default function ModelCaption({
  model,
  cached,
  grounded = false,
}: {
  model: string | null;
  cached: boolean;
  grounded?: boolean;
}) {
  const text = formatModelCaption(model, cached);
  if (!text) return null;
  const noLiveSearch = grounded && !!model && !model.startsWith("gemini");
  return (
    <div className="mb-2">
      <p className="text-xs text-ink2">{text}</p>
      {noLiveSearch && (
        <p className="mt-1 rounded-md bg-amber-tint px-2 py-1 text-xs text-amber">
          ⚠ This model has no live web search — news, catalysts and sentiment
          may reflect its training data (≈2025), not today. Regenerate later
          for a gemini-flash version with live search.
        </p>
      )}
    </div>
  );
}
