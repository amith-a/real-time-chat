import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type KeyValueStorage,
  LocalStorageSequenceStore,
  RoomSequenceTracker,
} from '../../client/room-sync';
import { handler as connectHandler } from '../../src/handlers/websocket/connect';
import { handler as disconnectHandler } from '../../src/handlers/websocket/disconnect';
import { handler as resumeHandler } from '../../src/handlers/websocket/resume';
import { handler as sendMessageHandler } from '../../src/handlers/websocket/sendMessage';
import {
  createGroupRoom,
  ensureUserProfile,
  getConnection,
  getRoomSequence,
} from '../../src/repositories';
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

  it('disconnects, reconnects with a new connection, recovers paginated messages, and drops duplicates', async () => {
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

    // 1. Bob connects on old connection and receives seq 1
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-bob-old',
        routeKey: '$connect',
        authorizer: { userId: bob, email: 'bob@example.com' },
      }),
      mockContext,
      mockCallback,
    );

    await sendMessageHandler(
      makeWsEvent({
        connectionId: 'conn-alice-p11',
        routeKey: 'sendMessage',
        authorizer: { userId: alice, email: 'alice@example.com' },
        body: JSON.stringify({
          action: 'sendMessage',
          roomId,
          messageId: 'msg-1',
          body: 'first',
        }),
      }),
      mockContext,
      mockCallback,
    );

    const backingStorage = new Map<string, string>();
    const browserStorage: KeyValueStorage = {
      getItem: (k) => backingStorage.get(k) ?? null,
      setItem: (k, v) => {
        backingStorage.set(k, v);
      },
    };
    const bobStoreSession1 = new LocalStorageSequenceStore(browserStorage);
    const bobTrackerSession1 = new RoomSequenceTracker<{
      sequenceNumber: number;
      body: string;
    }>(0, { roomId, store: bobStoreSession1 });
    bobTrackerSession1.ingest({ sequenceNumber: 1, body: 'first' });

    // 2. Bob disconnects -> disconnectHandler removes conn-bob-old
    const discRes = (await disconnectHandler(
      makeWsEvent({
        connectionId: 'conn-bob-old',
        routeKey: '$disconnect',
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    expect(discRes.statusCode).toBe(200);
    expect(await getConnection(bob, 'conn-bob-old', true)).toBeUndefined();

    // 3. While Bob is offline, Alice sends messages 2, 3, 4 (plus 1 duplicate retry of msg-2)
    for (const [id, text] of [
      ['msg-2', 'second'],
      ['msg-2', 'second'], // duplicate client retry
      ['msg-3', 'third'],
      ['msg-4', 'fourth'],
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
    expect(await getRoomSequence(roomId)).toBe(4);

    // 4. Bob reconnects on a NEW connection (conn-bob-new) and restores lastSequence=1 from LocalStorageSequenceStore
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-bob-new',
        routeKey: '$connect',
        authorizer: { userId: bob, email: 'bob@example.com' },
      }),
      mockContext,
      mockCallback,
    );

    const bobStoreSession2 = new LocalStorageSequenceStore(browserStorage);
    const bobTrackerSession2 = new RoomSequenceTracker<{
      sequenceNumber: number;
      body: string;
    }>(0, { roomId, store: bobStoreSession2 });
    expect(bobTrackerSession2.getLastProcessedSequence()).toBe(1);

    // Live message seq 4 arrives right before resume recovery completes -> buffered as gap
    const gapRes = bobTrackerSession2.ingest({ sequenceNumber: 4, body: 'fourth' });
    expect(gapRes.gapDetected).toBe(true);
    expect(gapRes.missingAfterSequence).toBe(1);

    // 5. Bob calls resume on conn-bob-new with limitPerRoom=2 -> Page 1 ([2, 3], hasMore=true)
    const resumePage1 = (await resumeHandler(
      makeWsEvent({
        connectionId: 'conn-bob-new',
        routeKey: 'resume',
        body: JSON.stringify({
          action: 'resume',
          rooms: [{ roomId, lastSequence: bobTrackerSession2.getLastProcessedSequence() }],
          limitPerRoom: 2,
        }),
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;

    expect(resumePage1.statusCode).toBe(200);
    const ack1 = JSON.parse(resumePage1.body) as shared.ResumeAckPayload;
    expect(ack1.rooms[0].hasMore).toBe(true);
    expect(ack1.rooms[0].nextAfterSequence).toBe(3);
    expect(ack1.rooms[0].messages.map((m) => m.sequenceNumber)).toEqual([2, 3]);

    // Page 2 from nextAfterSequence=3 -> ([4], hasMore=false)
    const resumePage2 = (await resumeHandler(
      makeWsEvent({
        connectionId: 'conn-bob-new',
        routeKey: 'resume',
        body: JSON.stringify({
          action: 'resume',
          rooms: [{ roomId, lastSequence: ack1.rooms[0].nextAfterSequence }],
          limitPerRoom: 2,
        }),
      }),
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;

    expect(resumePage2.statusCode).toBe(200);
    const ack2 = JSON.parse(resumePage2.body) as shared.ResumeAckPayload;
    expect(ack2.rooms[0].hasMore).toBe(false);
    expect(ack2.rooms[0].messages.map((m) => m.sequenceNumber)).toEqual([4]);

    // 6. Apply both recovered pages -> delivers 2, 3, and drains buffered 4 while dropping duplicate 4
    const rec1 = bobTrackerSession2.applyRecovery(ack1.rooms[0].messages);
    expect(rec1.delivered.map((m) => m.sequenceNumber)).toEqual([2, 3, 4]);
    expect(rec1.hasRemainingGap).toBe(false);

    const rec2 = bobTrackerSession2.applyRecovery(ack2.rooms[0].messages);
    expect(rec2.delivered).toEqual([]);
    expect(rec2.duplicateCount).toBe(1);
    expect(bobTrackerSession2.getLastProcessedSequence()).toBe(4);
    expect(bobStoreSession2.getLastSequence(roomId)).toBe(4);
  }, 30_000);
});
