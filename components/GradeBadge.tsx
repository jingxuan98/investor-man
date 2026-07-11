const COLORS: Record<string, string> = {
  A: "bg-green-tint text-green",
  "B+": "bg-green-tint text-green",
  B: "bg-green-tint text-green",
  "C+": "bg-amber-tint text-amber",
  C: "bg-amber-tint text-amber",
  D: "bg-red-tint text-red",
  F: "bg-red-tint text-red",
};
export default function GradeBadge({ grade }: { grade: string | null }) {
  return (
    <span
      className={`num inline-flex h-10 w-10 items-center justify-center rounded-full text-lg font-bold ${
        grade ? COLORS[grade] : "bg-track text-ink2"
      }`}
    >
      {grade ?? "–"}
    </span>
  );
}
