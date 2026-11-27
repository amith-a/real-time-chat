import {
  SQSClient as AwsSQSClient,
  ChangeMessageVisibilityCommand,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { logger } from './logger';
import type { MessageDeliveryPayload } from './schemas';

export const SQS_MAX_BATCH_SIZE = 10;
export const DEFAULT_RETRY_BASE_DELAY_SECONDS = 10;
export const DEFAULT_RETRY_MAX_DELAY_SECONDS = 300;
export const DEFAULT_SQS_ENQUEUE_MAX_RETRIES = 2;

export interface FanoutRetryMessage {
  connectionId: string;
  userId: string;
  endpoint: string;
  payload: MessageDeliveryPayload;
  roomId: string;
  messageId: string;
  sequenceNumber: number;
  failedAt: string;
  reason?: string;
}

export interface EnqueueFanoutRetriesResult {
  enqueued: number;
  failed: number;
  failedItems: FanoutRetryMessage[];
}

let injectedSqsClient: SQSClient | undefined;
let cachedSqsClient: SQSClient | undefined;

export function getSqsClient(): SQSClient {
  if (injectedSqsClient) {
    return injectedSqsClient;
  }
  if (!cachedSqsClient) {
    cachedSqsClient = new AwsSQSClient({});
  }
  return cachedSqsClient;
}

export function setSqsClient(client: SQSClient | undefined): void {
  injectedSqsClient = client;
}

export function resetSqsClient(): void {
  injectedSqsClient = undefined;
  cachedSqsClient = undefined;
}

/**
 * Computes exponential backoff with bounded equal jitter (in seconds) for SQS redelivery
 * based on `ApproximateReceiveCount`. Spreads retries across `[capped * 0.5, capped]`.
 */
export function calculateExponentialBackoffSeconds(
  receiveCount: number,
  baseDelaySeconds = DEFAULT_RETRY_BASE_DELAY_SECONDS,
  maxDelaySeconds = DEFAULT_RETRY_MAX_DELAY_SECONDS,
  randomFn: () => number = Math.random,
): number {
  const safeCount = Number.isFinite(receiveCount) ? Math.max(1, Math.floor(receiveCount)) : 1;
  const capped = Math.min(maxDelaySeconds, baseDelaySeconds * 2 ** (safeCount - 1));
  const jittered = Math.floor(capped * (0.5 + 0.5 * randomFn()));
  return Math.max(1, Math.min(maxDelaySeconds, jittered));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends failed fan-out delivery tasks to SQS in batches of up to 10.
 * Retries only failed batch entries with bounded exponential backoff.
 */
export async function enqueueFanoutRetries(
  items: readonly FanoutRetryMessage[],
  queueUrl = process.env.FANOUT_RETRY_QUEUE_URL,
  customClient?: SQSClient,
  maxBatchRetries = DEFAULT_SQS_ENQUEUE_MAX_RETRIES,
): Promise<EnqueueFanoutRetriesResult> {
  if (items.length === 0) {
    return { enqueued: 0, failed: 0, failedItems: [] };
  }

  if (!queueUrl) {
    return { enqueued: 0, failed: items.length, failedItems: [...items] };
  }

  const client = customClient || getSqsClient();
  let enqueued = 0;
  const failedItems: FanoutRetryMessage[] = [];

  for (let i = 0; i < items.length; i += SQS_MAX_BATCH_SIZE) {
    let pending = items.slice(i, i + SQS_MAX_BATCH_SIZE).map((item, idx) => ({
      id: `${i + idx}`,
      item,
    }));

    for (let attempt = 0; attempt <= maxBatchRetries && pending.length > 0; attempt++) {
      if (attempt > 0) {
        const delayMs = 25 * 2 ** (attempt - 1);
        await sleep(delayMs);
      }

      const result = await client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: pending.map((entry) => ({
            Id: entry.id,
            MessageBody: JSON.stringify(entry.item),
            MessageAttributes: {
              roomId: { DataType: 'String', StringValue: entry.item.roomId },
              messageId: { DataType: 'String', StringValue: entry.item.messageId },
            },
          })),
        }),
      );

      enqueued += result.Successful?.length ?? 0;

      const failedEntries = result.Failed ?? [];
      if (failedEntries.length === 0) {
        pending = [];
        break;
      }

      const failedById = new Map(failedEntries.map((f) => [f.Id, f]));
      const nextPending: typeof pending = [];

      for (const entry of pending) {
        const failure = failedById.get(entry.id);
        if (!failure) continue;

        if (failure.SenderFault || attempt === maxBatchRetries) {
          failedItems.push(entry.item);
          logger.error('SQS fan-out retry batch entry failed', undefined, {
            queueUrl,
            entryId: entry.id,
            connectionId: entry.item.connectionId,
            roomId: entry.item.roomId,
            messageId: entry.item.messageId,
            code: failure.Code,
            senderFault: failure.SenderFault,
            errorMessage: failure.Message,
          });
        } else {
          nextPending.push(entry);
        }
      }

      pending = nextPending;
    }
  }

  return {
    enqueued,
    failed: failedItems.length,
    failedItems,
  };
}

export async function updateMessageVisibility(input: {
  queueUrl: string;
  receiptHandle: string;
  visibilityTimeoutSeconds: number;
  client?: SQSClient;
}): Promise<void> {
  const client = input.client || getSqsClient();
  await client.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: input.queueUrl,
      ReceiptHandle: input.receiptHandle,
      VisibilityTimeout: input.visibilityTimeoutSeconds,
    }),
  );
}
