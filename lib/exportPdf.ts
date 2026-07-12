// Client-only "export to PDF" via the browser's native print pipeline: no new
// dependency, no server round-trip. Opens a blank tab, writes a minimal
// self-contained document (title + the report-md typography rules inlined,
// copied from app/globals.css, capped at 720px and centered) with the
// already-rendered report markup, then calls print() once the tab has
// loaded so the user can pick "Save as PDF" from the print dialog.

// Kept in sync with the .report-md rules in app/globals.css. Duplicated
// (not imported) because this string is injected into a brand-new document
// that never loads our stylesheet.
const REPORT_MD_CSS = `
.report-md {
  font-size: 0.925rem;
  line-height: 1.65;
  color: #44443f;
}
.report-md h1,
.report-md h2,
.report-md h3 {
  font-weight: 600;
  line-height: 1.3;
  margin: 1.25rem 0 0.6rem;
  color: #1a1a18;
}
.report-md h1 { font-size: 1.35rem; }
.report-md h2 { font-size: 1.15rem; }
.report-md h3 { font-size: 1rem; }
.report-md h1:first-child,
.report-md h2:first-child,
.report-md h3:first-child { margin-top: 0; }
.report-md p { margin: 0.6rem 0; }
.report-md ul,
.report-md ol { margin: 0.6rem 0; padding-left: 1.4rem; }
.report-md ul { list-style: disc; }
.report-md ol { list-style: decimal; }
.report-md li { margin: 0.2rem 0; }
.report-md strong { font-weight: 600; }
.report-md a { color: #2c5e8a; text-decoration: underline; }
.report-md code {
  background: #f6f6f5;
  padding: 0.1rem 0.3rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
}
.report-md pre {
  background: #f6f6f5;
  padding: 0.75rem;
  border-radius: 0.4rem;
  overflow-x: auto;
}
.report-md pre code { background: none; padding: 0; }
.report-md blockquote {
  border-left: 3px solid #eceae6;
  padding-left: 0.8rem;
  color: #8a887f;
  margin: 0.6rem 0;
}
.report-md table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8rem 0;
  font-size: 0.85rem;
}
.report-md th,
.report-md td {
  border: 1px solid #eceae6;
  padding: 0.4rem 0.6rem;
  text-align: left;
}
.report-md th { background: #fbfbfa; font-weight: 600; }
.report-md hr {
  border: none;
  border-top: 1px solid #eceae6;
  margin: 1.2rem 0;
}
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Opens a print-ready window for a rendered report. `caption` is the same
// model-attribution line shown on-screen above the report (e.g. "✦
// AI-generated · model: gemini-2.5-flash") — optional so callers that export
// something with no AI attribution (none today, but keeps the signature
// honest) can omit it. Returns false (and lets the caller show a note) when
// the popup was blocked instead of throwing.
export function exportReportPdf(title: string, contentHtml: string, caption?: string): boolean {
  const win = window.open("", "_blank");
  if (!win) return false;

  win.document.open();
  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    color: #1a1a18;
    max-width: 720px;
    margin: 2rem auto;
    padding: 0 1.5rem;
  }
  h1.export-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 0 0 0.4rem;
  }
  p.export-caption {
    font-size: 0.8rem;
    color: #8a887f;
    margin: 0 0 1.1rem;
  }
  ${REPORT_MD_CSS}
  @media print {
    body { margin: 0 auto; }
  }
</style>
</head>
<body>
  <h1 class="export-title">${escapeHtml(title)}</h1>
  ${caption ? `<p class="export-caption">${escapeHtml(caption)}</p>` : ""}
  <article class="report-md">${contentHtml}</article>
</body>
</html>`);
  win.document.close();

  win.onload = () => win.print();
  // Some browsers fire onload before write() has been fully parsed when the
  // document was written via document.write; a fallback timer covers that.
  setTimeout(() => win.print(), 300);

  return true;
}
