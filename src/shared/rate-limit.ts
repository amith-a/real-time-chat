import { TooManyRequestsError } from './errors';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS_BEFORE_PRUNE = 1000;
const connectionBuckets = new Map<string, RateLimitBucket>();

export interface RateLimitInput {
  connectionId: string;
  routeKey: string;
  maxRequests: number;
  windowMs?: number;
  nowMs?: number;
}

function pruneExpiredBuckets(nowMs: number): void {
  for (const [key, bucket] of connectionBuckets) {
    if (nowMs >= bucket.resetAt) {
      connectionBuckets.delete(key);
    }
  }
}

/**
 * Enforces a per-connection fixed-window rate limit within the current warm Lambda container.
 *
 * Limitation: state is stored in-memory per container (not globally shared across concurrent
 * Lambda instances). Global edge throttling is enforced by API Gateway WebSocket `RouteSettings`.
 */
export function checkConnectionRateLimit(input: RateLimitInput): void {
  const { connectionId, routeKey, maxRequests, windowMs = 10_000, nowMs = Date.now() } = input;
  if (maxRequests <= 0 || windowMs <= 0) {
    return;
  }

  if (connectionBuckets.size >= MAX_BUCKETS_BEFORE_PRUNE) {
    pruneExpiredBuckets(nowMs);
  }

  const key = `${routeKey}:${connectionId}`;
  const existing = connectionBuckets.get(key);

  if (!existing || nowMs >= existing.resetAt) {
    connectionBuckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return;
  }

  if (existing.count >= maxRequests) {
    throw new TooManyRequestsError(`Rate limit exceeded for ${routeKey}`, {
      connectionId,
      routeKey,
      retryAfterMs: Math.max(0, existing.resetAt - nowMs),
    });
  }

  existing.count++;
}

export function resetConnectionRateLimits(): void {
  connectionBuckets.clear();
}
