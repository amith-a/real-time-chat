import {
  ChangeMessageVisibilityCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { logger } from './logger';
import type { MessageDeliveryPayload } from './schemas';

export const SQS_MAX_BATCH_SIZE = 10;
export const DEFAULT_RETRY_BASE_DELAY_SECONDS = 10;
export const DEFAULT_RETRY_MAX_DELAY_SECONDS = 300;

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

let injectedSqsClient: SQSClient | undefined;
let cachedSqsClient: SQSClient | undefined;

export function getSqsClient(): SQSClient {
  if (injectedSqsClient) {
    return injectedSqsClient;
  }
  if (!cachedSqsClient) {
    cachedSqsClient = new SQSClient({});
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
 * Computes exponential backoff delay (in seconds) for SQS redelivery
 * based on `ApproximateReceiveCount`.
 */
export function calculateExponentialBackoffSeconds(
  receiveCount: number,
  baseDelaySeconds = DEFAULT_RETRY_BASE_DELAY_SECONDS,
  maxDelaySeconds = DEFAULT_RETRY_MAX_DELAY_SECONDS,
): number {
  const safeCount = Math.max(1, Math.floor(receiveCount));
  const delay = baseDelaySeconds * 2 ** (safeCount - 1);
  return Math.min(maxDelaySeconds, delay);
}

/**
 * Sends failed fan-out delivery tasks to SQS in batches of up to 10.
 */
export async function enqueueFanoutRetries(
  items: readonly FanoutRetryMessage[],
  queueUrl = process.env.FANOUT_RETRY_QUEUE_URL,
  customClient?: SQSClient,
): Promise<{ enqueued: number; failed: number }> {
  if (!queueUrl || items.length === 0) {
    return { enqueued: 0, failed: 0 };
  }

  const client = customClient || getSqsClient();
  let enqueued = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i += SQS_MAX_BATCH_SIZE) {
    const batch = items.slice(i, i + SQS_MAX_BATCH_SIZE);
    const result = await client.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((item, idx) => ({
          Id: `${i + idx}`,
          MessageBody: JSON.stringify(item),
          MessageAttributes: {
            roomId: { DataType: 'String', StringValue: item.roomId },
            messageId: { DataType: 'String', StringValue: item.messageId },
          },
        })),
      }),
    );

    const batchEnqueued = result.Successful?.length ?? 0;
    const batchFailed = result.Failed?.length ?? 0;
    enqueued += batchEnqueued;
    failed += batchFailed;

    if (batchFailed > 0) {
      logger.warn('Some fan-out retry entries failed to enqueue to SQS', {
        queueUrl,
        failedEntries: result.Failed,
      });
    }
  }

  return { enqueued, failed };
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
