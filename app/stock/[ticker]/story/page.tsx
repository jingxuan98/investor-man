import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import { reverseDcf } from "@/lib/finance/insights";
import { buildStory } from "@/lib/finance/story";
import { fmtMoney, fmtPct } from "@/lib/format";
import StoryDraft from "@/components/StoryDraft";

function Kicker({ index, title }: { index: string; title: string }) {
  return (
    <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink2">
      {index} · {title}
    </p>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="card p-6">{children}</section>;
}

const BEAR_BASE_BULL_SUBTITLE: Record<"BEAR" | "BASE" | "BULL", string> = {
  BEAR: "Lowest survivor",
  BASE: "Trimmed composite",
  BULL: "Highest survivor",
};

export default async function StoryPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  // Guard again here (not just in the layout): notFound() thrown from a
  // parent layout does not trigger a not-found.tsx in that same segment
  // (Next.js caveat), so the page itself must also validate the ticker for
  // our custom not-found UI to render instead of the framework default.
  let bundle;
  try {
    bundle = await getStockBundle(ticker);
  } catch {
    notFound();
  }
  const { snapshot: s, valuation: v } = bundle;
  const reverse = reverseDcf(s);
  const story = buildStory(bundle, reverse);

  const upside = v.composite !== null ? v.composite / s.price - 1 : null;
  const upsideClass = upside === null ? "text-ink2" : upside >= 0 ? "text-green" : "text-red";

  const activeZone = story.zones?.find((z) => z.active) ?? null;
  const zoneLabel = activeZone ? activeZone.label.split(" —")[0].toUpperCase() : "N/A";

  const catalystDate = s.nextEarningsDate
    ? new Date(s.nextEarningsDate)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toUpperCase()
    : null;

  return (
    <div className="space-y-6">
      {/* Header strip */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3">
          <span className="chip chip-neutral">MACHINE-DRAFTED · NOT ANALYST-REVIEWED</span>
          {catalystDate && (
            <span className="text-xs font-medium text-ink2">
              NEXT CATALYST: {catalystDate} · earnings
            </span>
          )}
        </div>
        <div className="flex flex-col divide-y divide-line sm:flex-row sm:divide-x sm:divide-y-0">
          <div className="kpi-cell flex-1">
            <p className="kpi-label">Today</p>
            <p className="num kpi-value">{fmtMoney(s.price, s.currency)}</p>
          </div>
          <div className="kpi-cell flex-1">
            <p className="kpi-label">Zone</p>
            <p className="num kpi-value">{zoneLabel}</p>
          </div>
          <div className="kpi-cell flex-1">
            <p className="kpi-label">Gap to composite</p>
            <p className={`num kpi-value ${upsideClass}`}>{fmtPct(upside)}</p>
          </div>
        </div>
      </div>

      <Card>
        <Kicker index="BLOCK 1" title="The Answer" />
        <p className="text-ink3">{story.answer}</p>
      </Card>

      <Card>
        <Kicker index="BLOCK 2" title="The Narrative" />
        <div className="space-y-3 text-ink3">
          {story.narrative.length === 0 ? (
            <p className="italic text-ink2">n/a — insufficient data for a narrative.</p>
          ) : (
            story.narrative.map((p, i) => <p key={i}>{p}</p>)
          )}
        </div>
        <div className="mt-6 border-t border-line pt-6">
          <StoryDraft ticker={s.ticker} />
        </div>
      </Card>

      <Card>
        <Kicker index="BLOCK 3" title="The Thesis, Numbered" />
        <ol className="space-y-4">
          {story.thesis.map((t, i) => (
            <li key={i} className="flex gap-3">
              <span className="num flex h-6 w-6 flex-none items-center justify-center rounded-full bg-track text-xs font-semibold text-ink3">
                {i + 1}
              </span>
              <div>
                <p className="font-medium text-ink">{t.title}</p>
                <p className="mt-1 text-sm text-ink3">{t.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <Kicker index="BLOCK 4" title="What It's Worth" />
        {story.bearBaseBull === null ? (
          <p className="italic text-ink2">
            n/a — fewer than five valuation methods survived, so no bear/base/bull range is
            defined.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {story.bearBaseBull.map((x) => (
              <div
                key={x.label}
                className={`rounded-xl border p-4 ${
                  x.label === "BASE" ? "border-accent" : "border-line"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-ink2">
                  {x.label} · {BEAR_BASE_BULL_SUBTITLE[x.label]}
                </p>
                <p className="num mt-1 text-xl font-semibold text-ink">
                  {fmtMoney(x.value, s.currency)}
                </p>
                <p
                  className={`num mt-1 text-sm font-medium ${x.fromHerePct >= 0 ? "text-green" : "text-red"}`}
                >
                  {x.fromHerePct >= 0 ? "+" : ""}
                  {x.fromHerePct.toFixed(0)}% from here
                </p>
                <p className="mt-2 text-sm text-ink2">{x.caption}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <Kicker index="BLOCK 5" title="The Plan" />
        {story.zones === null ? (
          <p className="italic text-ink2">n/a — no valid price zones for this stock.</p>
        ) : (
          <ul className="divide-y divide-line">
            {story.zones.map((z) => (
              <li
                key={z.label}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-3 ${
                  z.active ? "border border-accent bg-accent-tint" : ""
                }`}
              >
                <p className="font-medium text-ink">{z.label}</p>
                <div className="flex items-center gap-2">
                  <span className="num text-sm text-ink3">{z.range}</span>
                  {z.active && <span className="chip chip-accent">YOU ARE HERE</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <Kicker index="BLOCK 6" title="Kill Criteria" />
        <ul className="divide-y divide-line">
          {story.killCriteria.map((k) => (
            <li key={k.title} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{k.title}</p>
                  <p className="mt-1 text-sm text-ink3">{k.description}</p>
                  <p className="num mt-1 text-sm text-ink2">{k.reading}</p>
                </div>
                <span className={`chip flex-none ${k.breached ? "chip-neg" : "chip-neutral"}`}>
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${k.breached ? "bg-red" : "bg-ink2"}`}
                    aria-hidden
                  />
                  {k.breached ? "BREACHED" : "DORMANT"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <Kicker index="BLOCK 7" title="Risks, Ranked" />
        <ul className="divide-y divide-line">
          {story.risks.map((r) => (
            <li key={r.title} className="py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink2">
                  {r.tag}
                </span>
                <span className={`chip ${r.severity === "HIGH" ? "chip-neg" : "chip-warn"}`}>
                  {r.severity}
                </span>
              </div>
              <p className="mt-2 font-medium text-ink">{r.title}</p>
              <p className="mt-1 text-sm text-ink3">{r.body}</p>
              <p className="mt-1 text-xs text-ink2">watch: {r.watch}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
