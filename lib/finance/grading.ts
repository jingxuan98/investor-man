import { FinancialSnapshot, QualityOutput, DimensionScore, Grade } from "./types";
import { linearBand, mean, coefVar, seriesOldestFirst, cagr, clamp } from "./helpers";

// All thresholds in one place — tune here.
export const GRADING_BANDS = {
  netMargin: [0, 0.2],
  opMargin: [0, 0.25],
  roe: [0, 0.2],
  roic: [0, 0.15],
  debtToEquity: [2, 0.3], // reversed
  interestCoverage: [1.5, 10],
  currentRatio: [1, 2],
  debtPaybackYears: [8, 2], // reversed
  growthCagrFloor: 30, // 0% CAGR → 30 pts, 15% → 100
  growthCagrTop: 0.15,
  cv: [0.5, 0.05], // reversed: choppy → 0, steady → 100
  grossMargin: [0.1, 0.4],
  grossMarginCv: [0.3, 0.02], // reversed
  roicMoatFloor: 0.12,
  upside: [-0.3, 0.3],
  peVsMedian: [1.5, 0.5], // reversed: PE at 1.5x own median → 0, at 0.5x → 100
  taxRate: 0.21,
} as const;

export function toGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B+";
  if (score >= 70) return "B";
  if (score >= 60) return "C+";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

const B = GRADING_BANDS;

function dim(key: string, name: string, subs: (number | null)[], detail: string): DimensionScore {
  const valid = subs.filter((x): x is number => x !== null);
  const score = valid.length ? mean(valid) : null;
  return { key, name, score, grade: score === null ? null : toGrade(score), detail };
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

export function computeQuality(
  s: FinancialSnapshot,
  compositeFairValue: number | null
): QualityOutput {
  // Guard: an empty `years` array (valid ticker, statements unavailable) would
  // make every dimension below dereference years[0] and throw. Report all six
  // dimensions as uniformly n/a with a null overall.
  if (s.years.length === 0) {
    const NA = "n/a — no financial statements available";
    const empty: DimensionScore[] = [
      { key: "profitability", name: "Profitability", score: null, grade: null, detail: NA },
      { key: "finStrength", name: "Financial strength", score: null, grade: null, detail: NA },
      { key: "predictability", name: "Predictability", score: null, grade: null, detail: NA },
      { key: "growth", name: "Growth quality", score: null, grade: null, detail: NA },
      { key: "moat", name: "Economic moat", score: null, grade: null, detail: NA },
      { key: "valuation", name: "Valuation", score: null, grade: null, detail: NA },
    ];
    return { dimensions: empty, overallScore: null, overallGrade: null };
  }

  const y = s.years[0];
  const dims: DimensionScore[] = [];

  // --- Profitability
  const netMargin = y.revenue && y.netIncome !== null ? y.netIncome / y.revenue : null;
  const opMargin = y.revenue && y.operatingIncome !== null ? y.operatingIncome / y.revenue : null;
  const roe = y.equity && y.netIncome !== null ? y.netIncome / y.equity : null;
  const investedCapital =
    y.equity !== null ? y.equity + (y.totalDebt ?? 0) - (y.cash ?? 0) : null;
  const roic =
    investedCapital && investedCapital > 0 && y.operatingIncome !== null
      ? (y.operatingIncome * (1 - B.taxRate)) / investedCapital
      : null;
  dims.push(
    dim(
      "profitability",
      "Profitability",
      [
        netMargin === null ? null : linearBand(netMargin, ...B.netMargin),
        opMargin === null ? null : linearBand(opMargin, ...B.opMargin),
        roe === null ? null : linearBand(roe, ...B.roe),
        roic === null ? null : linearBand(roic, ...B.roic),
      ],
      `Net margin ${pct(netMargin)}, ROE ${pct(roe)}, ROIC ${pct(roic)}`
    )
  );

  // --- Financial strength
  const dte = y.equity && y.equity > 0 && y.totalDebt !== null ? y.totalDebt / y.equity : null;
  const cov =
    y.interestExpense && y.interestExpense > 0 && y.operatingIncome !== null
      ? y.operatingIncome / y.interestExpense
      : y.operatingIncome !== null && y.operatingIncome > 0
      ? 999 // no interest expense = effectively infinite coverage
      : null;
  const cr =
    y.currentLiabilities && y.currentLiabilities > 0 && y.currentAssets !== null
      ? y.currentAssets / y.currentLiabilities
      : null;
  const netDebt = y.totalDebt !== null ? y.totalDebt - (y.cash ?? 0) : null;
  const payback =
    netDebt === null
      ? null
      : netDebt <= 0
      ? 100 // net cash
      : y.freeCashFlow && y.freeCashFlow > 0
      ? linearBand(netDebt / y.freeCashFlow, ...B.debtPaybackYears)
      : 0;
  dims.push(
    dim(
      "finStrength",
      "Financial strength",
      [
        dte === null ? null : linearBand(dte, ...B.debtToEquity),
        cov === null ? null : linearBand(cov, ...B.interestCoverage),
        cr === null ? null : linearBand(cr, ...B.currentRatio),
        payback,
      ],
      `Debt/equity ${dte?.toFixed(2) ?? "n/a"}, coverage ${cov === null ? "n/a" : cov >= 999 ? "∞" : cov.toFixed(1) + "×"}`
    )
  );

  // --- Predictability
  const revs = seriesOldestFirst(s.years, (yy) => yy.revenue);
  const revGrowths = revs.slice(1).map((r, i) => r / revs[i] - 1);
  const margins = seriesOldestFirst(s.years, (yy) =>
    yy.revenue && yy.netIncome !== null ? yy.netIncome / yy.revenue : null
  );
  const fcfs = seriesOldestFirst(s.years, (yy) => yy.freeCashFlow);
  const revCv = coefVar(revGrowths);
  const marginCv = coefVar(margins);
  const posRev = revGrowths.length ? revGrowths.filter((g) => g > 0).length / revGrowths.length : null;
  const posFcf = fcfs.length ? fcfs.filter((f) => f > 0).length / fcfs.length : null;
  dims.push(
    dim(
      "predictability",
      "Predictability",
      [
        revCv === null ? null : linearBand(revCv, ...B.cv),
        marginCv === null ? null : linearBand(marginCv, ...B.cv),
        posRev === null ? null : posRev * 100,
        posFcf === null ? null : posFcf * 100,
      ],
      `Revenue growth stability, margin stability over ${s.years.length} yrs`
    )
  );

  // --- Growth quality
  const growthScore = (g: number | null): number | null =>
    // Reason: spec says 0% CAGR → the 30-point floor; only NEGATIVE growth scores 0.
    g === null ? null : g < 0 ? 0 : B.growthCagrFloor + linearBand(g, 0, B.growthCagrTop) * ((100 - B.growthCagrFloor) / 100);
  const nis = seriesOldestFirst(s.years, (yy) => yy.netIncome);
  const revC = revs.length >= 2 ? cagr(revs[revs.length - 1], revs[0], revs.length - 1) : null;
  const epsC = nis.length >= 2 ? cagr(nis[nis.length - 1], nis[0], nis.length - 1) : null;
  const fcfC = fcfs.length >= 2 ? cagr(fcfs[fcfs.length - 1], fcfs[0], fcfs.length - 1) : null;
  const shares = seriesOldestFirst(s.years, (yy) => yy.sharesOutstanding);
  const shareC = shares.length >= 2 ? cagr(shares[shares.length - 1], shares[0], shares.length - 1) : null;
  let bonus = 0;
  if (epsC !== null && revC !== null && epsC >= revC) bonus += 10;
  if (shareC !== null && shareC > 0.03) bonus -= 10;
  const gSubs = [growthScore(revC), growthScore(epsC), growthScore(fcfC)];
  const gValid = gSubs.filter((x): x is number => x !== null);
  const gScore = gValid.length ? clamp(gValid.reduce((a, b) => a + b, 0) / gValid.length + bonus, 0, 100) : null;
  dims.push({
    key: "growth",
    name: "Growth quality",
    score: gScore,
    grade: gScore === null ? null : toGrade(gScore),
    detail: `Revenue CAGR ${pct(revC)}, EPS CAGR ${pct(epsC)}`,
  });

  // --- Economic moat (quantitative proxy)
  const gms = seriesOldestFirst(s.years, (yy) =>
    yy.revenue && yy.grossProfit !== null ? yy.grossProfit / yy.revenue : null
  );
  const gm0 = gms.length ? gms[gms.length - 1] : null;
  const gmCv = coefVar(gms);
  const roics = s.years
    .map((yy) => {
      const ic = yy.equity !== null ? yy.equity + (yy.totalDebt ?? 0) - (yy.cash ?? 0) : null;
      return ic && ic > 0 && yy.operatingIncome !== null
        ? (yy.operatingIncome * (1 - B.taxRate)) / ic
        : null;
    })
    .filter((v): v is number => v !== null);
  const roicYears = roics.length ? roics.filter((r) => r >= B.roicMoatFloor).length / roics.length : null;
  dims.push(
    dim(
      "moat",
      "Economic moat",
      [
        gm0 === null ? null : linearBand(gm0, ...B.grossMargin),
        gmCv === null ? null : linearBand(gmCv, ...B.grossMarginCv),
        roicYears === null ? null : roicYears * 100,
      ],
      `Gross margin ${pct(gm0)} (quantitative proxy)`
    )
  );

  // --- Valuation
  let vScore: number | null = null;
  if (compositeFairValue !== null && s.price > 0) {
    const upside = compositeFairValue / s.price - 1;
    const upsideScore = linearBand(upside, ...B.upside);
    // blend 70/30 with current PE vs own historical median PE (below median = better)
    const pes = s.years
      .map((yy) => {
        const sh = yy.sharesOutstanding ?? s.sharesOutstanding;
        return yy.yearEndPrice !== null && yy.netIncome && yy.netIncome > 0 && sh
          ? (yy.yearEndPrice * sh) / yy.netIncome
          : null;
      })
      .filter((v): v is number => v !== null);
    const medPe = pes.length ? [...pes].sort((a, b) => a - b)[Math.floor(pes.length / 2)] : null;
    const curPe = s.trailingEPS && s.trailingEPS > 0 ? s.price / s.trailingEPS : null;
    if (medPe && curPe) {
      vScore = 0.7 * upsideScore + 0.3 * linearBand(curPe / medPe, ...B.peVsMedian);
    } else {
      vScore = upsideScore;
    }
  }
  dims.push({
    key: "valuation",
    name: "Valuation",
    score: vScore,
    grade: vScore === null ? null : toGrade(vScore),
    detail:
      compositeFairValue === null
        ? "n/a — composite unavailable"
        : `${pct(compositeFairValue / s.price - 1)} vs fair value`,
  });

  // --- Overall: weighted mean over non-null dims (weights renormalized)
  const WEIGHTS: Record<string, number> = {
    profitability: 0.2,
    finStrength: 0.2,
    valuation: 0.2,
    predictability: 0.15,
    growth: 0.15,
    moat: 0.1,
  };
  let wSum = 0;
  let acc = 0;
  for (const d of dims) {
    if (d.score !== null) {
      acc += d.score * WEIGHTS[d.key];
      wSum += WEIGHTS[d.key];
    }
  }
  const overallScore = wSum > 0 ? acc / wSum : null;
  return {
    dimensions: dims,
    overallScore,
    overallGrade: overallScore === null ? null : toGrade(overallScore),
  };
}
