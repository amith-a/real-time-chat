import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import {
  type FanoutRetryMessage,
  getSqsClient,
  logger,
  postToConnection,
  SQS_MAX_BATCH_SIZE,
} from '../../shared';

export interface ReplayDlqInput {
  maxMessages?: number;
  dlqUrl?: string;
  visibilityTimeoutSeconds?: number;
  client?: SQSClient;
}

export interface ReplayDlqResult {
  received: number;
  delivered: number;
  pruned: number;
  failed: number;
}

/**
 * Drains messages from the fan-out DLQ and replays delivery to WebSocket connections.
 * Successfully delivered or 410-pruned messages are deleted from the DLQ;
 * messages that still fail remain in the DLQ for later inspection or replay.
 */
export async function replayDlqMessages(input: ReplayDlqInput = {}): Promise<ReplayDlqResult> {
  const dlqUrl = input.dlqUrl || process.env.FANOUT_RETRY_DLQ_URL;
  if (!dlqUrl) {
    throw new Error('FANOUT_RETRY_DLQ_URL is not configured');
  }

  const maxMessages = Math.max(1, input.maxMessages ?? 100);
  const visibilityTimeoutSeconds = input.visibilityTimeoutSeconds ?? 30;
  const client = input.client || getSqsClient();

  let received = 0;
  let delivered = 0;
  let pruned = 0;
  let failed = 0;

  while (received < maxMessages) {
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
      received++;
      if (!msg.Body || !msg.ReceiptHandle) {
        failed++;
        continue;
      }

      let item: FanoutRetryMessage;
      try {
        item = JSON.parse(msg.Body) as FanoutRetryMessage;
      } catch (parseError) {
        logger.error(
          'Invalid DLQ message JSON during replay',
          parseError instanceof Error ? parseError : new Error(String(parseError)),
          { sqsMessageId: msg.MessageId },
        );
        failed++;
        continue;
      }

      try {
        const sent = await postToConnection({
          connectionId: item.connectionId,
          userId: item.userId,
          payload: item.payload,
          endpoint: item.endpoint,
        });

        await client.send(
          new DeleteMessageCommand({
            QueueUrl: dlqUrl,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );

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
  }

  logger.info('DLQ replay completed', {
    dlqUrl,
    received,
    delivered,
    pruned,
    failed,
  });

  return { received, delivered, pruned, failed };
}

export const handler = async (event: ReplayDlqInput = {}): Promise<ReplayDlqResult> => {
  return replayDlqMessages(event);
};
