import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as connectHandler } from '../../src/handlers/websocket/connect';
import { handler as sendMessageHandler } from '../../src/handlers/websocket/sendMessage';
import {
  directRoomId,
  getConnection,
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
});
