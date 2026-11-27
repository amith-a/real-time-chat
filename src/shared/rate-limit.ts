import { TooManyRequestsError } from './errors';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const connectionBuckets = new Map<string, RateLimitBucket>();

export interface RateLimitInput {
  connectionId: string;
  routeKey: string;
  maxRequests: number;
  windowMs?: number;
  nowMs?: number;
}

/**
 * Enforces a per-connection fixed-window rate limit in the Lambda container.
 */
export function checkConnectionRateLimit(input: RateLimitInput): void {
  const { connectionId, routeKey, maxRequests, windowMs = 10_000, nowMs = Date.now() } = input;
  if (maxRequests <= 0 || windowMs <= 0) {
    return;
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
