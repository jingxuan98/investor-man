import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Vercel's filesystem is read-only except /tmp, which is per-instance and
// ephemeral (wiped on cold start / across instances) — acceptable degraded
// caching there, since the cache is a performance optimization, not a source
// of truth.
const dbPath =
  process.env.CACHE_DB_PATH ??
  (process.env.VERCEL ? "/tmp/investsite-cache.db" : path.join(process.cwd(), "data", "cache.db"));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(
  "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)"
);

// Active sweep — complements the lazy per-key eviction in cacheGet (which
// only ever cleans a row someone actually reads again). Without this, keys
// that are written once and never re-read (or whose TTL lapses before the
// next read) would sit in the sqlite file forever. No setInterval/timers
// here: serverless instances can be frozen/recycled between requests, so we
// piggyback the sweep on cacheSet calls instead (see SWEEP_INTERVAL_MS below).
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

function purgeExpired(): void {
  db.prepare("DELETE FROM cache WHERE expires < ?").run(Date.now());
  lastSweepAt = Date.now();
}

// Run once at module load — covers rows that expired while nothing hit
// this module (cold start, long-idle serverless instance, etc).
purgeExpired();

export function cacheGet<T>(key: string): T | null {
  const row = db
    .prepare("SELECT value, expires FROM cache WHERE key = ?")
    .get(key) as { value: string; expires: number } | undefined;
  if (!row) return null;
  if (row.expires < Date.now()) {
    cacheDel(key);
    return null;
  }
  return JSON.parse(row.value) as T;
}

export function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (Date.now() - lastSweepAt >= SWEEP_INTERVAL_MS) purgeExpired();
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)"
  ).run(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
}

export function cacheDel(key: string): void {
  db.prepare("DELETE FROM cache WHERE key = ?").run(key);
}
