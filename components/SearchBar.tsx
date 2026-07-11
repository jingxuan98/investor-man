"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SearchResult {
  symbol: string;
  shortname: string;
  exchDisp: string;
  typeDisp: string;
}

export default function SearchBar({
  size = "md",
  className = "",
}: {
  size?: "md" | "lg";
  className?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reason: guards against an earlier, slower fetch overwriting the results
  // of a later keystroke's fetch (debounce alone doesn't prevent out-of-order
  // responses once requests are in flight).
  const latestQueryRef = useRef("");

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      latestQueryRef.current = q;
      setLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((res) => res.json())
        .then((data) => {
          if (latestQueryRef.current !== q) return; // stale response
          setResults(Array.isArray(data?.results) ? data.results : []);
        })
        .catch(() => {
          if (latestQueryRef.current === q) setResults([]);
        })
        .finally(() => {
          if (latestQueryRef.current === q) setLoading(false);
        });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function navigateTo(symbol: string) {
    const t = symbol.trim().toUpperCase();
    if (!t) return;
    setOpen(false);
    setQuery("");
    setResults([]);
    setHighlight(-1);
    router.push(`/stock/${encodeURIComponent(t)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length) setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) setHighlight((h) => (h <= 0 ? results.length - 1 : h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0 && results[highlight]) {
        navigateTo(results[highlight].symbol);
      } else {
        navigateTo(query);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const inputClasses =
    size === "lg"
      ? "px-4 py-2 text-lg"
      : "px-3 py-1.5 text-sm";

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search ticker or company…"
          aria-label="Search ticker or company"
          className={`w-full rounded-lg border border-line bg-card text-ink ${inputClasses} placeholder:text-ink2 focus:border-accent focus:outline-none`}
        />
        {loading && (
          <span
            className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-line border-t-ink2"
            aria-hidden
          />
        )}
      </div>
      {open && query.trim() && (
        <div className="card absolute z-10 mt-1 w-full divide-y divide-line text-sm">
          {results.length === 0 ? (
            <div className="px-3 py-2 text-ink2">
              {loading ? "Searching…" : "No matches"}
            </div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.symbol}
                onMouseDown={(e) => {
                  e.preventDefault();
                  navigateTo(r.symbol);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`cursor-pointer px-3 py-2 hover:bg-track ${
                  i === highlight ? "bg-track" : ""
                }`}
              >
                <span className="font-bold text-ink">{r.symbol}</span>{" "}
                <span className="text-ink3">{r.shortname}</span>{" "}
                <span className="text-ink2">{r.exchDisp}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
