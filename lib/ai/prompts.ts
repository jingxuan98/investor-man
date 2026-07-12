import { StockBundle } from "@/lib/data/getStockData";
import { fmtBig } from "@/lib/format";
import { reverseDcf } from "@/lib/finance/insights";
import { buildStory } from "@/lib/finance/story";

export type ReportType =
  | "research"
  | "model3"
  | "bear"
  | "bull"
  | "risks"
  | "deepdive"
  | "story"
  | "playbook";

// Shared, machine-verified financial context prepended to every prompt so the
// model reasons from OUR numbers (matching the valuation/metrics pages) rather
// than hallucinating its own historical figures.
function dataBlock(b: StockBundle): string {
  const s = b.snapshot;
  const rows = [...s.years].reverse().map((y) =>
    [
      y.year,
      `revenue ${fmtBig(y.revenue)}`,
      `grossProfit ${fmtBig(y.grossProfit)}`,
      `operatingIncome ${fmtBig(y.operatingIncome)}`,
      `netIncome ${fmtBig(y.netIncome)}`,
      `operatingCF ${fmtBig(y.operatingCashFlow)}`,
      `capex ${fmtBig(y.capex)}`,
      `freeCF ${fmtBig(y.freeCashFlow)}`,
      `totalDebt ${fmtBig(y.totalDebt)}`,
      `cash ${fmtBig(y.cash)}`,
      `equity ${fmtBig(y.equity)}`,
    ].join(", ")
  );
  return (
    // Today's date anchors the timeline: without it a non-grounded fallback
    // model (gemma — no search access) silently assumes its training-cutoff
    // year and presents stale "current" catalysts/sentiment as if live.
    `TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}. If you do not have live web search access, any market events/news you recall may predate today — date such claims explicitly and say they may be outdated.\n` +
    `VERIFIED FINANCIAL DATA for ${s.name} (${s.ticker}), currency ${s.currency}, ` +
    `current price ${s.price}, market cap ${fmtBig(s.marketCap)}, trailing EPS ${s.trailingEPS}, beta ${s.beta}:\n` +
    rows.join("\n") +
    `\nOur composite intrinsic value estimate: ${b.valuation.composite?.toFixed(2) ?? "n/a"} per share.\n` +
    `Use these numbers as the historical record — do NOT invent different historical figures.\n\n`
  );
}

// Appended to every prompt so streamed output renders cleanly in the markdown viewer.
const MARKDOWN_INSTRUCTION =
  "\n\nFormat the entire response as clean Markdown with ## section headings and tables where appropriate. " +
  "Never use LaTeX or math notation (no \\times, \\mathbf, $...$ math spans) — the viewer renders plain Markdown only; write math as plain text, e.g. 0.30 × 789.68 + 0.50 × 660.10 = 653.11.";

function researchPrompt(b: StockBundle): string {
  const s = b.snapshot;
  return (
    `You are a financial analyst conducting a comprehensive investment research report on ${s.name} (${s.ticker}), combining Aswath Damodaran's "story and numbers" discipline, Philip Fisher's quality screen, Michael Porter's competitive-forces analysis, Michael Mauboussin's base-rate thinking, and Howard Marks's second-level thinking.\n` +
    `ROLE: Every claim must be evidence-based. Distinguish clearly between facts, inferences, and speculation.\n` +
    `1. THE STORY — What business is ${s.name} really in, and what is the narrative the market currently believes about its growth, competitive position, and destiny?\n` +
    `2. DO THE NUMBERS CORROBORATE THE STORY — Test that narrative against the VERIFIED FINANCIAL DATA above: revenue growth, margin trend, reinvestment (capex vs. free cash flow), and returns on capital. Does the data support the story, or contradict it?\n` +
    `3. FISHER QUALITY SCREEN — Applying Philip Fisher's 15 points, evaluate the ones most measurable from the data and public information: sales growth runway, margin durability, R&D/innovation productivity, and management's execution track record.\n` +
    `4. COMPETITIVE POSITION (Porter) — Five forces, condensed: who holds pricing power (the company, its customers, or its suppliers), how strong are entry barriers, and how real is substitute risk? Name the single biggest competitive threat.\n` +
    `5. BASE-RATE CHECK (Mauboussin) — Compare the growth the story requires against historical base rates: of companies at ${s.name}'s current revenue scale, how many have EVER sustained that growth rate for 5-10 years? Be specific about how rare that outcome is.\n` +
    `6. SECOND-LEVEL VIEW (Marks) — What does consensus believe about ${s.ticker}? Where specifically do you differ, and why is consensus wrong rather than merely different?\n` +
    `7. VERDICT — The expectations gap: is the price paying for a story the numbers actually support? Assess the asymmetry of the risk/reward and name the key metrics to watch.`
  );
}

function model3Prompt(b: StockBundle): string {
  const s = b.snapshot;
  const n = s.years.length;
  return (
    `You are a financial analyst building an integrated 3-statement model for ${s.name} (${s.ticker}).\n` +
    `RULES: Never fabricate numbers. Use the VERIFIED FINANCIAL DATA above as the historical record; cite it as "company filings via Yahoo Finance". Label every assumption as [ASSUMPTION] with a one-line reason.\n` +
    `STEP 1 — HISTORICAL DATA: present the income statement, balance sheet and cash-flow items from the VERIFIED FINANCIAL DATA as your historical base (last ${n} fiscal years).\n` +
    `STEP 2 — REVENUE PROJECTIONS (years 1–5): [ASSUMPTION] growth rate per year based on historical CAGR. Show the math: prior revenue × (1 + growth rate). Scenarios: Bear (−5%) / Base / Bull (+5%). BASE-RATE SANITY CHECK: how does the Base-case growth rate compare to what companies of ${s.name}'s current revenue size have historically sustained over 5-10 years? Flag it if the Base case requires historically rare performance.\n` +
    `STEP 3 — INCOME STATEMENT: [ASSUMPTION] 3-year averages for gross margin %, operating cost ratios, tax rate. Calculate net income per projected year.\n` +
    `STEP 4 — BALANCE SHEET: [ASSUMPTION] historical averages for working-capital behavior. Check every year: Assets = Liabilities + Equity.\n` +
    `STEP 5 — CASH FLOW: Net income + depreciation − capex [ASSUMPTION: % of revenue] = free cash flow. Ending cash must tie to the balance sheet.\n` +
    `STEP 6 — OUTPUT: All 3 statements as markdown tables: ${n} historical + 5 projected years. Include assumptions table and Year-5 FCF sensitivity at ±3% growth. Assign explicit probability weights to the Bear / Base / Bull scenarios (they must sum to 100%), and close with a single probability-weighted intrinsic value per share, showing the weighted-average math.`
  );
}

function bearPrompt(b: StockBundle): string {
  const s = b.snapshot;
  const price = s.price;
  return (
    `You are writing a bear case on ${s.name} (${s.ticker}) at ${price}, framed as a Charlie Munger-style PRE-MORTEM: it is three years from now and ${s.ticker} has been a disastrous investment from ${price} — write the post-mortem BEFORE it happens. Invert the problem: instead of asking how to succeed, work backward from failure. Do NOT be balanced — argue the most credible, evidence-based downside. Be direct. Every claim must be evidence-based; distinguish clearly between facts, inferences, and speculation.\n` +
    `1. THE OBITUARY — One paragraph: how is this disaster remembered three years from now? Give the one sentence that sums up what went wrong.\n` +
    `2. WHAT THE PRICE REQUIRED — What growth, margins, and outcomes were embedded in ${price}? This is the bull case that had to come true — and didn't.\n` +
    `3. THE FAILURE CHAIN — Inverting the problem, identify the 2–3 assumption breaks that caused the disaster, ordered most-fragile-first. Which assumption was always the shakiest?\n` +
    `4. ACCOUNTING & REVENUE QUALITY RED FLAGS — Examine the VERIFIED FINANCIAL DATA above right now for warning signs visible today: receivables growth vs. revenue growth, stock-based compensation, margin sustainability, and cash conversion (net income vs. free cash flow).\n` +
    `5. THE NUMBERS OF THE DISASTER — Build the bear-case revenue and margin path, apply a compressed multiple, and derive a price target. Show the multiple used and the revenue assumption. What is the % downside from ${price}?\n` +
    `6. WHAT THE MARKET IS IGNORING TODAY — Name the single underappreciated threat that consensus is not pricing in, and why the market is ignoring it.\n` +
    `7. THE TRIPWIRE — State the single metric or event that would have warned you before the disaster fully played out. This is your exit signal — know it before you trade.`
  );
}

function bullPrompt(b: StockBundle): string {
  const s = b.snapshot;
  const price = s.price;
  return (
    `You are writing a bull case on ${s.name} (${s.ticker}) at ${price}, applying Michael Steinhardt's VARIANT PERCEPTION framework: an edge only exists if you believe something specific and different from consensus, and can explain why consensus is wrong. Do NOT be balanced — argue the most credible, evidence-based upside. Be direct. Every claim must be evidence-based; distinguish clearly between facts, inferences, and speculation.\n` +
    `1. CONSENSUS TODAY — What growth, margins, and outcomes does ${price} say the market believes? This is the hurdle the bulls need to beat.\n` +
    `2. THE VARIANT VIEW — What specifically does the market misunderstand about ${s.name}? Why does the mispricing exist — is there a forced or structural seller, an index/screening blind spot, or a specific behavioral bias driving it?\n` +
    `3. WHERE THE BUSINESS COMPOUNDS — Identify the 2–3 strongest, most durable competitive advantages, each backed by evidence. What structurally lets this business keep winning?\n` +
    `4. THE EXPECTATIONS REVISION PATH (Mauboussin) — Which coming results specifically would force consensus to revise its numbers upward? Give a realistic timeline.\n` +
    `5. OPERATING LEVERAGE & MARGIN UPSIDE: If revenue outperforms, what happens to costs and margins? Are costs fixed or variable? Show the numbers on how much operating leverage falls to the bottom line.\n` +
    `6. UPSIDE TARGET — Bull-case valuation using higher revenue and an appropriate multiple. Show the multiple used and the revenue assumption. What is the % upside from ${price}?\n` +
    `7. WHAT KILLS IT — State the honest disconfirming evidence: the single event or metric that would invalidate this thesis. This is your exit signal — know it before you trade.`
  );
}

function risksPrompt(b: StockBundle): string {
  const s = b.snapshot;
  return (
    `You are compiling a Key Risks report on ${s.name} (${s.ticker}), using Howard Marks's definition of risk: risk is the probability of permanent capital loss, not volatility or price fluctuation. Apply Charlie Munger's lenses on human misjudgment throughout, especially incentive-caused bias. Be direct and specific; every claim must be evidence-based — back it with data from the VERIFIED FINANCIAL DATA above where possible.\n` +
    `Enumerate and RANK the risks, most severe first, across these categories: regulatory risk, concentration risk, competitive risk, execution risk, valuation-compression risk, plus 1–2 company-specific risks the data suggests.\n` +
    `For EACH risk, give:\n` +
    `- Mechanism: exactly how this risk would hurt the business or the stock\n` +
    `- Probability: High / Medium / Low\n` +
    `- Severity: the permanent-loss potential if it hits — not a volatility guess\n` +
    `- Incentive angle (Munger): who benefits from this risk being hidden or created — management compensation structure, agency problems, or other misaligned incentives\n` +
    `- Metric to watch: the specific figure to track (use the VERIFIED data above where possible — e.g. a margin, a growth rate, a debt ratio)\n` +
    `- Confirming signal: what reading in that metric would tell you the risk is materializing\n` +
    `Present the ranked risks as a markdown table (Risk | Probability | Severity | Mechanism | Incentive Angle | Metric to Watch | Confirming Signal), then close with a one-paragraph summary naming the single biggest risk to permanent capital.`
  );
}

// Appends a compact methods table (name: value-or-n/a) built from the ALREADY
// COMPUTED bundle.valuation.models, so the deep-dive prompt reasons about our
// actual current outputs rather than re-deriving or hallucinating them.
function methodsTableBlock(b: StockBundle): string {
  const rows = b.valuation.models.map(
    (m) => `${m.name}: ${m.value !== null ? m.value.toFixed(2) : "n/a"}`
  );
  return `OUR 10 VALUATION METHODS (current per-share output):\n${rows.join("\n")}\n\n`;
}

function deepdivePrompt(b: StockBundle): string {
  const s = b.snapshot;
  return (
    `You are writing a Valuation Deep-Dive on ${s.name} (${s.ticker}) using the Expectations Investing framework (Mauboussin/Rappaport): work backward from the price to find what the market must believe, then judge whether that belief is reasonable. Walk through OUR 10 valuation methods listed above (their current per-share outputs are given) — do NOT recompute or replace them with your own numbers. Every claim must be evidence-based; distinguish clearly between facts, inferences, and speculation.\n` +
    `1. PRICE-IMPLIED EXPECTATIONS — Reading the outputs in the methods table above (especially the DCF-style methods), state what sales growth, margin, and capital-intensity assumptions the current price of ${s.price} requires to be justified.\n` +
    `2. BASE-RATE TEST — How rare is that implied performance for a company ${s.name}'s size? Compare against how few companies at this revenue scale have historically sustained similar growth for 5–10 years.\n` +
    `3. VALUE-DRIVER DECOMPOSITION — For THIS business model, which single driver — revenue growth, margin, or capital intensity (capex/working capital) — moves intrinsic value the most? Where specifically could an expectations revision, up or down, come from?\n` +
    `4. METHOD TRIAGE — Walk through our 10 methods' current outputs, citing the specific inputs from the VERIFIED FINANCIAL DATA above: which 2–3 deserve the most weight for this business model and why (cash-flow stability, multiple availability, growth durability)? Which methods should be distrusted here, and why?\n` +
    `5. SENSITIVITY TABLE — Build a markdown table sensitizing the headline DCF (DCF-20) to growth ±5pp (5 columns) and discount rate ±2pp (5 rows), labeling each row/column with the actual rate used.\n` +
    `6. THE VERDICT — Are the price-implied expectations too high, too low, or about right? State the specific result or metric that would force a revision.`
  );
}

// The Story tab's "Draft with AI" enrichment: takes OUR machine-drafted
// blocks 1-3 (The Answer / The Narrative / The Thesis, from lib/finance/story.ts
// — no AI involved in producing them) and asks the model for an editorial
// pass only. Numbers must survive unchanged; this is a rewrite, not a report.
function storyPrompt(b: StockBundle): string {
  const story = buildStory(b, reverseDcf(b.snapshot));
  const draft = [
    "BLOCK 1 — THE ANSWER",
    story.answer,
    "",
    "BLOCK 2 — THE NARRATIVE",
    ...story.narrative,
    "",
    "BLOCK 3 — THE THESIS, NUMBERED",
    ...story.thesis.map((t, i) => `${i + 1}. ${t.title}: ${t.body}`),
  ].join("\n");
  return (
    `Below is a machine-drafted analyst note for ${b.snapshot.name} (${b.snapshot.ticker}), generated directly from our valuation model with no AI involved yet:\n\n` +
    draft +
    `\n\nRewrite blocks 1-3 above as a professional but plain-English analyst note. Keep every number exactly as given — do not invent, round differently, or add any fact not present above. Preserve the three-block structure (The Answer, The Narrative, The Thesis) but improve the prose.` +
    `\n\nThen APPEND one extra block:\nBLOCK 2B — MARKET NARRATIVES\nTwo short subsections describing what investors CURRENTLY believe about ${b.snapshot.ticker} (use recent news, earnings reactions and commentary if search is available; otherwise infer honestly from the data above and say so):\n- **The bull narrative** — the story buyers at today's price are telling; the 2-3 strongest arguments supporting it, and which single metric above would CONFIRM it.\n- **The bear narrative** — the skeptics' story; its 2-3 strongest arguments, and which single metric above would confirm THAT.\nEnd with one sentence on which narrative our model's numbers currently side with, and why.`
  );
}

// "The Playbook" — modeled on a reference product's live trade-brief report
// (structure/content patterns only, no wording reused): a catalyst calendar,
// probability-weighted scenario analysis, ranked key risks, and a market-
// narrative synthesis. Deliberately drops that reference's technical-analysis
// sections (chart patterns, entry/exit tranches) — out of scope here, this is
// a fundamentals-anchored playbook, not a trade trigger. Blends professional
// sell-side framework patterns (catalyst calendars tied to thesis pillars,
// genuine-not-fantastical bear/bull scenarios, risk sections that explain WHY
// a risk may or may not materialize) with our own Damodaran/Mauboussin/Marks
// house style and the "do NOT invent figures" discipline from dataBlock.
function playbookPrompt(b: StockBundle): string {
  const s = b.snapshot;
  const price = s.price;
  return (
    `You are building "The Playbook" for ${s.name} (${s.ticker}) at ${price} — a field guide to what happens next: a catalyst calendar, probability-weighted scenarios, ranked risks, and what the market currently believes. Every claim must be evidence-based; distinguish clearly between facts, inferences, and speculation. Anchor every price figure to OUR valuation numbers above (the composite estimate and the methods table) — never invent a multiple or a price target unconnected to them.\n` +
    `## CATALYST CALENDAR\n` +
    `Build a forward-looking, dated calendar of the events most likely to move the stock over the next 12 months. Start with the next scheduled earnings report (infer a realistic date/window from the VERIFIED FINANCIAL DATA above's fiscal-year cadence), then use search to find concrete upcoming product, regulatory, litigation, and industry events (e.g. regulatory decisions, contract or product milestones, index-inclusion or lockup windows, competitor catalysts). For EACH event give: **Date/window** — as precise as the evidence allows; **What to watch** — the specific data point or outcome that resolves it; **Expected directional impact** — bullish, bearish, or two-sided, and why; **How to read the market's reaction** — what a strong vs. weak market response to it would each signal about whether the thesis is intact.\n` +
    `## SCENARIO ANALYSIS\n` +
    `Construct Bear / Base / Bull scenarios, each assigned an explicit probability (they must sum to 100%). The Bear case should be a genuine downside risk, not the absolute worst case; the Bull case should be achievable, not fantasy. For EACH scenario give: a 12-MONTH PRICE TARGET derived from OUR valuation methods above — cite which method(s), or the composite, it is anchored to, and show the math from ${price} to the target (do NOT invent a new multiple or discount rate); the 2-3 THINGS THAT MUST HAPPEN for that scenario to be the one that plays out; and the EARLIEST OBSERVABLE SIGNAL — the first concrete data point that would tell you, ahead of the full outcome, that this scenario is the one materializing. Close with the probability-weighted 12-month target, showing the weighted-average math.\n` +
    `## KEY RISKS\n` +
    `Using Howard Marks's definition of risk (the probability of permanent capital loss, not volatility), rank the 4-5 risks most likely to break THIS specific thesis, most severe first. Don't just list them — explain why each may or may not materialize. For EACH risk give: **Mechanism** — exactly how it would hurt the business or the stock; **Severity** — the permanent-loss potential if it hits; **Watch metric** — the single figure to track (use the VERIFIED data above where possible) that would confirm the risk is materializing.\n` +
    `## MARKET NARRATIVE\n` +
    `Synthesize what the market is saying about ${s.ticker} RIGHT NOW (use recent news, earnings reactions, and analyst commentary from search; if search is unavailable, infer honestly from the data above and say so). Cover: **What the bulls have been saying recently** — the 2-3 strongest current arguments buyers are making; **What the bears have been saying recently** — the 2-3 strongest current counter-arguments; **If the thesis breaks** — for a stock positioned like this, describe how the unwind typically plays out: which holders sell first, whether the multiple or the estimates give way first, and what the mirror image of the bull catalysts above looks like when they disappoint instead of deliver.`
  );
}

// Builds the full prompt (data block + report body + markdown instruction) and
// declares whether Google Search grounding should be enabled for this type.
export function buildPrompt(
  type: ReportType,
  bundle: StockBundle
): { prompt: string; grounding: boolean } {
  const block = dataBlock(bundle);
  switch (type) {
    case "research":
      return { prompt: block + researchPrompt(bundle) + MARKDOWN_INSTRUCTION, grounding: true };
    case "model3":
      return { prompt: block + model3Prompt(bundle) + MARKDOWN_INSTRUCTION, grounding: false };
    case "bear":
      return { prompt: block + bearPrompt(bundle) + MARKDOWN_INSTRUCTION, grounding: true };
    case "bull":
      return { prompt: block + bullPrompt(bundle) + MARKDOWN_INSTRUCTION, grounding: true };
    case "risks":
      return { prompt: block + risksPrompt(bundle) + MARKDOWN_INSTRUCTION, grounding: true };
    case "deepdive":
      return {
        prompt: block + methodsTableBlock(bundle) + deepdivePrompt(bundle) + MARKDOWN_INSTRUCTION,
        grounding: false,
      };
    case "story":
      // Grounding on: BLOCK 2B asks for CURRENT market narratives, which need
      // recent news/commentary. Non-gemini fallbacks silently drop grounding
      // (see lib/ai/gemini.ts) and the prompt tells the model to infer honestly.
      return { prompt: block + storyPrompt(bundle) + MARKDOWN_INSTRUCTION, grounding: true };
    case "playbook":
      // Grounding on: the catalyst calendar and market narrative both need
      // current search results (upcoming events, recent commentary).
      return {
        prompt:
          block + methodsTableBlock(bundle) + playbookPrompt(bundle) + MARKDOWN_INSTRUCTION,
        grounding: true,
      };
  }
}

export const REPORT_TYPES: ReportType[] = [
  "research",
  "model3",
  "bear",
  "bull",
  "risks",
  "deepdive",
  "story",
  "playbook",
];

export function isReportType(v: unknown): v is ReportType {
  return typeof v === "string" && (REPORT_TYPES as string[]).includes(v);
}
