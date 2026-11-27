import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as fanoutReplayHandler } from '../../../src/handlers/sqs/fanoutReplay';
import { handler as fanoutRetryHandler } from '../../../src/handlers/sqs/fanoutRetry';
import { handler as sendMessageHandler } from '../../../src/handlers/websocket/sendMessage';
import * as repositories from '../../../src/repositories';
import * as shared from '../../../src/shared';
import {
  calculateExponentialBackoffSeconds,
  enqueueFanoutRetries,
  type FanoutRetryMessage,
  resetSqsClient,
  setSqsClient,
} from '../../../src/shared/sqs-fanout';
import {
  createMockEvent,
  type ExpectedResponse,
  mockCallback,
  mockContext,
} from '../websocket/helpers';

function makeRetryPayload(overrides: Partial<FanoutRetryMessage> = {}): FanoutRetryMessage {
  return {
    connectionId: 'conn-bob',
    userId: 'bob',
    endpoint: 'https://test-api.execute-api.ap-south-1.amazonaws.com/dev',
    roomId: 'room-1',
    messageId: 'msg-1',
    sequenceNumber: 1,
    failedAt: '2026-11-26T17:00:00.000Z',
    reason: 'InternalServerError',
    payload: {
      action: 'message',
      roomId: 'room-1',
      sequenceNumber: 1,
      messageId: 'msg-1',
      senderId: 'alice',
      body: 'Hello Bob',
      messageType: 'TEXT',
      createdAt: '2026-11-26T17:00:00.000Z',
    },
    ...overrides,
  };
}

function makeSqsRecord(id: string, body: string, approximateReceiveCount = '1'): SQSRecord {
  return {
    messageId: id,
    receiptHandle: `receipt-${id}`,
    body,
    attributes: {
      ApproximateReceiveCount: approximateReceiveCount,
      SentTimestamp: '1700000000000',
      SenderId: 'test-sender',
      ApproximateFirstReceiveTimestamp: '1700000001000',
    },
    messageAttributes: {},
    md5OfBody: 'md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-south-1:123456789012:fanout-retry',
    awsRegion: 'ap-south-1',
  };
}

describe('Failure Handling, SQS Retries, Exponential Backoff & DLQ Replay', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TABLE_NAME: 'test-table',
      API_GATEWAY_MANAGEMENT_ENDPOINT: 'https://test-api.execute-api.ap-south-1.amazonaws.com/dev',
      FANOUT_RETRY_QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/fanout-retry',
      FANOUT_RETRY_DLQ_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/fanout-retry-dlq',
    };
    resetSqsClient();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSqsClient();
    vi.restoreAllMocks();
  });

  describe('Exponential backoff & SQS batch enqueue', () => {
    it('computes exponential backoff with bounded equal jitter and 300s cap', () => {
      // Deterministic min (random = 0 -> 0.5 * capped) and max (random = 1 -> capped)
      expect(calculateExponentialBackoffSeconds(1, 10, 300, () => 0)).toBe(5);
      expect(calculateExponentialBackoffSeconds(1, 10, 300, () => 1)).toBe(10);
      expect(calculateExponentialBackoffSeconds(2, 10, 300, () => 0)).toBe(10);
      expect(calculateExponentialBackoffSeconds(2, 10, 300, () => 1)).toBe(20);
      expect(calculateExponentialBackoffSeconds(3, 10, 300, () => 0)).toBe(20);
      expect(calculateExponentialBackoffSeconds(3, 10, 300, () => 1)).toBe(40);
      expect(calculateExponentialBackoffSeconds(10, 10, 300, () => 0)).toBe(150);
      expect(calculateExponentialBackoffSeconds(10, 10, 300, () => 1)).toBe(300);

      // Default Math.random stays within [0.5 * capped, capped]
      for (const [attempt, minDelay, maxDelay] of [
        [1, 5, 10],
        [2, 10, 20],
        [3, 20, 40],
        [4, 40, 80],
        [10, 150, 300],
      ] as const) {
        const delay = calculateExponentialBackoffSeconds(attempt);
        expect(delay).toBeGreaterThanOrEqual(minDelay);
        expect(delay).toBeLessThanOrEqual(maxDelay);
      }
    });

    it('retries only failed entries on partial SQS batch failure', async () => {
      const sendMock = vi
        .fn()
        .mockResolvedValueOnce({
          Successful: [{ Id: '0' }, { Id: '1' }],
          Failed: [{ Id: '2', Code: 'InternalError', SenderFault: false }],
        })
        .mockResolvedValueOnce({
          Successful: [{ Id: '2' }],
          Failed: [],
        });
      setSqsClient({ send: sendMock } as unknown as SQSClient);

      const items = [
        makeRetryPayload({ connectionId: 'conn-0' }),
        makeRetryPayload({ connectionId: 'conn-1' }),
        makeRetryPayload({ connectionId: 'conn-2' }),
      ];
      const res = await enqueueFanoutRetries(items);

      expect(sendMock).toHaveBeenCalledTimes(2);
      const retryCmd = sendMock.mock.calls[1][0] as SendMessageBatchCommand;
      expect(retryCmd.input.Entries).toHaveLength(1);
      expect(retryCmd.input.Entries?.[0]?.Id).toBe('2');
      expect(res).toEqual({ enqueued: 3, failed: 0, failedItems: [] });
    });

    it('reports unqueued items when FANOUT_RETRY_QUEUE_URL is missing', async () => {
      delete process.env.FANOUT_RETRY_QUEUE_URL;
      const items = [makeRetryPayload({ connectionId: 'conn-0' })];
      const res = await enqueueFanoutRetries(items);
      expect(res.enqueued).toBe(0);
      expect(res.failed).toBe(1);
      expect(res.failedItems).toHaveLength(1);
    });

    it('chunks enqueueFanoutRetries into batches of 10', async () => {
      const sendMock = vi.fn().mockResolvedValue({ Successful: [{ Id: '0' }], Failed: [] });
      setSqsClient({ send: sendMock } as unknown as SQSClient);

      const items = Array.from({ length: 12 }, (_, idx) =>
        makeRetryPayload({ connectionId: `conn-${idx}` }),
      );
      const res = await enqueueFanoutRetries(items);

      expect(sendMock).toHaveBeenCalledTimes(2);
      const firstCmd = sendMock.mock.calls[0][0] as SendMessageBatchCommand;
      const secondCmd = sendMock.mock.calls[1][0] as SendMessageBatchCommand;
      expect(firstCmd).toBeInstanceOf(SendMessageBatchCommand);
      expect(firstCmd.input.Entries).toHaveLength(10);
      expect(secondCmd.input.Entries).toHaveLength(2);
      expect(res.enqueued).toBe(2);
      expect(res.failed).toBe(0);
    });
  });

  describe('Partial broadcast failure & Lambda timeout simulation in sendMessage', () => {
    function setupRoomSendMocks(connectionIds: string[]) {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
        {
          PK: 'ROOM#room-1',
          SK: 'MEMBER#alice',
          GSI1PK: 'USER#alice',
          GSI1SK: 'ROOM#room-1',
          userId: 'alice',
          roomId: 'room-1',
          role: 'MEMBER',
          joinedAt: '2026-11-26T00:00:00Z',
        },
        {
          PK: 'ROOM#room-1',
          SK: 'MEMBER#bob',
          GSI1PK: 'USER#bob',
          GSI1SK: 'ROOM#room-1',
          userId: 'bob',
          roomId: 'room-1',
          role: 'MEMBER',
          joinedAt: '2026-11-26T00:00:00Z',
        },
      ]);
      vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (userId) => {
        if (userId === 'alice') {
          return [];
        }
        return connectionIds.map((id) => ({
          PK: `USER#bob`,
          SK: `CONN#${id}`,
          userId: 'bob',
          connectionId: id,
          connectedAt: '2026-11-26T00:00:00Z',
          lastHeartbeat: '2026-11-26T00:00:00Z',
        }));
      });
      vi.spyOn(repositories, 'createMessage').mockResolvedValue({
        duplicate: false,
        messageId: 'msg-1',
        sequenceNumber: 5,
        createdAt: '2026-11-26T17:00:00.000Z',
        message: {
          PK: 'ROOM#room-1',
          SK: 'MSG#0000000005',
          roomId: 'room-1',
          sequenceNumber: 5,
          messageId: 'msg-1',
          clientMessageId: 'msg-1',
          senderId: 'alice',
          content: 'Hello',
          messageType: 'TEXT',
          createdAt: '2026-11-26T17:00:00.000Z',
        },
      });
    }

    it('sends only failed deliveries to SQS on partial broadcast failure (skips 410 stale)', async () => {
      setupRoomSendMocks(['conn-ok', 'conn-gone', 'conn-fail']);

      vi.spyOn(shared, 'postToConnection').mockImplementation(async ({ connectionId }) => {
        if (connectionId === 'conn-ok') return true;
        if (connectionId === 'conn-gone') return false;
        throw new Error('500 Internal Server Error');
      });

      const sqsSendMock = vi.fn().mockResolvedValue({
        Successful: [{ Id: '0', MessageId: 'sqs-1' }],
        Failed: [],
      });
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const event = createMockEvent({
        routeKey: 'sendMessage',
        connectionId: 'conn-alice',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          roomId: 'room-1',
          body: 'Hello',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(200);

      expect(sqsSendMock).toHaveBeenCalledTimes(1);
      const batchCmd = sqsSendMock.mock.calls[0][0] as SendMessageBatchCommand;
      expect(batchCmd.input.QueueUrl).toBe(process.env.FANOUT_RETRY_QUEUE_URL);
      expect(batchCmd.input.Entries).toHaveLength(1);
      const queuedBody = JSON.parse(
        batchCmd.input.Entries?.[0]?.MessageBody ?? '{}',
      ) as FanoutRetryMessage;
      expect(queuedBody.connectionId).toBe('conn-fail');
      expect(queuedBody.reason).toBe('500 Internal Server Error');
      expect(queuedBody.payload.body).toBe('Hello');
    });

    it('offloads fan-out to SQS when Lambda approaches timeout', async () => {
      setupRoomSendMocks(['conn-1', 'conn-2']);
      const postSpy = vi.spyOn(shared, 'postToConnection');

      const sqsSendMock = vi.fn().mockResolvedValue({
        Successful: [{ Id: '0' }, { Id: '1' }],
        Failed: [],
      });
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const nearTimeoutContext = {
        getRemainingTimeInMillis: () => 500,
      } as Context;

      const event = createMockEvent({
        routeKey: 'sendMessage',
        connectionId: 'conn-alice',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          roomId: 'room-1',
          body: 'Timeout test',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        nearTimeoutContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(200);
      expect(postSpy).not.toHaveBeenCalled();
      expect(sqsSendMock).toHaveBeenCalledTimes(1);

      const batchCmd = sqsSendMock.mock.calls[0][0] as SendMessageBatchCommand;
      expect(batchCmd.input.Entries).toHaveLength(2);
      const firstQueued = JSON.parse(
        batchCmd.input.Entries?.[0]?.MessageBody ?? '{}',
      ) as FanoutRetryMessage;
      expect(firstQueued.reason).toBe('LambdaTimeoutApproaching');
    });

    it('logs error and preserves 200 ACK when entire SQS request throws', async () => {
      setupRoomSendMocks(['conn-fail']);
      vi.spyOn(shared, 'postToConnection').mockRejectedValue(new Error('500 Upstream error'));
      const sqsSendMock = vi.fn().mockRejectedValue(new Error('SQS Service Unavailable'));
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const event = createMockEvent({
        routeKey: 'sendMessage',
        connectionId: 'conn-alice',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          roomId: 'room-1',
          body: 'SQS throws test',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(200);
      expect(sqsSendMock).toHaveBeenCalledTimes(1);
    });

    it('handles missing FANOUT_RETRY_QUEUE_URL without crashing sender ACK', async () => {
      delete process.env.FANOUT_RETRY_QUEUE_URL;
      setupRoomSendMocks(['conn-fail']);
      vi.spyOn(shared, 'postToConnection').mockRejectedValue(new Error('500 Upstream error'));
      const sqsSendMock = vi.fn();
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const event = createMockEvent({
        routeKey: 'sendMessage',
        connectionId: 'conn-alice',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          roomId: 'room-1',
          body: 'Missing queue url test',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(200);
      expect(sqsSendMock).not.toHaveBeenCalled();
    });
  });

  describe('SQS retry worker & exponential backoff toward DLQ', () => {
    it('delivers successfully on retry and reports no batch item failures', async () => {
      vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);
      const sqsSendMock = vi.fn();
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const event: SQSEvent = {
        Records: [makeSqsRecord('sqs-ok', JSON.stringify(makeRetryPayload()), '1')],
      };

      const res = await fanoutRetryHandler(event);
      expect(res.batchItemFailures).toEqual([]);
      expect(sqsSendMock).not.toHaveBeenCalled();
    });

    it('applies increasing exponential backoff on retries 1, 2, and 3 and returns batchItemFailures', async () => {
      vi.spyOn(shared, 'postToConnection').mockRejectedValue(new Error('503 Service Unavailable'));
      const sqsSendMock = vi.fn().mockResolvedValue({});
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      for (const [attempt, minVisibility, maxVisibility] of [
        ['1', 5, 10],
        ['2', 10, 20],
        ['3', 20, 40],
      ] as const) {
        sqsSendMock.mockClear();
        const event: SQSEvent = {
          Records: [makeSqsRecord(`sqs-${attempt}`, JSON.stringify(makeRetryPayload()), attempt)],
        };

        const res = await fanoutRetryHandler(event);
        expect(res.batchItemFailures).toEqual([{ itemIdentifier: `sqs-${attempt}` }]);
        expect(sqsSendMock).toHaveBeenCalledTimes(1);

        const visCmd = sqsSendMock.mock.calls[0][0] as ChangeMessageVisibilityCommand;
        expect(visCmd).toBeInstanceOf(ChangeMessageVisibilityCommand);
        expect(visCmd.input.VisibilityTimeout).toBeGreaterThanOrEqual(minVisibility);
        expect(visCmd.input.VisibilityTimeout).toBeLessThanOrEqual(maxVisibility);
      }
    });

    it('skips malformed JSON records without poisoning the queue', async () => {
      const event: SQSEvent = {
        Records: [makeSqsRecord('sqs-bad', '{not-valid-json', '1')],
      };

      const res = await fanoutRetryHandler(event);
      expect(res.batchItemFailures).toEqual([]);
    });

    it('acknowledges invalid-schema SQS retry records without poisoning the queue', async () => {
      const postSpy = vi.spyOn(shared, 'postToConnection');
      const event: SQSEvent = {
        Records: [
          makeSqsRecord(
            'sqs-invalid-schema',
            JSON.stringify({ connectionId: 123, payload: null }),
            '1',
          ),
        ],
      };

      const res = await fanoutRetryHandler(event);
      expect(res.batchItemFailures).toEqual([]);
      expect(postSpy).not.toHaveBeenCalled();
    });
  });

  describe('DLQ Replay', () => {
    it('replays DLQ messages, deletes delivered/pruned ones, and keeps failed ones', async () => {
      const msg1 = makeRetryPayload({ connectionId: 'conn-delivered', messageId: 'm1' });
      const msg2 = makeRetryPayload({ connectionId: 'conn-pruned', messageId: 'm2' });
      const msg3 = makeRetryPayload({ connectionId: 'conn-still-failing', messageId: 'm3' });

      vi.spyOn(shared, 'postToConnection').mockImplementation(async ({ connectionId }) => {
        if (connectionId === 'conn-delivered') return true;
        if (connectionId === 'conn-pruned') return false;
        throw new Error('Still failing');
      });

      const sqsSendMock = vi.fn().mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ReceiveMessageCommand) {
          if (
            sqsSendMock.mock.calls.filter((c) => c[0] instanceof ReceiveMessageCommand).length === 1
          ) {
            return {
              Messages: [
                { MessageId: 'dlq-1', ReceiptHandle: 'rh-1', Body: JSON.stringify(msg1) },
                { MessageId: 'dlq-2', ReceiptHandle: 'rh-2', Body: JSON.stringify(msg2) },
                { MessageId: 'dlq-3', ReceiptHandle: 'rh-3', Body: JSON.stringify(msg3) },
              ],
            };
          }
          return { Messages: [] };
        }
        if (cmd instanceof DeleteMessageCommand) {
          return {};
        }
        return {};
      });
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const result = await fanoutReplayHandler({ maxMessages: 10 });
      expect(result).toEqual({
        received: 3,
        delivered: 1,
        pruned: 1,
        quarantined: 0,
        failed: 1,
        stoppedEarly: false,
      });

      const deleteCalls = sqsSendMock.mock.calls
        .map((c) => c[0])
        .filter((c): c is DeleteMessageCommand => c instanceof DeleteMessageCommand);
      expect(deleteCalls.map((c) => c.input.ReceiptHandle)).toEqual(['rh-1', 'rh-2']);
    });

    it('stops safely when replay approaches Lambda timeout', async () => {
      const msg1 = makeRetryPayload({ connectionId: 'conn-1', messageId: 'm1' });
      const msg2 = makeRetryPayload({ connectionId: 'conn-2', messageId: 'm2' });
      const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

      let remainingMs = 30_000;
      const sqsSendMock = vi.fn().mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ReceiveMessageCommand) {
          return {
            Messages: [
              { MessageId: 'dlq-1', ReceiptHandle: 'rh-1', Body: JSON.stringify(msg1) },
              { MessageId: 'dlq-2', ReceiptHandle: 'rh-2', Body: JSON.stringify(msg2) },
            ],
          };
        }
        return {};
      });
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const result = await fanoutReplayHandler({ maxMessages: 10, timeoutBufferMs: 5000 }, {
        getRemainingTimeInMillis: () => {
          const current = remainingMs;
          remainingMs -= 13_000; // 30s -> 17s (msg1 ok) -> 4s (stops before msg2)
          return current;
        },
      } as Context);

      expect(result.stoppedEarly).toBe(true);
      expect(result.delivered).toBe(1);
      expect(postSpy).toHaveBeenCalledTimes(1);
    });

    it('quarantines and deletes malformed DLQ messages', async () => {
      const sqsSendMock = vi.fn().mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ReceiveMessageCommand) {
          if (
            sqsSendMock.mock.calls.filter((c) => c[0] instanceof ReceiveMessageCommand).length === 1
          ) {
            return {
              Messages: [
                { MessageId: 'dlq-bad-json', ReceiptHandle: 'rh-bad', Body: '{broken' },
                {
                  MessageId: 'dlq-bad-schema',
                  ReceiptHandle: 'rh-schema',
                  Body: JSON.stringify({ missingFields: true }),
                },
              ],
            };
          }
          return { Messages: [] };
        }
        return {};
      });
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const result = await fanoutReplayHandler({ maxMessages: 10 });
      expect(result).toEqual({
        received: 2,
        delivered: 0,
        pruned: 0,
        quarantined: 2,
        failed: 0,
        stoppedEarly: false,
      });

      const deleteCalls = sqsSendMock.mock.calls
        .map((c) => c[0])
        .filter((c): c is DeleteMessageCommand => c instanceof DeleteMessageCommand);
      expect(deleteCalls.map((c) => c.input.ReceiptHandle)).toEqual(['rh-bad', 'rh-schema']);
    });

    it('counts failed instead of quarantined when deleting a malformed DLQ message fails', async () => {
      const sqsSendMock = vi.fn().mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ReceiveMessageCommand) {
          if (
            sqsSendMock.mock.calls.filter((c) => c[0] instanceof ReceiveMessageCommand).length === 1
          ) {
            return {
              Messages: [
                { MessageId: 'dlq-bad-json', ReceiptHandle: 'rh-bad', Body: '{broken' },
                { MessageId: 'dlq-no-rh', Body: '{"connectionId":"c1"}' },
              ],
            };
          }
          return { Messages: [] };
        }
        if (cmd instanceof DeleteMessageCommand) {
          throw new Error('SQS DeleteMessage failed');
        }
        return {};
      });
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const result = await fanoutReplayHandler({ maxMessages: 10 });
      expect(result).toEqual({
        received: 2,
        delivered: 0,
        pruned: 0,
        quarantined: 0,
        failed: 2,
        stoppedEarly: false,
      });
    });

    it('continues safely if DeleteMessage fails after successful replay', async () => {
      const msg1 = makeRetryPayload({ connectionId: 'conn-1', messageId: 'm1' });
      vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

      const sqsSendMock = vi.fn().mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof ReceiveMessageCommand) {
          if (
            sqsSendMock.mock.calls.filter((c) => c[0] instanceof ReceiveMessageCommand).length === 1
          ) {
            return {
              Messages: [{ MessageId: 'dlq-1', ReceiptHandle: 'rh-1', Body: JSON.stringify(msg1) }],
            };
          }
          return { Messages: [] };
        }
        if (cmd instanceof DeleteMessageCommand) {
          throw new Error('SQS DeleteMessage failed');
        }
        return {};
      });
      setSqsClient({ send: sqsSendMock } as unknown as SQSClient);

      const result = await fanoutReplayHandler({ maxMessages: 10 });
      expect(result).toEqual({
        received: 1,
        delivered: 1,
        pruned: 0,
        quarantined: 0,
        failed: 0,
        stoppedEarly: false,
      });
    });
  });
});
