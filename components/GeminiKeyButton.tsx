"use client";

import { useEffect, useRef, useState } from "react";
import { GEMINI_KEY_STORAGE_KEY } from "@/lib/geminiKeyHeader";

// Always-visible BYO Gemini key control (header + home page). In dev, the
// server's own GEMINI_API_KEY env var makes this optional; in production
// (no env key on Vercel) this is how a user supplies their own key, which is
// stored only in this browser's localStorage and sent per-request via the
// x-gemini-key header — see lib/geminiKeyHeader.ts and the /api/research and
// /api/competitors/[ticker] routes.
export default function GeminiKeyButton() {
  const [open, setOpen] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [input, setInput] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHasKey(!!window.localStorage.getItem(GEMINI_KEY_STORAGE_KEY));
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function openPopover() {
    setInput(window.localStorage.getItem(GEMINI_KEY_STORAGE_KEY) ?? "");
    setOpen(true);
  }

  function save() {
    const trimmed = input.trim();
    if (trimmed) {
      window.localStorage.setItem(GEMINI_KEY_STORAGE_KEY, trimmed);
      setHasKey(true);
    } else {
      window.localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
      setHasKey(false);
    }
    setOpen(false);
  }

  function clear() {
    window.localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
    setInput("");
    setHasKey(false);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPopover())}
        aria-label="Gemini API key settings"
        title={hasKey ? "Gemini API key set" : "Add your Gemini API key"}
        className={`btn cursor-pointer whitespace-nowrap rounded-full !px-3 !py-1.5 text-xs font-medium ${
          hasKey ? "bg-green-tint text-green" : "bg-amber-tint text-amber"
        }`}
      >
        {hasKey ? (
          "🔑 API key active"
        ) : (
          <>
            <span className="hidden sm:inline">🔑 Insert API Key for Full Functionality</span>
            <span className="sm:hidden">🔑 Insert API Key</span>
          </>
        )}
      </button>

      {open && (
        <div className="card absolute right-0 z-50 mt-2 w-80 p-4 shadow-lg">
          <label htmlFor="gemini-key-input" className="text-sm font-semibold text-ink">
            Gemini API key
          </label>
          <p className="mt-1 text-xs text-ink2">
            Your key is stored only in this browser (localStorage) and sent directly to
            our server per request — never saved there.
          </p>
          <input
            id="gemini-key-input"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="AIza..."
            className="mt-3 w-full rounded-md border border-line bg-page px-3 py-1.5 text-sm text-ink"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-2 text-xs text-ink2">
            Get a free key at{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              aistudio.google.com/apikey
            </a>
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={clear} className="btn btn-outline">
              Clear
            </button>
            <button type="button" onClick={save} className="btn btn-blue">
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
