import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as connectHandler } from '../../src/handlers/websocket/connect';
import { handler as sendMessageHandler } from '../../src/handlers/websocket/sendMessage';
import {
  createGroupRoom,
  directRoomId,
  ensureUserProfile,
  getConnection,
  getIdempotencyRecord,
  getMessage,
  getPresence,
  getRoom,
  getRoomSequence,
  isMember,
} from '../../src/repositories';
import * as shared from '../../src/shared';
import { createTestTable, safeTeardown } from './helpers';

const mockContext = {} as Context;
const mockCallback = () => {};

function makeWsEvent(options: {
  connectionId: string;
  routeKey?: string;
  authorizer: { userId: string; email?: string; username?: string };
  body?: string;
}): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: options.routeKey || 'sendMessage',
      messageId: 'msg-ws-req',
      eventType: 'MESSAGE',
      extendedRequestId: 'ext-req-1',
      requestTime: '2026-11-24T10:00:00Z',
      messageDirection: 'IN',
      stage: 'dev',
      connectedAt: 1700000000,
      requestTimeEpoch: 1700000000,
      requestId: 'req-1',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      connectionId: options.connectionId,
      apiId: 'test-api',
      authorizer: options.authorizer,
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body: options.body,
  };
}

describe('sendMessage integration (DynamoDB Local)', () => {
  let table: string;

  beforeAll(async () => {
    table = await createTestTable();
    process.env.TABLE_NAME = table;
    process.env.API_GATEWAY_MANAGEMENT_ENDPOINT =
      'https://test.execute-api.ap-south-1.amazonaws.com/dev';
  });

  afterAll(async () => {
    await safeTeardown(table);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('orchestrates direct 1:1 message creation, delivery, idempotency, and room checks', async () => {
    const aliceId = 'user-alice';
    const bobId = 'user-bob';

    // 1. Connect Alice (tab 1 and tab 2) and Bob (tab 1) via $connect
    const connectAlice1 = makeWsEvent({
      connectionId: 'conn-alice-tab1',
      routeKey: '$connect',
      authorizer: { userId: aliceId, email: 'alice@example.com' },
    });
    const connectAlice2 = makeWsEvent({
      connectionId: 'conn-alice-tab2',
      routeKey: '$connect',
      authorizer: { userId: aliceId, email: 'alice@example.com' },
    });
    const connectBob1 = makeWsEvent({
      connectionId: 'conn-bob-tab1',
      routeKey: '$connect',
      authorizer: { userId: bobId, email: 'bob@example.com' },
    });

    await connectHandler(connectAlice1, mockContext, mockCallback);
    await connectHandler(connectAlice2, mockContext, mockCallback);
    await connectHandler(connectBob1, mockContext, mockCallback);

    // Verify presence and connections in DB
    const alicePresence = await getPresence(aliceId);
    expect(alicePresence?.activeConnectionCount).toBe(2);
    const bobPresence = await getPresence(bobId);
    expect(bobPresence?.activeConnectionCount).toBe(1);

    // Spy on postToConnection to record fan-out delivery
    const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

    // 2. Alice sends a direct message to Bob from tab 1
    const sendEvent1 = makeWsEvent({
      connectionId: 'conn-alice-tab1',
      routeKey: 'sendMessage',
      authorizer: { userId: aliceId, email: 'alice@example.com' },
      body: JSON.stringify({
        action: 'sendMessage',
        messageId: 'client-msg-1',
        recipientUserId: bobId,
        body: 'Hello Bob from Alice!',
      }),
    });

    const res1 = (await sendMessageHandler(
      sendEvent1,
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;

    expect(res1.statusCode).toBe(200);
    const ack1 = JSON.parse(res1.body);
    const expectedRoomId = directRoomId(aliceId, bobId);

    expect(ack1).toEqual({
      action: 'ack',
      messageId: 'client-msg-1',
      roomId: expectedRoomId,
      sequenceNumber: 1,
      createdAt: expect.any(String),
      isDuplicate: false,
    });

    // 3. Verify DynamoDB single-table state
    // Room META exists
    const room = await getRoom(expectedRoomId);
    expect(room).toBeDefined();
    expect(room?.roomType).toBe('DIRECT');
    expect(room?.memberCount).toBe(2);

    // Memberships exist
    expect(await isMember(aliceId, expectedRoomId)).toBe(true);
    expect(await isMember(bobId, expectedRoomId)).toBe(true);

    // Room counter is 1
    const seq = await getRoomSequence(expectedRoomId);
    expect(seq).toBe(1);

    // Message item exists in DynamoDB
    const savedMsg1 = await getMessage(expectedRoomId, 1);
    expect(savedMsg1).toBeDefined();
    expect(savedMsg1?.clientMessageId).toBe('client-msg-1');
    expect(savedMsg1?.senderId).toBe(aliceId);
    expect(savedMsg1?.content).toBe('Hello Bob from Alice!');
    expect(savedMsg1?.sequenceNumber).toBe(1);

    // Delivery fan-out: Delivered to Bob (tab 1) and Alice (tab 2), but not Alice (tab 1)
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-bob-tab1',
        userId: bobId,
        payload: expect.objectContaining({
          action: 'message',
          body: 'Hello Bob from Alice!',
          sequenceNumber: 1,
        }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-alice-tab2',
        userId: aliceId,
      }),
    );

    // 4. Send a second message
    postSpy.mockClear();
    const sendEvent2 = makeWsEvent({
      connectionId: 'conn-alice-tab1',
      routeKey: 'sendMessage',
      authorizer: { userId: aliceId, email: 'alice@example.com' },
      body: JSON.stringify({
        action: 'sendMessage',
        messageId: 'client-msg-2',
        recipientUserId: bobId,
        body: 'Second message!',
      }),
    });

    const res2 = (await sendMessageHandler(
      sendEvent2,
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    const ack2 = JSON.parse(res2.body);
    expect(ack2.sequenceNumber).toBe(2);
    expect(ack2.isDuplicate).toBe(false);

    const seqAfterMsg2 = await getRoomSequence(expectedRoomId);
    expect(seqAfterMsg2).toBe(2);

    // 5. Test idempotency: re-sending messageId "client-msg-1"
    postSpy.mockClear();
    const resDuplicate = (await sendMessageHandler(
      sendEvent1,
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    const ackDuplicate = JSON.parse(resDuplicate.body);

    expect(ackDuplicate).toEqual({
      action: 'ack',
      messageId: 'client-msg-1',
      roomId: expectedRoomId,
      sequenceNumber: 1,
      createdAt: expect.any(String),
      isDuplicate: true,
    });

    // Sequence did not advance and no fan-out was triggered
    expect(await getRoomSequence(expectedRoomId)).toBe(2);
    expect(postSpy).not.toHaveBeenCalled();

    // 6. Test room send by roomId
    const roomSendEvent = makeWsEvent({
      connectionId: 'conn-alice-tab1',
      routeKey: 'sendMessage',
      authorizer: { userId: aliceId, email: 'alice@example.com' },
      body: JSON.stringify({
        action: 'sendMessage',
        messageId: 'client-msg-3',
        roomId: expectedRoomId,
        body: 'Broadcast into room!',
      }),
    });

    const resRoomSend = (await sendMessageHandler(
      roomSendEvent,
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    const ackRoomSend = JSON.parse(resRoomSend.body);
    expect(ackRoomSend.sequenceNumber).toBe(3);
    expect(ackRoomSend.isDuplicate).toBe(false);

    // 7. Non-member unauthorized access check
    const charlieSendEvent = makeWsEvent({
      connectionId: 'conn-charlie',
      routeKey: 'sendMessage',
      authorizer: { userId: 'user-charlie', email: 'charlie@example.com' },
      body: JSON.stringify({
        action: 'sendMessage',
        messageId: 'client-msg-charlie',
        roomId: expectedRoomId,
        body: 'Intruder message',
      }),
    });

    const resCharlie = (await sendMessageHandler(
      charlieSendEvent,
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;
    expect(resCharlie.statusCode).toBe(403);
    expect(JSON.parse(resCharlie.body).message).toBe('You are not a member of this room');

    // Verify unauthorized request does not advance sequence or persist message
    const unauthRecord = await getIdempotencyRecord(
      'user-charlie',
      expectedRoomId,
      'client-msg-charlie',
    );
    expect(unauthRecord).toBeUndefined();
    const finalSeq = await getRoomSequence(expectedRoomId);
    expect(finalSeq).toBe(3);
  }, 15000);

  it('prunes dead connections on 410 GoneException during delivery', async () => {
    const userA = 'user-david';
    const userB = 'user-eve';

    // Connect both users
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-david-1',
        routeKey: '$connect',
        authorizer: { userId: userA, email: 'david@example.com' },
      }),
      mockContext,
      mockCallback,
    );
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-eve-stale',
        routeKey: '$connect',
        authorizer: { userId: userB, email: 'eve@example.com' },
      }),
      mockContext,
      mockCallback,
    );

    expect(await getConnection(userB, 'conn-eve-stale')).toBeDefined();
    expect((await getPresence(userB))?.activeConnectionCount).toBe(1);

    // Mock management client to simulate HTTP 410 GoneException when sending to Eve
    const goneError = new Error('GoneException');
    goneError.name = 'GoneException';
    (goneError as { statusCode?: number }).statusCode = 410;

    const mockMgmtClient = {
      send: vi.fn().mockRejectedValue(goneError),
    };
    shared.setManagementApiClient(
      mockMgmtClient as unknown as import('@aws-sdk/client-apigatewaymanagementapi').ApiGatewayManagementApiClient,
    );

    // David sends message to Eve
    const sendEvent = makeWsEvent({
      connectionId: 'conn-david-1',
      routeKey: 'sendMessage',
      authorizer: { userId: userA, email: 'david@example.com' },
      body: JSON.stringify({
        action: 'sendMessage',
        messageId: 'msg-david-1',
        recipientUserId: userB,
        body: 'Are you there Eve?',
      }),
    });

    const res = (await sendMessageHandler(
      sendEvent,
      mockContext,
      mockCallback,
    )) as shared.WebSocketResponse;

    // David still gets 200 ACK
    expect(res.statusCode).toBe(200);

    // Eve's stale connection has been automatically pruned from DynamoDB
    const pruned = await getConnection(userB, 'conn-eve-stale');
    expect(pruned).toBeUndefined();

    // Eve's presence counter decremented to 0
    const evePresence = await getPresence(userB);
    expect(evePresence?.activeConnectionCount).toBe(0);

    shared.setManagementApiClient(undefined);
  }, 15000);

  it('enforces group message authorization: member sends, nonmember rejected, rejected message never persisted', async () => {
    const groupRoomId = 'grp-auth-test-room';
    const memberId = 'user-group-member';
    const outsiderId = 'user-group-outsider';

    // 1. Set up users and group room
    await ensureUserProfile({ userId: memberId, email: `${memberId}@example.com` });
    await ensureUserProfile({ userId: outsiderId, email: `${outsiderId}@example.com` });

    await createGroupRoom({
      roomId: groupRoomId,
      createdBy: memberId,
      name: 'Auth Test Group',
      members: [{ userId: memberId, role: 'ADMIN' }],
      validateUsers: true,
    });

    // Initial sequence is 0
    expect(await getRoomSequence(groupRoomId)).toBe(0);

    // Connect member
    await connectHandler(
      makeWsEvent({
        connectionId: 'conn-group-member-1',
        routeKey: '$connect',
        authorizer: { userId: memberId, email: `${memberId}@example.com` },
      }),
      mockContext,
      mockCallback,
    );

    // Mock API Gateway Management API client so WebSocket postToConnection doesn't fail
    const mockMgmtClient = { send: vi.fn().mockResolvedValue({}) };
    shared.setManagementApiClient(
      mockMgmtClient as unknown as import('@aws-sdk/client-apigatewaymanagementapi').ApiGatewayManagementApiClient,
    );

    try {
      // 1. A group member can send a message
      const memberSendEvent = makeWsEvent({
        connectionId: 'conn-group-member-1',
        routeKey: 'sendMessage',
        authorizer: { userId: memberId, email: `${memberId}@example.com` },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'valid-member-msg-1',
          roomId: groupRoomId,
          body: 'Hello from group member!',
        }),
      });

      const memberRes = (await sendMessageHandler(
        memberSendEvent,
        mockContext,
        mockCallback,
      )) as shared.WebSocketResponse;

      expect(memberRes.statusCode).toBe(200);
      const memberAck = JSON.parse(memberRes.body);
      expect(memberAck.sequenceNumber).toBe(1);
      expect(memberAck.isDuplicate).toBe(false);

      // Verify member's message is persisted
      const persistedMessage = await getMessage(groupRoomId, 1);
      expect(persistedMessage).toBeDefined();
      expect(persistedMessage?.content).toBe('Hello from group member!');
      expect(persistedMessage?.senderId).toBe(memberId);
      expect(await getRoomSequence(groupRoomId)).toBe(1);

      // 2. A nonmember cannot send a message
      const outsiderSendEvent = makeWsEvent({
        connectionId: 'conn-outsider-1',
        routeKey: 'sendMessage',
        authorizer: { userId: outsiderId, email: `${outsiderId}@example.com` },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'unauth-outsider-msg-2',
          roomId: groupRoomId,
          body: 'Unauthorized intrusion!',
        }),
      });

      const outsiderRes = (await sendMessageHandler(
        outsiderSendEvent,
        mockContext,
        mockCallback,
      )) as shared.WebSocketResponse;

      expect(outsiderRes.statusCode).toBe(403);
      expect(JSON.parse(outsiderRes.body).message).toBe('You are not a member of this room');

      // 3. A rejected message does not get persisted or increment the sequence counter
      // Counter is still 1
      expect(await getRoomSequence(groupRoomId)).toBe(1);
      // No message at sequence 2
      expect(await getMessage(groupRoomId, 2)).toBeUndefined();
      // No idempotency record for outsider's message
      expect(
        await getIdempotencyRecord(outsiderId, groupRoomId, 'unauth-outsider-msg-2'),
      ).toBeUndefined();
    } finally {
      shared.setManagementApiClient(undefined);
    }
  });
});
