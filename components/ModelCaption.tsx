"use client";

import { formatModelCaption } from "@/lib/modelCaption";

// Muted caption rendered above every AI-generated report/draft, naming which
// model in the chain actually served the request (see lib/ai/gemini.ts's
// ChainResult) and whether it came from cache. Renders nothing until a
// model is known (e.g. before the first response header arrives).
export default function ModelCaption({
  model,
  cached,
}: {
  model: string | null;
  cached: boolean;
}) {
  const text = formatModelCaption(model, cached);
  if (!text) return null;
  return <p className="mb-2 text-xs text-ink2">{text}</p>;
}
