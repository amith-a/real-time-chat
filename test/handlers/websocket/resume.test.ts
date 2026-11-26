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
              content: 'Missed message 185',
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

  it('returns 400 for invalid payload', async () => {
    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'resume', rooms: [] })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(400);
  });
});
