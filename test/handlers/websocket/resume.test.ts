import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../../src/handlers/websocket/resume';
import * as repositories from '../../../src/repositories';

const mockContext = {} as Context;
const mockCallback = () => {};

function makeEvent(body?: string): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: 'resume',
      messageId: 'msg-res-1',
      eventType: 'MESSAGE',
      extendedRequestId: 'ext-1',
      requestTime: '2026-11-26T12:00:00Z',
      messageDirection: 'IN',
      stage: 'dev',
      connectedAt: 1700000000,
      requestTimeEpoch: 1700000000,
      requestId: 'req-res-1',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      connectionId: 'conn-alice-1',
      apiId: 'api-1',
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body,
  };
}

describe('WebSocket resume handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when connection owner cannot be resolved', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue(undefined);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'resume', rooms: [{ roomId: 'r1', lastSequence: 10 }] })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when user is not a member of a requested room', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    vi.spyOn(repositories, 'isMember').mockResolvedValue(false);

    const res = (await handler(
      makeEvent(
        JSON.stringify({ action: 'resume', rooms: [{ roomId: 'r-secret', lastSequence: 0 }] }),
      ),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(403);
  });

  it('queries missed messages after lastSequence for multiple rooms', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    const isMemberSpy = vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    const listAfterSpy = vi
      .spyOn(repositories, 'listMessagesAfter')
      .mockImplementation(async (roomId, afterSeq) => {
        if (roomId === 'room-1' && afterSeq === 184) {
          return {
            items: [
              {
                PK: 'ROOM#room-1',
                SK: 'MSG#00000000000000000185',
                roomId: 'room-1',
                sequenceNumber: 185,
                senderId: 'bob',
                messageId: 'msg-185',
                clientMessageId: 'msg-185',
                content: 'Missed message 185',
                messageType: 'TEXT',
                createdAt: '2026-11-26T12:00:01Z',
              },
            ],
            nextKey: undefined,
          };
        }
        return { items: [], nextKey: undefined };
      });

    const res = (await handler(
      makeEvent(
        JSON.stringify({
          action: 'resume',
          rooms: [
            { roomId: 'room-1', lastSequence: 184 },
            { roomId: 'room-2', lastSequence: 10 },
          ],
          limitPerRoom: 25,
        }),
      ),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(isMemberSpy).toHaveBeenCalledWith('alice', 'room-1');
    expect(isMemberSpy).toHaveBeenCalledWith('alice', 'room-2');
    expect(listAfterSpy).toHaveBeenCalledWith('room-1', 184, { limit: 25 });
    expect(listAfterSpy).toHaveBeenCalledWith('room-2', 10, { limit: 25 });

    const body = JSON.parse(res.body);
    expect(body).toEqual({
      action: 'resumeAck',
      rooms: [
        {
          roomId: 'room-1',
          messages: [
            {
              messageId: 'msg-185',
              roomId: 'room-1',
              sequenceNumber: 185,
              senderId: 'bob',
              body: 'Missed message 185',
              messageType: 'TEXT',
              createdAt: '2026-11-26T12:00:01Z',
            },
          ],
          hasMore: false,
          nextAfterSequence: 185,
        },
        {
          roomId: 'room-2',
          messages: [],
          hasMore: false,
          nextAfterSequence: 10,
        },
      ],
    });
  });

  it('supports multi-page recovery pagination using hasMore and nextAfterSequence', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    vi.spyOn(repositories, 'listMessagesAfter').mockImplementation(async (_roomId, afterSeq) => {
      if (afterSeq === 10) {
        return {
          items: [
            {
              PK: 'ROOM#room-1',
              SK: 'MSG#00000000000000000011',
              roomId: 'room-1',
              sequenceNumber: 11,
              senderId: 'bob',
              messageId: 'msg-11',
              clientMessageId: 'msg-11',
              content: 'm11',
              messageType: 'TEXT',
              createdAt: '2026-11-26T12:00:01Z',
            },
            {
              PK: 'ROOM#room-1',
              SK: 'MSG#00000000000000000012',
              roomId: 'room-1',
              sequenceNumber: 12,
              senderId: 'bob',
              messageId: 'msg-12',
              clientMessageId: 'msg-12',
              content: 'm12',
              messageType: 'TEXT',
              createdAt: '2026-11-26T12:00:02Z',
            },
          ],
          nextKey: { PK: 'ROOM#room-1', SK: 'MSG#00000000000000000012' },
        };
      }
      return {
        items: [
          {
            PK: 'ROOM#room-1',
            SK: 'MSG#00000000000000000013',
            roomId: 'room-1',
            sequenceNumber: 13,
            senderId: 'bob',
            messageId: 'msg-13',
            clientMessageId: 'msg-13',
            content: 'm13',
            messageType: 'TEXT',
            createdAt: '2026-11-26T12:00:03Z',
          },
        ],
        nextKey: undefined,
      };
    });

    // Page 1
    const res1 = (await handler(
      makeEvent(
        JSON.stringify({
          action: 'resume',
          rooms: [{ roomId: 'room-1', lastSequence: 10 }],
          limitPerRoom: 2,
        }),
      ),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res1.statusCode).toBe(200);
    const ack1 = JSON.parse(res1.body);
    expect(ack1.rooms[0].hasMore).toBe(true);
    expect(ack1.rooms[0].nextAfterSequence).toBe(12);
    expect(ack1.rooms[0].messages.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual(
      [11, 12],
    );

    // Page 2 using nextAfterSequence
    const res2 = (await handler(
      makeEvent(
        JSON.stringify({
          action: 'resume',
          rooms: [{ roomId: 'room-1', lastSequence: ack1.rooms[0].nextAfterSequence }],
          limitPerRoom: 2,
        }),
      ),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res2.statusCode).toBe(200);
    const ack2 = JSON.parse(res2.body);
    expect(ack2.rooms[0].hasMore).toBe(false);
    expect(ack2.rooms[0].nextAfterSequence).toBe(13);
    expect(ack2.rooms[0].messages.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual(
      [13],
    );
  });

  it('returns 400 for invalid payload', async () => {
    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'resume', rooms: [] })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(400);
  });

  it('falls back to canonical messageId when clientMessageId is absent', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    vi.spyOn(repositories, 'listMessagesAfter').mockResolvedValue({
      items: [
        {
          PK: 'ROOM#room-1',
          SK: 'MSG#0000000001',
          roomId: 'room-1',
          sequenceNumber: 1,
          senderId: 'bob',
          messageId: 'canonical-msg-1',
          clientMessageId: undefined as unknown as string,
          content: 'hello',
          messageType: 'TEXT',
          createdAt: '2026-11-26T12:00:00Z',
        },
      ],
      nextKey: undefined,
    });

    const res = (await handler(
      makeEvent(
        JSON.stringify({ action: 'resume', rooms: [{ roomId: 'room-1', lastSequence: 0 }] }),
      ),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    const ack = JSON.parse(res.body);
    expect(ack.rooms[0].messages[0].messageId).toBe('canonical-msg-1');
  });
});
