/**
 * Phase 33 (review fix B8) — Module-level rate limiter for owner-resolver
 * adapters. Limits cross-request concurrency and minimum interval between
 * starts so a 50-brand recovery doesn't fire 150+ concurrent external API
 * calls. Lives in-process; per Vercel function instance.
 */

interface BucketState {
  inFlight: number;
  lastStartMs: number;
  queue: QueueEntry[];
}

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  cancelled: boolean;
}

const buckets: Map<string, BucketState> = new Map();

export interface RateLimitOptions {
  key: string;
  maxConcurrent: number;
  minIntervalMs: number;
  /** Hard ceiling on how long we'll wait for a slot. Default 60s. */
  maxWaitMs?: number;
}

function getBucket(key: string): BucketState {
  let b = buckets.get(key);
  if (!b) {
    b = { inFlight: 0, lastStartMs: 0, queue: [] };
    buckets.set(key, b);
  }
  return b;
}

function drain(bucket: BucketState, opts: RateLimitOptions): void {
  while (bucket.queue.length > 0) {
    const head = bucket.queue[0]!;
    if (head.cancelled) {
      bucket.queue.shift();
      continue;
    }
    if (bucket.inFlight >= opts.maxConcurrent) return;
    const now = Date.now();
    const wait = Math.max(0, bucket.lastStartMs + opts.minIntervalMs - now);
    if (wait > 0) {
      setTimeout(() => drain(bucket, opts), wait);
      return;
    }
    bucket.queue.shift();
    bucket.inFlight += 1;
    bucket.lastStartMs = Date.now();
    head.resolve();
  }
}

export async function rateLimit<T>(
  opts: RateLimitOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const bucket = getBucket(opts.key);
  const maxWait = opts.maxWaitMs ?? 60_000;

  await new Promise<void>((resolve, reject) => {
    const entry: QueueEntry = { resolve, reject, cancelled: false };
    const timer = setTimeout(() => {
      entry.cancelled = true;
      reject(
        new Error(
          `rate-limit '${opts.key}' saturated for >${maxWait}ms`,
        ),
      );
    }, maxWait);
    const wrappedResolve = entry.resolve;
    entry.resolve = () => {
      clearTimeout(timer);
      wrappedResolve();
    };
    bucket.queue.push(entry);
    drain(bucket, opts);
  });

  try {
    return await fn();
  } finally {
    bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    drain(bucket, opts);
  }
}

/** Test-only: clear all bucket state. */
export function __resetRateLimitBuckets(): void {
  buckets.clear();
  slidingBuckets.clear();
}

/**
 * Phase 34.1 — Sliding-window per-key counter for user-facing rate limits
 * (e.g. "5 manual Apollo searches per brand per 10 min"). In-process; per
 * Vercel function instance, which is fine for the manual override path
 * since it's a low-volume user action.
 *
 * Returns `{ allowed, retry_after_ms }`. When `allowed` is false, the
 * caller should reject with HTTP 429 and surface `retry_after_ms` so the
 * UI can show "try again in N seconds".
 */
interface SlidingBucket {
  hits: number[]; // ms timestamps of recent allowed calls
}
const slidingBuckets: Map<string, SlidingBucket> = new Map();

export interface SlidingWindowDecision {
  allowed: boolean;
  retry_after_ms: number;
  remaining: number;
}

export function checkSlidingWindow(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): SlidingWindowDecision {
  let b = slidingBuckets.get(key);
  if (!b) {
    b = { hits: [] };
    slidingBuckets.set(key, b);
  }
  const cutoff = now - windowMs;
  // Drop expired entries.
  while (b.hits.length > 0 && b.hits[0]! < cutoff) {
    b.hits.shift();
  }
  if (b.hits.length >= limit) {
    const oldest = b.hits[0]!;
    const retryAfterMs = Math.max(0, oldest + windowMs - now);
    return { allowed: false, retry_after_ms: retryAfterMs, remaining: 0 };
  }
  b.hits.push(now);
  return {
    allowed: true,
    retry_after_ms: 0,
    remaining: Math.max(0, limit - b.hits.length),
  };
}
