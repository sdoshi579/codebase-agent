// Simple in-memory sliding-window limiter. Good enough for a single-instance,
// ephemeral deployment; swap for a shared store (Upstash/Redis) if this ever
// runs behind more than one server process.

interface Bucket {
  hits: number[];
}

// Same globalThis-pinning reasoning as lib/sessions.ts: a plain module-level
// Map can silently become multiple instances across Next.js dev's per-route
// bundles, which would make rate limiting a no-op (every route sees an
// empty bucket set). Pin it so it's genuinely one shared limiter.
declare global {
  // eslint-disable-next-line no-var
  var __rateLimitBuckets: Map<string, Bucket> | undefined;
}

const buckets: Map<string, Bucket> = globalThis.__rateLimitBuckets ?? new Map();
globalThis.__rateLimitBuckets = buckets;

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HITS = 20;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Without this, a bucket for an IP that hits the limit once and never comes
// back sits in memory forever -- checkRateLimit() only prunes a bucket's
// hits when that same IP makes another request, so a one-off visitor's now-
// empty bucket has no trigger to ever get removed. Same globalThis-guard
// pattern as the session sweep in lib/sessions.ts, to avoid double-
// registering the interval across Next.js dev's HMR reloads.
function sweepEmptyBuckets() {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
    if (bucket.hits.length === 0) {
      buckets.delete(ip);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __rateLimitSweepTimer: NodeJS.Timeout | undefined;
}

if (!globalThis.__rateLimitSweepTimer) {
  globalThis.__rateLimitSweepTimer = setInterval(sweepEmptyBuckets, SWEEP_INTERVAL_MS);
}

export function checkRateLimit(ip: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = buckets.get(ip) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);

  if (bucket.hits.length >= MAX_HITS) {
    const oldest = bucket.hits[0];
    buckets.set(ip, bucket);
    return { ok: false, retryAfterMs: WINDOW_MS - (now - oldest) };
  }

  bucket.hits.push(now);
  buckets.set(ip, bucket);
  return { ok: true, retryAfterMs: 0 };
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}