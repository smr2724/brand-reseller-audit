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
}
