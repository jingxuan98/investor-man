export function fmtMoney(n: number | null, currency = "USD"): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}
export function fmtBig(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  return n.toFixed(0);
}
export function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}
