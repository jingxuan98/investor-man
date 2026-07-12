// Defensive preprocessing for AI-streamed markdown before it reaches
// react-markdown + remark-gfm (see components/ResearchClient.tsx and
// components/StoryDraft.tsx). GFM tables require an explicit delimiter row
// (`| --- | --- |`) right after the header row — without it, remark-gfm
// doesn't recognize the block as a table at all and renders the raw pipe
// characters as a plain paragraph, which looks broken. Weaker fallback
// models (see lib/ai/gemini.ts's model chain, e.g. gemma-4-31b-it) sometimes
// drop that row. This scans for that specific shape and inserts the missing
// delimiter, inferring column count from the header row.
//
// Deliberately narrow: only fixes the "header row immediately followed by
// another pipe-row, no delimiter in between" case. Anything else exotic
// (tables nested in bold headers, HTML fragments, etc.) is left alone —
// remark-gfm just renders it as plain text rather than a table, which is
// ugly but never crashes the viewer. Wrapped in try/catch as a last resort so
// a bug in this heuristic can never break report rendering.

const FENCE_RE = /^\s*(```|~~~)/;
const DELIMITER_ROW_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function countPipes(line: string): number {
  return (line.match(/\|/g) ?? []).length;
}

// A candidate table row: at least two pipes (i.e. at least a 1-column table
// with leading/trailing pipes, or 2+ bare-separated cells). A single stray
// "|" in a sentence never qualifies, so ordinary prose is left untouched.
function looksLikeRow(line: string | undefined): boolean {
  if (line === undefined) return false;
  const t = line.trim();
  if (!t) return false;
  return countPipes(t) >= 2;
}

function headerColumnCount(line: string): number {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const cells = t.split("|");
  return Math.max(cells.length, 1);
}

function delimiterRow(cols: number): string {
  return "| " + Array(cols).fill("---").join(" | ") + " |";
}

export function normalizeMarkdownTables(markdown: string): string {
  try {
    const lines = markdown.split("\n");
    const out: string[] = [];
    let inFence = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        out.push(line);
        i++;
        continue;
      }
      if (inFence || !looksLikeRow(line)) {
        out.push(line);
        i++;
        continue;
      }

      const next = lines[i + 1];
      const nextIsDelimiter = next !== undefined && DELIMITER_ROW_RE.test(next);
      const nextIsRow = looksLikeRow(next);

      if (!nextIsDelimiter && !nextIsRow) {
        // A lone pipe-bearing line with no continuation — not a table.
        out.push(line);
        i++;
        continue;
      }

      // Header row of a table (well-formed or missing its separator).
      out.push(line);
      i++;
      if (nextIsDelimiter) {
        out.push(lines[i]); // the real delimiter, untouched
        i++;
      } else {
        out.push(delimiterRow(headerColumnCount(line)));
      }
      // Consume the rest of the table's body rows as-is.
      while (i < lines.length && !FENCE_RE.test(lines[i]) && looksLikeRow(lines[i])) {
        out.push(lines[i]);
        i++;
      }
    }
    return out.join("\n");
  } catch {
    // Never let a normalization bug break the viewer — worst case, remark-gfm
    // sees the raw text and renders it as a plain paragraph.
    return markdown;
  }
}
