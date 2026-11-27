import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import {
  calculateExponentialBackoffSeconds,
  type FanoutRetryMessage,
  fanoutRetryMessageSchema,
  logger,
  postToConnection,
  updateMessageVisibility,
} from '../../shared';

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];
  const queueUrl = process.env.FANOUT_RETRY_QUEUE_URL;

  for (const record of event.Records) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.body);
    } catch (parseError) {
      logger.error(
        'Invalid fan-out retry SQS JSON; acknowledging to avoid poison loop',
        parseError instanceof Error ? parseError : new Error(String(parseError)),
        { sqsMessageId: record.messageId },
      );
      continue;
    }

    const validation = fanoutRetryMessageSchema.safeParse(parsed);
    if (!validation.success) {
      logger.error(
        'Invalid fan-out retry SQS message schema; acknowledging to avoid poison loop',
        undefined,
        {
          sqsMessageId: record.messageId,
          issues: validation.error.issues.map((i) => i.message),
        },
      );
      continue;
    }

    const item: FanoutRetryMessage = validation.data;

    try {
      const delivered = await postToConnection({
        connectionId: item.connectionId,
        userId: item.userId,
        payload: item.payload,
        endpoint: item.endpoint,
      });

      logger.info('Processed fan-out retry record', {
        sqsMessageId: record.messageId,
        connectionId: item.connectionId,
        roomId: item.roomId,
        messageId: item.messageId,
        sequenceNumber: item.sequenceNumber,
        delivered,
      });
    } catch (error) {
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? '1');
      const backoffSeconds = calculateExponentialBackoffSeconds(receiveCount);

      if (queueUrl && record.receiptHandle) {
        try {
          await updateMessageVisibility({
            queueUrl,
            receiptHandle: record.receiptHandle,
            visibilityTimeoutSeconds: backoffSeconds,
          });
        } catch (visError) {
          logger.warn('Failed to update SQS visibility timeout for exponential backoff', {
            sqsMessageId: record.messageId,
            backoffSeconds,
            error: visError instanceof Error ? visError.message : String(visError),
          });
        }
      }

      logger.warn('Fan-out retry failed; scheduling SQS retry with exponential backoff', {
        sqsMessageId: record.messageId,
        connectionId: item.connectionId,
        roomId: item.roomId,
        messageId: item.messageId,
        receiveCount,
        backoffSeconds,
        error: error instanceof Error ? error.message : String(error),
      });

      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
