"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function StockTabs({
  tabs,
}: {
  tabs: readonly (readonly [string, string])[];
}) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-1">
      {tabs.map(([label, href]) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`tab-btn ${active ? "active" : ""}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
