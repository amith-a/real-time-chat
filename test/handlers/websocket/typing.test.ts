import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../../src/handlers/websocket/typing';
import * as repositories from '../../../src/repositories';
import * as shared from '../../../src/shared';

const mockContext = {} as Context;
const mockCallback = () => {};

function makeEvent(body?: string): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: 'typing',
      messageId: 'msg-typ-1',
      eventType: 'MESSAGE',
      extendedRequestId: 'ext-1',
      requestTime: '2026-11-26T00:00:00Z',
      messageDirection: 'IN',
      stage: 'dev',
      connectedAt: 1700000000,
      requestTimeEpoch: 1700000000,
      requestId: 'req-typ-1',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      connectionId: 'conn-alice-1',
      apiId: 'api-1',
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body,
  };
}

describe('WebSocket typing handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when connection owner cannot be resolved', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue(undefined);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'typing', roomId: 'room-1', isTyping: true })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(401);
  });

  it('rejects non-members with 403 Forbidden', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    const isMemberSpy = vi.spyOn(repositories, 'isMember').mockResolvedValue(false);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'typing', roomId: 'room-1', isTyping: true })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(403);
    expect(isMemberSpy).toHaveBeenCalledWith('alice', 'room-1');
  });

  it('fans out ephemeral typing indicator without persisting to DynamoDB', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    const isMemberSpy = vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    const createMessageSpy = vi.spyOn(repositories, 'createMessage');
    vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
      {
        PK: 'USER#alice',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#alice',
        userId: 'alice',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
      {
        PK: 'USER#bob',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#bob',
        userId: 'bob',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
    ]);
    vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (uid) => {
      if (uid === 'alice') {
        return [
          {
            PK: 'USER#alice',
            SK: 'CONNECTION#conn-alice-1',
            userId: 'alice',
            connectionId: 'conn-alice-1',
            connectedAt: '2026-11-26T00:00:00Z',
            lastHeartbeat: '2026-11-26T00:00:00Z',
          },
          {
            PK: 'USER#alice',
            SK: 'CONNECTION#conn-alice-2',
            userId: 'alice',
            connectionId: 'conn-alice-2',
            connectedAt: '2026-11-26T00:00:00Z',
            lastHeartbeat: '2026-11-26T00:00:00Z',
          },
        ];
      }
      return [
        {
          PK: 'USER#bob',
          SK: 'CONNECTION#conn-bob-1',
          userId: 'bob',
          connectionId: 'conn-bob-1',
          connectedAt: '2026-11-26T00:00:00Z',
          lastHeartbeat: '2026-11-26T00:00:00Z',
        },
      ];
    });
    const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'typing', roomId: 'room-1', isTyping: true })),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      action: 'typingAck',
      roomId: 'room-1',
      isTyping: true,
    });

    // Ephemeral: never persisted as a message
    expect(createMessageSpy).not.toHaveBeenCalled();
    expect(isMemberSpy).toHaveBeenCalledWith('alice', 'room-1');

    // Excludes sender's current connection (conn-alice-1), delivers to conn-alice-2 and conn-bob-1
    expect(postSpy).toHaveBeenCalledTimes(2);
    const targets = postSpy.mock.calls.map((c) => c[0].connectionId);
    expect(targets).toEqual(expect.arrayContaining(['conn-alice-2', 'conn-bob-1']));
    expect(targets).not.toContain('conn-alice-1');
    expect(postSpy.mock.calls[0][0].payload).toMatchObject({
      action: 'typing',
      roomId: 'room-1',
      userId: 'alice',
      isTyping: true,
    });
  });

  it('broadcasts isTyping: false when user stops typing', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    const isMemberSpy = vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
      {
        PK: 'USER#alice',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#alice',
        userId: 'alice',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
      {
        PK: 'USER#bob',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#bob',
        userId: 'bob',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
    ]);
    vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (uid) =>
      uid === 'bob'
        ? [
            {
              PK: 'USER#bob',
              SK: 'CONNECTION#conn-bob-1',
              userId: 'bob',
              connectionId: 'conn-bob-1',
              connectedAt: '2026-11-26T00:00:00Z',
              lastHeartbeat: '2026-11-26T00:00:00Z',
            },
          ]
        : [],
    );
    const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'typing', roomId: 'room-1', isTyping: false })),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(isMemberSpy).toHaveBeenCalledWith('alice', 'room-1');
    expect(JSON.parse(res.body)).toEqual({
      action: 'typingAck',
      roomId: 'room-1',
      isTyping: false,
    });
    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'conn-bob-1',
        payload: expect.objectContaining({
          action: 'typing',
          roomId: 'room-1',
          userId: 'alice',
          isTyping: false,
        }),
      }),
    );
  });

  it('logs failed and stale typing deliveries without failing the request', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
      {
        PK: 'USER#bob',
        SK: 'ROOM#room-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'MEMBER#bob',
        userId: 'bob',
        roomId: 'room-1',
        role: 'MEMBER',
        joinedAt: '2026-11-26T00:00:00Z',
      },
    ]);
    vi.spyOn(repositories, 'listUserConnections').mockResolvedValue([
      {
        PK: 'USER#bob',
        SK: 'CONNECTION#conn-bob-stale',
        userId: 'bob',
        connectionId: 'conn-bob-stale',
        connectedAt: '2026-11-26T00:00:00Z',
        lastHeartbeat: '2026-11-26T00:00:00Z',
      },
      {
        PK: 'USER#bob',
        SK: 'CONNECTION#conn-bob-err',
        userId: 'bob',
        connectionId: 'conn-bob-err',
        connectedAt: '2026-11-26T00:00:00Z',
        lastHeartbeat: '2026-11-26T00:00:00Z',
      },
    ]);
    vi.spyOn(shared, 'postToConnection')
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('Gateway 500'));
    const warnFn = vi.fn();
    const infoFn = vi.fn();
    vi.spyOn(shared.logger, 'withContext').mockReturnValue({
      warn: warnFn,
      info: infoFn,
      error: vi.fn(),
      debug: vi.fn(),
      withContext: vi.fn(),
    } as unknown as ReturnType<typeof shared.logger.withContext>);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'typing', roomId: 'room-1', isTyping: true })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(200);
    expect(warnFn).toHaveBeenCalledWith(
      'Failed to deliver typing indicator to connection',
      expect.objectContaining({ connectionId: 'conn-bob-err', error: 'Gateway 500' }),
    );
    expect(infoFn).toHaveBeenCalledWith(
      'Typing indicator broadcast complete',
      expect.objectContaining({
        recipientCount: 2,
        deliveredCount: 0,
        staleCount: 1,
        errorCount: 1,
      }),
    );
  });

  it('returns 400 when roomId is missing', async () => {
    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'typing', roomId: '' })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(400);
  });
});
