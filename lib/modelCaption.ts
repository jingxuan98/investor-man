// Shared text for the model-attribution caption shown above every AI-
// generated report (every AI output surface must state which model produced
// it). A pure string builder so the on-screen caption (components/
// ModelCaption.tsx) and the PDF export header (lib/exportPdf.ts) render
// identical text instead of two copies drifting apart.
export function formatModelCaption(model: string | null, cached: boolean): string | null {
  if (!model) return null;
  return `✦ AI-generated · model: ${model}${cached ? " · cached" : ""}`;
}
