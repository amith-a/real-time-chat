/**
 * Helpers for classifying DynamoDB errors without importing SDK exception classes,
 * so the checks keep working with bundled or mocked SDKs.
 */

export interface CancellationReason {
  Code?: string;
  Message?: string;
  Item?: Record<string, unknown>;
}

export function errorName(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.name;
  }
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return String((error as { name: unknown }).name);
  }
  return undefined;
}

export function isConditionalCheckFailed(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === 'ConditionalCheckFailedException' ||
    (error as { code?: string })?.code === 'ConditionalCheckFailedException'
  );
}

export function isTransactionCanceled(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === 'TransactionCanceledException' ||
    (error as { code?: string })?.code === 'TransactionCanceledException' ||
    Boolean((error as { CancellationReasons?: unknown })?.CancellationReasons)
  );
}

/** Per-action reasons, in the same order as the TransactItems that were sent. */
export function cancellationReasons(error: unknown): CancellationReason[] {
  if (!isTransactionCanceled(error)) {
    return [];
  }
  const reasons = (error as { CancellationReasons?: CancellationReason[] }).CancellationReasons;
  return reasons ?? [];
}

const RETRYABLE_CODES = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
]);

export function hasRetryableReason(reasons: CancellationReason[]): boolean {
  return reasons.some((r) => r.Code !== undefined && RETRYABLE_CODES.has(r.Code));
}

export function conditionFailedAt(reasons: CancellationReason[], index: number): boolean {
  return reasons[index]?.Code === 'ConditionalCheckFailed';
}

export function hasConditionFailed(reasons: CancellationReason[]): boolean {
  return reasons.some((r) => r.Code === 'ConditionalCheckFailed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries only transient cancellations (TransactionConflict, throttling). A failed condition is final. */
export async function sendWithRetry<T>(send: () => Promise<T>, maxAttempts = 8): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const reasons = cancellationReasons(error);
      const transient =
        isTransactionCanceled(error) && hasRetryableReason(reasons) && !hasConditionFailed(reasons);
      if (!transient || attempt >= maxAttempts) throw error;
      await sleep(Math.random() * 25 * attempt);
    }
  }
}
