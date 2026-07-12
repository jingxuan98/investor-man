import { expect, test } from "vitest";
import { extractGrowthHistory } from "@/lib/data/edgar";

// Build a us-gaap USD entry.
function e(
  fy: number,
  val: number,
  opts: Partial<{ start: string; end: string; form: string; fp: string; filed: string }> = {}
) {
  return {
    fy,
    fp: opts.fp ?? "FY",
    form: opts.form ?? "10-K",
    val,
    start: opts.start ?? `${fy}-01-01`,
    end: opts.end ?? `${fy}-12-31`,
    filed: opts.filed ?? `${fy + 1}-02-01`,
  };
}

const facts = {
  facts: {
    "us-gaap": {
      // Priority tag has data → wins over Revenues below.
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            e(2020, 1000),
            e(2021, 1200),
            e(2022, 1440),
            e(2023, 1728),
            e(2024, 2073.6),
            // Two filings for the same FY 2025 → dedupe keeps latest end+filed.
            e(2025, 2400, { end: "2025-12-31", filed: "2026-02-01" }),
            e(2025, 2488, { end: "2025-12-31", filed: "2026-05-01" }),
            // Quarterly row under a 10-K form → excluded by duration guard.
            e(2025, 600, { start: "2025-10-01", end: "2025-12-31", filed: "2026-02-15" }),
          ],
        },
      },
      // Lower-priority tag — per-year merge must ignore it for years the
      // priority tag already covers (2020/2021 here).
      Revenues: {
        units: { USD: [e(2020, 99999), e(2021, 99999)] },
      },
      NetIncomeLoss: {
        units: {
          USD: [
            e(2020, 100),
            e(2021, 130),
            e(2022, 169),
            e(2023, 219.7),
            e(2024, 285.6),
            e(2025, 371.3),
          ],
        },
      },
    },
  },
};

test("extractGrowthHistory: tag priority, duration exclusion, dedupe, newest-first", () => {
  const out = extractGrowthHistory(facts);

  // 6 fiscal years, newest-first.
  expect(out.map((r) => r.year)).toEqual([2025, 2024, 2023, 2022, 2021, 2020]);

  // Priority revenue tag wins (2400/2488 range, not 99999 from Revenues).
  // Dedupe keeps latest filed for FY2025 → 2488, not 2400 or the quarterly 600.
  expect(out[0].revenue).toBe(2488);
  expect(out[0].netIncome).toBe(371.3);

  // Oldest reflects priority tag (1000), not the Revenues decoy.
  const y2020 = out.find((r) => r.year === 2020)!;
  expect(y2020.revenue).toBe(1000);
  expect(y2020.netIncome).toBe(100);
});

test("extractGrowthHistory: caps at 8 and returns [] on junk", () => {
  expect(extractGrowthHistory(null)).toEqual([]);
  expect(extractGrowthHistory({})).toEqual([]);
});

// NVDA scenario: the priority ASC-606 tag covers only OLDER years while the
// company's recent FYs report revenue under `Revenues`. The per-year merge
// must stitch both into a full history instead of truncating at the tag switch.
test("extractGrowthHistory: per-year merge stitches partially-overlapping tags", () => {
  const partial = {
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [e(2019, 100), e(2020, 110), e(2021, 121), e(2022, 133.1)] },
        },
        Revenues: {
          units: {
            USD: [
              // Overlap year: priority tag must win for 2022.
              e(2022, 55555),
              e(2023, 146.4),
              e(2024, 161.1),
              e(2025, 177.2),
            ],
          },
        },
        NetIncomeLoss: {
          units: { USD: [e(2023, 20), e(2024, 25), e(2025, 30)] },
        },
      },
    },
  };
  const out = extractGrowthHistory(partial);
  // All 7 years present, newest-first — no truncation at the tag boundary.
  expect(out.map((r) => r.year)).toEqual([2025, 2024, 2023, 2022, 2021, 2020, 2019]);
  // Recent years filled from the fallback tag...
  expect(out[0].revenue).toBe(177.2);
  expect(out[2].revenue).toBe(146.4);
  // ...while the priority tag wins the overlap year and covers older years.
  expect(out.find((r) => r.year === 2022)!.revenue).toBe(133.1);
  expect(out.find((r) => r.year === 2019)!.revenue).toBe(100);
  // netIncome null where NetIncomeLoss has no annual entry.
  expect(out.find((r) => r.year === 2019)!.netIncome).toBeNull();
});

test("extractGrowthHistory: RMBS-style tax-INCLUSIVE revenue tag is recognized", () => {
  // Rambus tags its top line RevenueFromContractWithCustomerIncludingAssessedTax;
  // before this tag was in the list, its whole revenue history read null and the
  // growth seed silently fell back to Yahoo's shorter window (task-42 analysis).
  const rmbsStyle = {
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerIncludingAssessedTax: {
          units: { USD: [e(2021, 328), e(2022, 455), e(2023, 461), e(2024, 557), e(2025, 632)] },
        },
        NetIncomeLoss: {
          units: { USD: [e(2021, 18), e(2022, -14), e(2023, 334), e(2024, 180), e(2025, 220)] },
        },
      },
    },
  };
  const out = extractGrowthHistory(rmbsStyle);
  expect(out.map((r) => r.year)).toEqual([2025, 2024, 2023, 2022, 2021]);
  expect(out.every((r) => r.revenue !== null)).toBe(true);
  expect(out[0].revenue).toBe(632);
});

test("extractGrowthHistory: GS-style bank revenue tag (net of interest expense) is recognized", () => {
  // Goldman Sachs (and other banks/broker-dealers) have no ASC-606 revenue
  // tag at all — their top line is RevenuesNetOfInterestExpense. Before this
  // tag was in the list, GS's revenue window read 0/8 non-null and was
  // rejected outright (30-ticker sweep, task-43).
  const gsStyle = {
    facts: {
      "us-gaap": {
        RevenuesNetOfInterestExpense: {
          units: { USD: [e(2021, 44300), e(2022, 47400), e(2023, 46300), e(2024, 53500), e(2025, 58283)] },
        },
        NetIncomeLoss: {
          units: { USD: [e(2021, 21600), e(2022, 11300), e(2023, 8500), e(2024, 14300), e(2025, 16000)] },
        },
      },
    },
  };
  const out = extractGrowthHistory(gsStyle);
  expect(out.map((r) => r.year)).toEqual([2025, 2024, 2023, 2022, 2021]);
  expect(out.every((r) => r.revenue !== null)).toBe(true);
  expect(out[0].revenue).toBe(58283);
});

test("extractGrowthHistory: CAT-style common-attributable/ProfitLoss net-income variants are recognized", () => {
  // Caterpillar stops tagging plain NetIncomeLoss after ~FY2010 and reports
  // the common-attributable figure under NetIncomeLossAvailableToCommonStockholdersBasic
  // instead; ProfitLoss (includes noncontrolling interests) is the lowest-
  // priority fallback. Before these tags were in the list, CAT's net-income
  // window read 0/8 non-null for FY2016-2025 despite 8/8 non-null revenue
  // (30-ticker sweep, task-43).
  const catStyle = {
    facts: {
      "us-gaap": {
        Revenues: {
          units: { USD: [e(2021, 51000), e(2022, 59400), e(2023, 67100), e(2024, 64800), e(2025, 66300)] },
        },
        // Only covers an old year the other tags don't — merge should still
        // prefer it where present.
        NetIncomeLoss: {
          units: { USD: [e(2010, 2700)] },
        },
        NetIncomeLossAvailableToCommonStockholdersBasic: {
          units: { USD: [e(2021, 6489), e(2022, 6705), e(2023, 10040), e(2024, 8337), e(2025, 8884)] },
        },
        ProfitLoss: {
          units: { USD: [e(2021, 6503), e(2022, 6718), e(2023, 10053), e(2024, 8348), e(2025, 8882)] },
        },
      },
    },
  };
  const out = extractGrowthHistory(catStyle);
  expect(out.every((r) => r.netIncome !== null)).toBe(true);
  // Common-attributable tag wins over ProfitLoss (which includes NCI) for
  // the overlapping years.
  expect(out.find((r) => r.year === 2025)!.netIncome).toBe(8884);
});
