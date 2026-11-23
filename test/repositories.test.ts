import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectRoom,
  createGroupRoom,
  createMessage,
  getPresence,
  hashRequest,
  putUserProfile,
  registerConnection,
  removeConnection,
  resetDocClient,
  resetTableName,
  setDocClient,
  setTableName,
} from '../src/repositories';
import type { MessageType } from '../src/repositories/types';
import { BadRequestError, ForbiddenError, InternalServerError } from '../src/shared/errors';

interface MockCanceledError extends Error {
  CancellationReasons?: Array<{ Code?: string }>;
}

function createCancelError(reasons: Array<{ Code?: string }>): MockCanceledError {
  const err = new Error('Transaction canceled') as MockCanceledError;
  err.name = 'TransactionCanceledException';
  err.CancellationReasons = reasons;
  return err;
}

describe('DynamoDB Repository Layer', () => {
  const mockSend = vi.fn();
  const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;

  beforeEach(() => {
    vi.clearAllMocks();
    setDocClient(mockDocClient);
    setTableName('TestChatTable');
  });

  afterEach(() => {
    resetDocClient();
    resetTableName();
  });

  describe('User Profile & Presence', () => {
    it('saves user profile without letting attributes overwrite primary keys', async () => {
      mockSend.mockResolvedValueOnce({});

      const saved = await putUserProfile('user-1', {
        PK: 'OVERRIDE_PK',
        SK: 'OVERRIDE_SK',
        userId: 'OVERRIDE_USER',
        displayName: 'Alice',
      });

      expect(saved.PK).toBe('USER#user-1');
      expect(saved.SK).toBe('PROFILE');
      expect(saved.userId).toBe('user-1');
      expect(saved.displayName).toBe('Alice');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('derives online presence strictly from activeConnectionCount > 0', async () => {
      mockSend
        .mockResolvedValueOnce({
          Item: { activeConnectionCount: 2, lastSeenAt: '2026-11-23T10:00:00Z' },
        })
        .mockResolvedValueOnce({
          Item: { activeConnectionCount: 0, lastSeenAt: '2026-11-23T10:00:00Z' },
        })
        .mockResolvedValueOnce({ Item: undefined });

      const p1 = await getPresence('u1');
      expect(p1.online).toBe(true);
      expect(p1.activeConnectionCount).toBe(2);

      const p2 = await getPresence('u2');
      expect(p2.online).toBe(false);
      expect(p2.activeConnectionCount).toBe(0);

      const p3 = await getPresence('u3');
      expect(p3.online).toBe(false);
      expect(p3.activeConnectionCount).toBe(0);
    });
  });

  describe('Connection Management', () => {
    it('registers a connection atomically with presence increment and owner item', async () => {
      mockSend.mockResolvedValueOnce({});

      const res = await registerConnection({
        userId: 'user-1',
        connectionId: 'conn-1',
        now: '2026-11-23T12:00:00Z',
      });

      expect(res.registered).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const call = mockSend.mock.calls[0][0];
      expect(call.input.TransactItems).toHaveLength(3);
      expect(call.input.TransactItems[0].Put.Item.PK).toBe('USER#user-1');
      expect(call.input.TransactItems[0].Put.Item.SK).toBe('CONNECTION#conn-1');
      expect(call.input.TransactItems[1].Update.Key.SK).toBe('PRESENCE');
      expect(call.input.TransactItems[1].Update.UpdateExpression).toBe(
        'ADD activeConnectionCount :one',
      );
      expect(call.input.TransactItems[2].Put.Item.PK).toBe('CONN#conn-1');
      expect(call.input.TransactItems[2].Put.Item.SK).toBe('OWNER');
    });

    it('handles duplicate connection registration race when owned by the same user', async () => {
      const cancelError = createCancelError([
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ]);

      mockSend
        // TransactWrite fails
        .mockRejectedValueOnce(cancelError)
        // Consistent read of connection
        .mockResolvedValueOnce({
          Item: {
            PK: 'USER#user-1',
            SK: 'CONNECTION#conn-1',
            userId: 'user-1',
            connectionId: 'conn-1',
          },
        })
        // Consistent read of owner
        .mockResolvedValueOnce({
          Item: { PK: 'CONN#conn-1', SK: 'OWNER', userId: 'user-1' },
        });

      const res = await registerConnection({ userId: 'user-1', connectionId: 'conn-1' });
      expect(res.registered).toBe(false);
    });

    it('throws ForbiddenError when a connection is already registered to a different user', async () => {
      const cancelError = createCancelError([
        { Code: 'None' },
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({ Item: { userId: 'user-1', connectionId: 'conn-1' } })
        .mockResolvedValueOnce({ Item: { userId: 'user-2' } });

      await expect(
        registerConnection({ userId: 'user-1', connectionId: 'conn-1' }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('removes connection and decrements presence counter guarded by activeConnectionCount > 0', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await removeConnection({ userId: 'user-1', connectionId: 'conn-1' });
      expect(result).toBe('REMOVED');
      const call = mockSend.mock.calls[0][0];
      expect(call.input.TransactItems[1].Update.ConditionExpression).toBe(
        'activeConnectionCount > :zero',
      );
    });

    it('returns NOT_FOUND_OR_CHANGED if connection was already deleted', async () => {
      const cancelError = createCancelError([
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
        { Code: 'None' },
      ]);

      mockSend.mockRejectedValueOnce(cancelError);

      const result = await removeConnection({ userId: 'user-1', connectionId: 'conn-1' });
      expect(result).toBe('NOT_FOUND_OR_CHANGED');
    });

    it('throws InternalServerError if presence counter condition fails on disconnect', async () => {
      const cancelError = createCancelError([
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
      ]);

      mockSend.mockRejectedValueOnce(cancelError);

      await expect(removeConnection({ userId: 'user-1', connectionId: 'conn-1' })).rejects.toThrow(
        InternalServerError,
      );
    });
  });

  describe('Room Creation & Concurrency', () => {
    it('creates direct room with 4 atomic items (meta, 2 memberships, counter=0)', async () => {
      mockSend.mockResolvedValueOnce({});

      const res = await createDirectRoom({ userA: 'user-A', userB: 'user-B' });
      expect(res.created).toBe(true);
      expect(res.room.roomType).toBe('DIRECT');

      const call = mockSend.mock.calls[0][0];
      expect(call.input.TransactItems).toHaveLength(4);
      expect(call.input.TransactItems[3].Put.Item.SK).toBe('COUNTER');
      expect(call.input.TransactItems[3].Put.Item.sequenceNumber).toBe(0);
    });

    it('verifies existing direct room on race and returns created: false', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({ Item: { roomId: 'room-1', roomType: 'DIRECT' } })
        .mockResolvedValueOnce({ Item: { userId: 'user-A', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: { userId: 'user-B', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      const res = await createDirectRoom({ userA: 'user-A', userB: 'user-B' });
      expect(res.created).toBe(false);
      expect(res.room.roomType).toBe('DIRECT');
    });

    it('rejects duplicate member user IDs in createGroupRoom', async () => {
      await expect(
        createGroupRoom({
          roomId: 'group-1',
          createdBy: 'admin-1',
          members: [
            { userId: 'u1', role: 'ADMIN' },
            { userId: 'u1', role: 'MEMBER' },
          ],
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it('rejects group room creation exceeding 98 members (max 100 transaction items)', async () => {
      const members = Array.from({ length: 99 }, (_, i) => ({
        userId: `user-${i}`,
        role: 'MEMBER' as const,
      }));

      await expect(
        createGroupRoom({
          roomId: 'group-1',
          createdBy: 'admin-1',
          members,
        }),
      ).rejects.toThrow(BadRequestError);
    });
  });

  describe('Messages, Sequences & Idempotency', () => {
    it('validates clientMessageId, content bounds, and messageType at runtime', async () => {
      await expect(
        createMessage({
          roomId: 'r1',
          senderId: 'u1',
          clientMessageId: '',
          content: 'Hello',
        }),
      ).rejects.toThrow(BadRequestError);

      await expect(
        createMessage({
          roomId: 'r1',
          senderId: 'u1',
          clientMessageId: 'id#with#hash',
          content: 'Hello',
        }),
      ).rejects.toThrow(BadRequestError);

      await expect(
        createMessage({
          roomId: 'r1',
          senderId: 'u1',
          clientMessageId: 'valid-id',
          content: 'a'.repeat(33_000),
        }),
      ).rejects.toThrow(BadRequestError);

      await expect(
        createMessage({
          roomId: 'r1',
          senderId: 'u1',
          clientMessageId: 'valid-id',
          content: 'Hello',
          messageType: 'INVALID' as unknown as MessageType,
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it('allocates the next sequence atomically with optimistic concurrency', async () => {
      mockSend
        .mockResolvedValueOnce({ Item: undefined })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 4 } })
        .mockResolvedValueOnce({});

      const result = await createMessage({
        roomId: 'room-1',
        senderId: 'user-1',
        clientMessageId: 'client-123',
        content: 'Hello World',
        now: '2026-11-23T12:00:00Z',
      });

      expect(result.duplicate).toBe(false);
      expect(result.sequenceNumber).toBe(5);

      const call = mockSend.mock.calls[2][0];
      expect(call.input.TransactItems).toHaveLength(3);
      expect(call.input.TransactItems[0].Update.ConditionExpression).toBe(
        'sequenceNumber = :current',
      );
      expect(call.input.TransactItems[0].Update.ExpressionAttributeValues[':next']).toBe(5);
      expect(call.input.TransactItems[0].Update.ExpressionAttributeValues[':current']).toBe(4);
      expect(call.input.TransactItems[1].Put.Item.SK).toBe('MSG#0000000005');
      expect(call.input.TransactItems[2].Put.Item.ttl).toBe(
        Math.floor(new Date('2026-11-23T12:00:00Z').getTime() / 1000) + 86400,
      );
    });

    it('replays response immediately if idempotency record exists', async () => {
      const requestHash = hashRequest({ roomId: 'r1', messageType: 'TEXT', content: 'Hello' });

      mockSend.mockResolvedValueOnce({
        Item: {
          messageId: 'msg-existing',
          sequenceNumber: 12,
          requestHash,
          createdAt: '2026-11-23T10:00:00Z',
        },
      });

      const res = await createMessage({
        roomId: 'r1',
        senderId: 'u1',
        clientMessageId: 'c1',
        content: 'Hello',
      });

      expect(res.duplicate).toBe(true);
      expect(res.messageId).toBe('msg-existing');
      expect(res.sequenceNumber).toBe(12);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });
});
