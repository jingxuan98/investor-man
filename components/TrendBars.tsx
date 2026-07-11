export default function TrendBars({ values, label }: { values: (number | null)[]; label: string }) {
  const nums = values.filter((v): v is number => v !== null);
  const max = Math.max(...nums.map(Math.abs), 1e-9);
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink2">{label}</p>
      <div className="flex h-24 items-end gap-1">
        {values.map((v, i) => (
          <div key={i} className="flex-1">
            <div
              className={`rounded-sm ${v !== null && v < 0 ? "bg-red" : "bg-accent"}`}
              style={{ height: `${v === null ? 0 : (Math.abs(v) / max) * 96}px` }}
              title={v === null ? "n/a" : String(v)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
