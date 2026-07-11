import { expect, test, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
process.env.CACHE_DB_PATH = "/tmp/investsite-test-cache.db";
// Reason: dynamic import so lib/db.ts's top-level code runs AFTER the env
// assignment above — a static import would be hoisted and load the module
// before CACHE_DB_PATH is set, pointing the cache at the real data/cache.db.
const { cacheGet, cacheSet, cacheDel } = await import("@/lib/db");

beforeEach(() => cacheDel("k"));

test("set then get returns value", () => {
  cacheSet("k", { a: 1 }, 60);
  expect(cacheGet<{ a: number }>("k")).toEqual({ a: 1 });
});

test("expired entry returns null", () => {
  cacheSet("k", "v", -1); // already expired
  expect(cacheGet("k")).toBeNull();
});

test("missing key returns null", () => {
  expect(cacheGet("nope")).toBeNull();
});

test("active sweep purges expired rows on cacheSet once 6h have passed", () => {
  const expiredKey = "sweep-expired-row";
  cacheSet(expiredKey, "stale", -1); // writes a row that is already expired

  // Force the module's 6h sweep-interval gate open without a real wait.
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 1000);
    cacheSet("sweep-trigger-row", "fresh", 60); // any cacheSet should trigger the sweep now
  } finally {
    vi.useRealTimers();
  }

  // Query the sqlite file directly (bypassing cacheGet's own lazy-delete
  // check) to prove the ACTIVE sweep — not the lazy read-path — removed it.
  const raw = new Database(process.env.CACHE_DB_PATH as string);
  const row = raw.prepare("SELECT 1 FROM cache WHERE key = ?").get(expiredKey);
  raw.close();
  expect(row).toBeUndefined();
});
