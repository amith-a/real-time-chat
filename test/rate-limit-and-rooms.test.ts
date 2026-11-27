import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as sendMessageHandler } from '../src/handlers/websocket/sendMessage';
import * as repositories from '../src/repositories';
import { addMember, MAX_GROUP_ROOM_MEMBERS, removeMember } from '../src/repositories/rooms';
import {
  checkConnectionRateLimit,
  resetConnectionRateLimits,
  TooManyRequestsError,
} from '../src/shared';
import {
  createMockEvent,
  type ExpectedResponse,
  mockCallback,
  mockContext,
} from './handlers/websocket/helpers';

describe('Rate Limiting, Room Guards & SendMessage ACK Resilience', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TABLE_NAME: 'test-table',
      API_GATEWAY_MANAGEMENT_ENDPOINT: 'https://test-api.execute-api.ap-south-1.amazonaws.com/dev',
    };
    resetConnectionRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConnectionRateLimits();
    vi.restoreAllMocks();
  });

  it('enforces per-connection rate limit and resets after window expires', () => {
    checkConnectionRateLimit({
      connectionId: 'conn-1',
      routeKey: 'sendMessage',
      maxRequests: 2,
      windowMs: 1000,
      nowMs: 100,
    });
    checkConnectionRateLimit({
      connectionId: 'conn-1',
      routeKey: 'sendMessage',
      maxRequests: 2,
      windowMs: 1000,
      nowMs: 200,
    });

    expect(() =>
      checkConnectionRateLimit({
        connectionId: 'conn-1',
        routeKey: 'sendMessage',
        maxRequests: 2,
        windowMs: 1000,
        nowMs: 300,
      }),
    ).toThrow(TooManyRequestsError);

    // Different connection is unaffected
    expect(() =>
      checkConnectionRateLimit({
        connectionId: 'conn-2',
        routeKey: 'sendMessage',
        maxRequests: 2,
        windowMs: 1000,
        nowMs: 300,
      }),
    ).not.toThrow();

    // After window expires, counter resets
    expect(() =>
      checkConnectionRateLimit({
        connectionId: 'conn-1',
        routeKey: 'sendMessage',
        maxRequests: 2,
        windowMs: 1000,
        nowMs: 1101,
      }),
    ).not.toThrow();
  });

  it('sendMessage returns 429 when per-connection rate limit is exceeded', async () => {
    process.env.SEND_MESSAGE_RATE_LIMIT_MAX = '1';
    vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    vi.spyOn(repositories, 'createMessage').mockResolvedValue({
      duplicate: false,
      messageId: 'msg-1',
      sequenceNumber: 1,
      createdAt: '2026-11-27T00:00:00.000Z',
    });
    vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([]);

    const event = createMockEvent({
      routeKey: 'sendMessage',
      connectionId: 'conn-rate',
      authorizer: { userId: 'alice' },
      body: JSON.stringify({ action: 'sendMessage', messageId: 'm1', roomId: 'r1', body: 'hi' }),
    });

    const res1 = (await sendMessageHandler(event, mockContext, mockCallback)) as ExpectedResponse;
    expect(res1.statusCode).toBe(200);

    const res2 = (await sendMessageHandler(event, mockContext, mockCallback)) as ExpectedResponse;
    expect(res2.statusCode).toBe(429);
  });

  it('sendMessage persists message and returns 200 ACK even when recipient lookup throws', async () => {
    vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
    const createMessageSpy = vi.spyOn(repositories, 'createMessage').mockResolvedValue({
      duplicate: false,
      messageId: 'msg-ack',
      sequenceNumber: 7,
      createdAt: '2026-11-27T00:00:00.000Z',
    });
    const listMembersSpy = vi
      .spyOn(repositories, 'listRoomMembers')
      .mockRejectedValue(new Error('DynamoDB throttled'));

    const event = createMockEvent({
      routeKey: 'sendMessage',
      connectionId: 'conn-alice',
      authorizer: { userId: 'alice' },
      body: JSON.stringify({
        action: 'sendMessage',
        messageId: 'msg-ack',
        roomId: 'room-1',
        body: 'Persisted even if lookup fails',
      }),
    });

    const res = (await sendMessageHandler(event, mockContext, mockCallback)) as ExpectedResponse;
    expect(res.statusCode).toBe(200);
    expect(createMessageSpy).toHaveBeenCalledTimes(1);
    expect(listMembersSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.body).sequenceNumber).toBe(7);
  });

  it('addMember rejects when group room has reached MAX_GROUP_ROOM_MEMBERS', async () => {
    const mockClient = {
      send: vi
        .fn()
        // getRoom
        .mockResolvedValueOnce({
          Item: {
            PK: 'ROOM#g1',
            SK: 'META',
            roomId: 'g1',
            roomType: 'GROUP',
            memberCount: MAX_GROUP_ROOM_MEMBERS,
          },
        })
        // getMembership (requester is ADMIN)
        .mockResolvedValueOnce({
          Item: { PK: 'USER#admin', SK: 'ROOM#g1', userId: 'admin', roomId: 'g1', role: 'ADMIN' },
        })
        // getMembership (target not yet member)
        .mockResolvedValueOnce({ Item: undefined }),
    };
    repositories.setDocClient(
      mockClient as unknown as Parameters<typeof repositories.setDocClient>[0],
    );

    await expect(addMember({ roomId: 'g1', userId: 'new-user', addedBy: 'admin' })).rejects.toThrow(
      `Group room cannot exceed ${MAX_GROUP_ROOM_MEMBERS} members`,
    );
  });

  it('removeMember prevents the last admin from leaving a group room', async () => {
    const mockClient = {
      send: vi
        .fn()
        // getRoom
        .mockResolvedValueOnce({
          Item: {
            PK: 'ROOM#g1',
            SK: 'META',
            roomId: 'g1',
            roomType: 'GROUP',
            memberCount: 2,
          },
        })
        // getMembership(removedBy)
        .mockResolvedValueOnce({
          Item: { PK: 'USER#admin', SK: 'ROOM#g1', userId: 'admin', roomId: 'g1', role: 'ADMIN' },
        })
        // getMembership(userId)
        .mockResolvedValueOnce({
          Item: { PK: 'USER#admin', SK: 'ROOM#g1', userId: 'admin', roomId: 'g1', role: 'ADMIN' },
        })
        // listRoomMembers (only 1 ADMIN)
        .mockResolvedValueOnce({
          Items: [
            { userId: 'admin', roomId: 'g1', role: 'ADMIN' },
            { userId: 'bob', roomId: 'g1', role: 'MEMBER' },
          ],
        }),
    };
    repositories.setDocClient(
      mockClient as unknown as Parameters<typeof repositories.setDocClient>[0],
    );

    await expect(
      removeMember({ roomId: 'g1', userId: 'admin', removedBy: 'admin' }),
    ).rejects.toThrow('Cannot remove the last admin of a group room');
  });
});
