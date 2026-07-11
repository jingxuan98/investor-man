import { NextResponse } from "next/server";
import { cacheGet, cacheSet } from "@/lib/db";
import { searchTickers, SearchResult } from "@/lib/data/yahoo";

const TTL_1H = 3600;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = (searchParams.get("q") ?? "").trim();
  // Reason: search must never break the header — reject obviously bad input
  // up front instead of hitting Yahoo, and swallow all downstream errors.
  if (raw.length < 1 || raw.length > 20) {
    return NextResponse.json({ results: [] });
  }
  const key = `search:${raw.toLowerCase()}`;
  const hit = cacheGet<SearchResult[]>(key);
  if (hit) return NextResponse.json({ results: hit });
  try {
    const results = await searchTickers(raw);
    cacheSet(key, results, TTL_1H);
    return NextResponse.json({ results });
  } catch (e) {
    console.error("[search] searchTickers failed:", e);
    return NextResponse.json({ results: [] });
  }
}
