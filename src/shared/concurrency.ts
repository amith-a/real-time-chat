/**
 * Utilities for bounded concurrency and retry mechanisms.
 */

export const DEFAULT_DYNAMODB_CONCURRENCY = 10;
export const DEFAULT_GATEWAY_CONCURRENCY = 25;

/**
 * Concurrently maps an array of items with a worker function,
 * bounding active promises to `concurrency`.
 * Preserves the original array order in the returned results.
 * If any mapping rejects, the returned promise rejects with the first error.
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = DEFAULT_DYNAMODB_CONCURRENCY,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, concurrency);
  const results = new Array<R>(items.length);
  let currentIndex = 0;
  let firstError: unknown = null;
  let hasError = false;

  async function worker(): Promise<void> {
    while (currentIndex < items.length && !hasError) {
      const idx = currentIndex++;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  if (hasError) {
    throw firstError;
  }

  return results;
}

/**
 * Concurrently maps an array of items with a worker function,
 * bounding active promises to `concurrency`, and returning
 * settled results (fulfilled or rejected) for every item.
 * Preserves the original array order in the returned results.
 */
export async function pMapSettled<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = DEFAULT_GATEWAY_CONCURRENCY,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, concurrency);
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      try {
        const value = await mapper(items[idx], idx);
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Checks if an error is an API Gateway Management API throttling / rate-limit error.
 */
export function isThrottledError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    name?: string;
    statusCode?: number;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    err.name === 'LimitExceededException' ||
    err.name === 'TooManyRequestsException' ||
    err.statusCode === 429 ||
    err.$metadata?.httpStatusCode === 429
  );
}

/**
 * Executes an async function with exponential jittered backoff.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 50,
    maxDelayMs = 500,
    backoffFactor = 2,
    isRetryable = () => true,
  } = options;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt > maxRetries || !isRetryable(error)) {
        throw error;
      }
      const maxBackoff = Math.min(maxDelayMs, initialDelayMs * backoffFactor ** (attempt - 1));
      const jitteredDelay = Math.floor(Math.random() * maxBackoff);
      if (jitteredDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
      }
    }
  }
}
