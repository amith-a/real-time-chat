import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Context } from 'aws-lambda';
import {
  type FanoutRetryMessage,
  fanoutRetryMessageSchema,
  getSqsClient,
  logger,
  postToConnection,
  SQS_MAX_BATCH_SIZE,
} from '../../shared';

export const DEFAULT_REPLAY_MAX_MESSAGES = 25;
export const DEFAULT_REPLAY_VISIBILITY_TIMEOUT_SECONDS = 60;
export const DEFAULT_REPLAY_TIMEOUT_BUFFER_MS = 5000;

export interface ReplayDlqInput {
  maxMessages?: number;
  dlqUrl?: string;
  visibilityTimeoutSeconds?: number;
  timeoutBufferMs?: number;
  getRemainingTimeInMillis?: () => number;
  client?: SQSClient;
}

export interface ReplayDlqResult {
  received: number;
  delivered: number;
  pruned: number;
  quarantined: number;
  failed: number;
  stoppedEarly: boolean;
}

function isValidRetryMessage(value: unknown): value is FanoutRetryMessage {
  return fanoutRetryMessageSchema.safeParse(value).success;
}

/**
 * Drains messages from the fan-out DLQ and replays delivery to WebSocket connections.
 * - Stops safely before approaching Lambda timeout.
 * - Quarantines (logs + deletes) malformed DLQ messages so they do not poison future replays.
 * - Deletes delivered or 410-pruned messages; still-failing valid messages remain in the DLQ.
 */
export async function replayDlqMessages(input: ReplayDlqInput = {}): Promise<ReplayDlqResult> {
  const dlqUrl = input.dlqUrl || process.env.FANOUT_RETRY_DLQ_URL;
  if (!dlqUrl) {
    throw new Error('FANOUT_RETRY_DLQ_URL is not configured');
  }

  const maxMessages = Math.max(1, input.maxMessages ?? DEFAULT_REPLAY_MAX_MESSAGES);
  const visibilityTimeoutSeconds =
    input.visibilityTimeoutSeconds ?? DEFAULT_REPLAY_VISIBILITY_TIMEOUT_SECONDS;
  const timeoutBufferMs = input.timeoutBufferMs ?? DEFAULT_REPLAY_TIMEOUT_BUFFER_MS;
  const getRemainingTime = input.getRemainingTimeInMillis;
  const client = input.client || getSqsClient();

  let received = 0;
  let delivered = 0;
  let pruned = 0;
  let quarantined = 0;
  let failed = 0;
  let stoppedEarly = false;

  const isNearTimeout = (): boolean =>
    typeof getRemainingTime === 'function' && getRemainingTime() <= timeoutBufferMs;

  const quarantineMessage = async (
    sqsMessageId: string | undefined,
    receiptHandle: string,
    reason: string,
  ): Promise<boolean> => {
    try {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: receiptHandle }),
      );
      return true;
    } catch (deleteError) {
      logger.warn('Failed to delete quarantined DLQ message; counting as failed', {
        sqsMessageId,
        reason,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
      return false;
    }
  };

  while (received < maxMessages) {
    if (isNearTimeout()) {
      stoppedEarly = true;
      logger.warn('DLQ replay stopping early to avoid Lambda timeout', {
        dlqUrl,
        received,
        remainingTimeMs: getRemainingTime?.(),
      });
      break;
    }

    const batchLimit = Math.min(SQS_MAX_BATCH_SIZE, maxMessages - received);
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: batchLimit,
        VisibilityTimeout: visibilityTimeoutSeconds,
        WaitTimeSeconds: 0,
      }),
    );

    const messages = response.Messages ?? [];
    if (messages.length === 0) {
      break;
    }

    for (const msg of messages) {
      if (isNearTimeout()) {
        stoppedEarly = true;
        logger.warn('DLQ replay stopping mid-batch to avoid Lambda timeout', {
          dlqUrl,
          received,
          remainingTimeMs: getRemainingTime?.(),
        });
        break;
      }

      received++;
      // SQS deletion requires a ReceiptHandle; messages missing Body or ReceiptHandle are unprocessable.
      if (!msg.Body || !msg.ReceiptHandle) {
        logger.error(
          'Unprocessable DLQ message missing Body or ReceiptHandle; cannot quarantine',
          undefined,
          {
            sqsMessageId: msg.MessageId,
            hasBody: Boolean(msg.Body),
            hasReceiptHandle: Boolean(msg.ReceiptHandle),
          },
        );
        failed++;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.Body);
      } catch (parseError) {
        logger.error(
          'Quarantining malformed JSON DLQ message',
          parseError instanceof Error ? parseError : new Error(String(parseError)),
          { sqsMessageId: msg.MessageId, bodyPreview: msg.Body.slice(0, 200) },
        );
        if (await quarantineMessage(msg.MessageId, msg.ReceiptHandle, 'malformed_json')) {
          quarantined++;
        } else {
          failed++;
        }
        continue;
      }

      if (!isValidRetryMessage(parsed)) {
        logger.error('Quarantining DLQ message with invalid schema', undefined, {
          sqsMessageId: msg.MessageId,
          bodyPreview: msg.Body.slice(0, 200),
        });
        if (await quarantineMessage(msg.MessageId, msg.ReceiptHandle, 'invalid_schema')) {
          quarantined++;
        } else {
          failed++;
        }
        continue;
      }

      const item = parsed;

      try {
        const sent = await postToConnection({
          connectionId: item.connectionId,
          userId: item.userId,
          payload: item.payload,
          endpoint: item.endpoint,
        });

        try {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: dlqUrl,
              ReceiptHandle: msg.ReceiptHandle,
            }),
          );
        } catch (deleteError) {
          logger.warn('DLQ replay delivered message but failed to delete from DLQ', {
            sqsMessageId: msg.MessageId,
            connectionId: item.connectionId,
            roomId: item.roomId,
            messageId: item.messageId,
            error: deleteError instanceof Error ? deleteError.message : String(deleteError),
          });
        }

        if (sent) {
          delivered++;
        } else {
          pruned++;
        }
      } catch (error) {
        failed++;
        logger.warn('DLQ replay delivery failed; keeping message in DLQ', {
          sqsMessageId: msg.MessageId,
          connectionId: item.connectionId,
          roomId: item.roomId,
          messageId: item.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (stoppedEarly) {
      break;
    }
  }

  logger.info('DLQ replay completed', {
    dlqUrl,
    received,
    delivered,
    pruned,
    quarantined,
    failed,
    stoppedEarly,
  });

  return { received, delivered, pruned, quarantined, failed, stoppedEarly };
}

export const handler = async (
  event: ReplayDlqInput = {},
  context?: Context,
): Promise<ReplayDlqResult> => {
  return replayDlqMessages({
    ...event,
    getRemainingTimeInMillis:
      event.getRemainingTimeInMillis ??
      (typeof context?.getRemainingTimeInMillis === 'function'
        ? () => context.getRemainingTimeInMillis()
        : undefined),
  });
};
