import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, clientIp } from "./rateLimit";

// buckets is a module-level singleton (globalThis-pinned, by design -- see
// rateLimit.ts's own comment on why). That means state persists across test
// cases in this file unless each test uses its own distinct IP, so every
// test below generates a unique one rather than sharing "1.2.3.4" and
// silently depending on test execution order.
let counter = 0;
function freshIp(): string {
  counter += 1;
  return `10.0.0.${counter}`;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows the first request from a new IP", () => {
    const result = checkRateLimit(freshIp());
    expect(result.ok).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it("allows exactly the configured max hits, then blocks the next one", () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(ip).ok).toBe(true);
    }
    const blocked = checkRateLimit(ip);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks different IPs independently", () => {
    const ipA = freshIp();
    const ipB = freshIp();
    for (let i = 0; i < 20; i++) checkRateLimit(ipA);
    // ipA is now exhausted -- ipB should be completely unaffected.
    expect(checkRateLimit(ipA).ok).toBe(false);
    expect(checkRateLimit(ipB).ok).toBe(true);
  });

  it("allows requests again once the sliding window has fully elapsed", () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) checkRateLimit(ip);
    expect(checkRateLimit(ip).ok).toBe(false);

    // Advance past the 15-minute window.
    vi.advanceTimersByTime(15 * 60 * 1000 + 1000);

    expect(checkRateLimit(ip).ok).toBe(true);
  });

  it("is a sliding window, not a fixed one -- partial elapse only frees up partial capacity", () => {
    const ip = freshIp();
    // Use up 10 of 20 slots.
    for (let i = 0; i < 10; i++) checkRateLimit(ip);

    // Advance 1 minute and use the other 10.
    vi.advanceTimersByTime(60 * 1000);
    for (let i = 0; i < 10; i++) checkRateLimit(ip);

    // All 20 hits are still within the last 15 minutes -- should be blocked.
    expect(checkRateLimit(ip).ok).toBe(false);

    // Advance 14 more minutes (15 total since the first 10 hits) -- those
    // first 10 should have aged out, freeing exactly that much capacity.
    vi.advanceTimersByTime(14 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(ip).ok).toBe(true);
    }
    // The 11th should be blocked again (only 10 slots freed up).
    expect(checkRateLimit(ip).ok).toBe(false);
  });
});

describe("clientIp", () => {
  function reqWith(headers: Record<string, string>): Request {
    return new Request("https://example.com", { headers });
  }

  it("reads the first IP from x-forwarded-for", () => {
    const req = reqWith({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(clientIp(req)).toBe("203.0.113.5");
  });

  it("trims whitespace around the extracted IP", () => {
    const req = reqWith({ "x-forwarded-for": "  203.0.113.5  , 10.0.0.1" });
    expect(clientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = reqWith({ "x-real-ip": "198.51.100.7" });
    expect(clientIp(req)).toBe("198.51.100.7");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    const req = reqWith({});
    expect(clientIp(req)).toBe("unknown");
  });
});