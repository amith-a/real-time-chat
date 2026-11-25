import { describe, expect, it } from 'vitest';
import { isThrottledError, pMap, pMapSettled, withRetry } from '../src/shared/concurrency';

describe('concurrency utilities', () => {
  describe('pMap', () => {
    it('returns empty array for empty inputs', async () => {
      const results = await pMap([], async (x) => x);
      expect(results).toEqual([]);
    });

    it('processes items and preserves original order', async () => {
      const items = [10, 20, 30, 40, 50];
      const results = await pMap(
        items,
        async (val) => {
          await new Promise((resolve) => setTimeout(resolve, 10 - val / 10));
          return val * 2;
        },
        2,
      );
      expect(results).toEqual([20, 40, 60, 80, 100]);
    });

    it('bounds concurrent executions', async () => {
      let active = 0;
      let maxActive = 0;
      const items = Array.from({ length: 20 }, (_, i) => i);

      await pMap(
        items,
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
        },
        4,
      );

      expect(maxActive).toBeLessThanOrEqual(4);
    });

    it('aborts and rethrows first error when mapping fails', async () => {
      const items = [1, 2, 3, 4, 5];
      await expect(
        pMap(
          items,
          async (val) => {
            if (val === 3) {
              throw new Error('Boom 3');
            }
            return val;
          },
          2,
        ),
      ).rejects.toThrow('Boom 3');
    });
  });

  describe('pMapSettled', () => {
    it('returns empty array for empty inputs', async () => {
      const results = await pMapSettled([], async (x) => x);
      expect(results).toEqual([]);
    });

    it('bounds concurrent executions', async () => {
      let active = 0;
      let maxActive = 0;

      const items = Array.from({ length: 20 }, (_, i) => i);

      await pMapSettled(
        items,
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);

          await new Promise((resolve) => setTimeout(resolve, 10));

          active--;
        },
        4,
      );

      expect(maxActive).toBeLessThanOrEqual(4);
    });

    it('returns all fulfilled and rejected outcomes without throwing', async () => {
      const items = [1, 2, 3, 4];
      const results = await pMapSettled(
        items,
        async (val) => {
          if (val === 2) {
            throw new Error('Failure 2');
          }
          return val * 10;
        },
        2,
      );

      expect(results).toHaveLength(4);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
      expect(results[1].status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason.message).toBe('Failure 2');
      expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
      expect(results[3]).toEqual({ status: 'fulfilled', value: 40 });
    });
  });

  describe('isThrottledError', () => {
    it('detects 429 status code', () => {
      expect(isThrottledError({ statusCode: 429 })).toBe(true);
      expect(isThrottledError({ $metadata: { httpStatusCode: 429 } })).toBe(true);
    });

    it('detects LimitExceededException and TooManyRequestsException', () => {
      expect(isThrottledError({ name: 'LimitExceededException' })).toBe(true);
      expect(isThrottledError({ name: 'TooManyRequestsException' })).toBe(true);
    });

    it('returns false for other errors or invalid inputs', () => {
      expect(isThrottledError(null)).toBe(false);
      expect(isThrottledError(new Error('Generic'))).toBe(false);
      expect(isThrottledError({ statusCode: 500 })).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('returns value without retrying on immediate success', async () => {
      let calls = 0;
      const res = await withRetry(async () => {
        calls++;
        return 'success';
      });
      expect(res).toBe('success');
      expect(calls).toBe(1);
    });

    it('retries until success within maxRetries', async () => {
      let attempts = 0;
      const res = await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw { statusCode: 429 };
          }
          return 'recovered';
        },
        {
          maxRetries: 3,
          initialDelayMs: 5,
          maxDelayMs: 20,
          isRetryable: isThrottledError,
        },
      );
      expect(res).toBe('recovered');
      expect(attempts).toBe(3);
    });

    it('throws if retries exhausted', async () => {
      let attempts = 0;
      await expect(
        withRetry(
          async () => {
            attempts++;
            throw { statusCode: 429 };
          },
          {
            maxRetries: 2,
            initialDelayMs: 5,
            maxDelayMs: 15,
            isRetryable: isThrottledError,
          },
        ),
      ).rejects.toEqual({ statusCode: 429 });
      expect(attempts).toBe(3); // 1 initial + 2 retries
    });
  });
});
