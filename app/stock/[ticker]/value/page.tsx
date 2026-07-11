import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import { reverseDcf } from "@/lib/finance/insights";
import ValueTable from "@/components/ValueTable";
import GateCard from "@/components/GateCard";
import LongHorizonDcf from "@/components/LongHorizonDcf";
import EpvCard from "@/components/EpvCard";
import MultiplesCard from "@/components/MultiplesCard";

function Kicker({
  index,
  title,
  subtitle,
  right,
}: {
  index: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink2">
          {index} · {title}
        </p>
        {subtitle && <p className="mt-1 text-sm text-ink2">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export default async function ValuePage({
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
  const { snapshot, valuation, gate } = bundle;

  const reverse = reverseDcf(snapshot);
  const updatedDate = new Date(snapshot.fetchedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <Kicker index="00" title="Composite Fair Value" />
        <ValueTable snapshot={snapshot} updatedDate={updatedDate} />
      </section>

      <section>
        {/* GateCard already renders its own bordered card (shared with the
            Overview tab), so this section skips the extra card wrapper the
            other four sections use — avoids a double border. */}
        <Kicker
          index="01"
          title="Quality Gate"
          subtitle="Four pass/fail checks on business quality — can it earn above its cost of capital, hold pricing power, grow consistently, and allocate cash sensibly?"
        />
        <GateCard gate={gate} />
      </section>

      <section className="card p-6">
        <Kicker
          index="02"
          title="Long-Horizon DCF"
          subtitle="Answers: if the company keeps compounding cash for 20 years, what is one share worth today? The knobs let you test your own assumptions."
        />
        <LongHorizonDcf
          snapshot={snapshot}
          autoNormalGrowth={valuation.autoNormalGrowth}
          autoWacc={valuation.autoWacc}
          impliedGrowth={reverse.impliedGrowth}
        />
      </section>

      <section className="card p-6">
        <Kicker
          index="03"
          title="Earnings Power & Owner Yield"
          subtitle="Two skeptic's checks: what the business is worth with ZERO future growth (EPV), and how much real cash you'd pocket per dollar invested vs just buying treasuries (Owner Yield)."
        />
        <EpvCard snapshot={snapshot} />
      </section>

      <section className="card p-6">
        <Kicker
          index="04"
          title="Multiples vs Peers & History"
          subtitle="How the market prices each $1 of this company's earnings/sales vs its own past and vs its sector — high multiples mean high expectations."
        />
        <MultiplesCard snapshot={snapshot} />
      </section>
    </div>
  );
}
