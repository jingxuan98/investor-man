// InvestorMan brand mark: an "IM" monogram where the M doubles as a rising
// stock-chart line, plus the wordmark. SVG geometry is fixed by design spec —
// do not redraw it; only `size` and layout are meant to flex per call site.
export default function Logo({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="flex-none"
      >
        <rect width="64" height="64" rx="14" fill="#1A1A18" />
        <rect x="13" y="18" width="7" height="28" rx="3.5" fill="#FFFFFF" />
        <path
          d="M27 46 L27 30 L35 40 L45 18 L45 46"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M45 18 L52 11" stroke="#2E7D55" strokeWidth="7" strokeLinecap="round" />
      </svg>
      <span className="font-semibold" style={{ fontSize: size * 0.64 }}>
        <span style={{ color: "#1A1A18" }}>Investor</span>
        <span style={{ color: "#2E7D55" }}>Man</span>
      </span>
    </span>
  );
}
