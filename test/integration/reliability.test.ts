import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as connectHandler } from '../../src/handlers/websocket/connect';
import { handler as resumeHandler } from '../../src/handlers/websocket/resume';
import { handler as sendMessageHandler } from '../../src/handlers/websocket/sendMessage';
import { createGroupRoom, ensureUserProfile, getRoomSequence } from '../../src/repositories';
import * as shared from '../../src/shared';
import { createTestTable, safeTeardown } from './helpers';

const mockContext = {} as Context;
const mockCallback = () => {};

function makeWsEvent(options: {
  connectionId: string;
  routeKey: string;
  authorizer?: { userId: string; email?: string };
  body?: string;
}): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: options.routeKey,
      messageId: 'msg-rel-test',
      eventType: 'MESSAGE',
      extendedRequestId: 'ext-1',
      requestTime: '2026-11-26T12:00:00Z',
      messageDirection: 'IN',
      stage: 'dev',
      connectedAt: Date.now(),
      requestTimeEpoch: Date.now(),
      requestId: 'req-rel-1',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      connectionId: options.connectionId,
      apiId: 'test-api',
      ...(options.authorizer ? { authorizer: options.authorizer } : {}),
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body: options.body,
  };
}

describe('Phase 11 Delivery Guarantees & Resume Integration (DynamoDB Local)', () => {
  let table: string;

  beforeAll(async () => {
    table = await createTestTable();
    process.env.TABLE_NAME = table;
    process.env.API_GATEWAY_MANAGEMENT_ENDPOINT =
      'https://test.execute-api.ap-south-1.amazonaws.com/dev';
  });

  afterAll(async () => {
    delete process.env.API_GATEWAY_MANAGEMENT_ENDPOINT;
    await safeTeardown(table);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers missed messages on reconnect, detects gaps, and drops duplicates end-to-end', async () => {
    const roomId = 'reliability-room-1';
    const alice = 'user-alice-p11';
    const bob = 'user-bob-p11';

    vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

    await ensureUserProfile({ userId: alice, email: 'alice@example.com' });
    await ensureUserProfile({ userId: bob, email: 'bob@example.com' });
    await createGroupRoom({
      roomId,
      name: 'Reliability Room',
      createdBy: alice,
      members: [
        { userId: alice, role: 'ADMIN' },
        { userId: bob, role: 'MEMBER' },
      ],
      validateUsers: false,
    });

    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-alice-p11',
        routeKey: '$connect',
        authorizer: { userId: alice, email: 'alice@example.com' },
      }),
      mockContext,
      mockCallback,
    );
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-bob-p11',
        routeKey: '$connect',
        authorizer: { userId: bob, email: 'bob@example.com' },
      }),
      mockContext,
      mockCallback,
    );

    // Send 3 messages (1, 2, 3) + 1 duplicate retry of msg-2
    for (const [id, text] of [
      ['msg-1', 'first'],
      ['msg-2', 'second'],
      ['msg-2', 'second'], // duplicate client retry
      ['msg-3', 'third'],
    ]) {
      const res = (await sendMessageHandler(
        makeWsEvent({
          connectionId: 'conn-alice-p11',
          routeKey: 'sendMessage',
          authorizer: { userId: alice, email: 'alice@example.com' },
          body: JSON.stringify({
            action: 'sendMessage',
            roomId,
            messageId: id,
            body: text,
          }),
        }),
        mockContext,
        mockCallback,
      )) as shared.WebSocketResponse;
      expect(res.statusCode).toBe(200);
    }

    // Only 3 messages stored despite 4 send calls
    expect(await getRoomSequence(roomId)).toBe(3);

    // Bob's client processed seq 1, then receives seq 3 out-of-order (missed seq 2 while offline)
    const bobTracker = new shared.RoomSequenceTracker<{ sequenceNumber: number; content: string }>(
      1,
    );
    const outOfOrder = bobTracker.ingest({ sequenceNumber: 3, content: 'third' });
    expect(outOfOrder.gapDetected).toBe(true);
    expect(outOfOrder.missingAfterSequence).toBe(1);

    // Bob reconnects and invokes WebSocket `resume` from lastProcessedSequence = 1
    const resumeRes = (await resumeHandler(
      makeWsEvent({
        connectionId: 'conn-bob-p11',
        routeKey: 'resume',
        body: JSON.stringify({
          action: 'resume',
          rooms: [{ roomId, lastSequence: bobTracker.getLastProcessedSequence() }],
        }),
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;

    expect(resumeRes.statusCode).toBe(200);
    const ack = JSON.parse(resumeRes.body) as shared.ResumeAckPayload;
    expect(ack.action).toBe('resumeAck');
    expect(ack.rooms[0].messages.map((m) => m.sequenceNumber)).toEqual([2, 3]);

    // Apply recovery -> delivers 2 and drains buffered 3, dropping duplicate 3
    const recovered = bobTracker.applyRecovery(ack.rooms[0].messages);
    expect(recovered.delivered.map((m) => m.sequenceNumber)).toEqual([2, 3]);
    expect(recovered.duplicateCount).toBe(1);
    expect(recovered.hasRemainingGap).toBe(false);
    expect(bobTracker.getLastProcessedSequence()).toBe(3);
  }, 30_000);
});
