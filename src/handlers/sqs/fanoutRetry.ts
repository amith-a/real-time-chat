import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import {
  calculateExponentialBackoffSeconds,
  type FanoutRetryMessage,
  logger,
  postToConnection,
  updateMessageVisibility,
} from '../../shared';

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];
  const queueUrl = process.env.FANOUT_RETRY_QUEUE_URL;

  for (const record of event.Records) {
    let item: FanoutRetryMessage;
    try {
      item = JSON.parse(record.body) as FanoutRetryMessage;
    } catch (parseError) {
      logger.error(
        'Invalid fan-out retry SQS payload; skipping to avoid poison loop',
        parseError instanceof Error ? parseError : new Error(String(parseError)),
        { sqsMessageId: record.messageId },
      );
      continue;
    }

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
