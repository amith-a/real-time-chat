import { type DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDirectRoom,
  createGroupRoom,
  createMessage,
  ensureUserProfile,
  getPresence,
  getUserByEmail,
  getUserProfile,
  hashMembership,
  hashRequest,
  listRoomMembers,
  listUserConnections,
  listUserConnectionsPage,
  listUsers,
  putUserProfile,
  registerConnection,
  removeConnection,
  removeStaleConnection,
  resetDocClient,
  resetTableName,
  setDocClient,
  setTableName,
  updateHeartbeat,
} from '../src/repositories';
import { MAX_SEQUENCE } from '../src/repositories/keys';
import type { MessageType } from '../src/repositories/types';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
} from '../src/shared/errors';

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
    mockSend.mockReset();
    vi.clearAllMocks();
    setDocClient(mockDocClient);
    setTableName('TestChatTable');
  });

  afterEach(() => {
    resetDocClient();
    resetTableName();
  });

  // =========================================================================
  // 1. Connection Management
  // =========================================================================
  describe('Connection Management', () => {
    it('registers a connection atomically with presence increment and owner item', async () => {
      mockSend.mockResolvedValueOnce({});

      const res = await registerConnection({
        userId: 'user-1',
        connectionId: 'conn-1',
        now: '2026-11-23T12:00:00Z',
      });

      expect(res.registered).toBe(true);
      expect(res.becameOnline).toBe(true);
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

    it('returns becameOnline: false when a concurrent connection already brought the user online', async () => {
      const presenceConditionFailed = createCancelError([
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
      ]);
      mockSend.mockRejectedValueOnce(presenceConditionFailed).mockResolvedValueOnce({});

      const res = await registerConnection({
        userId: 'user-1',
        connectionId: 'conn-2',
      });

      expect(res).toEqual({ registered: true, becameOnline: false });
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('returns registered: false when duplicate connection race occurs and owner matches', async () => {
      const cancelError = createCancelError([
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: {
            PK: 'USER#user-1',
            SK: 'CONNECTION#conn-1',
            userId: 'user-1',
            connectionId: 'conn-1',
          },
        })
        .mockResolvedValueOnce({
          Item: { PK: 'CONN#conn-1', SK: 'OWNER', userId: 'user-1' },
        });

      const res = await registerConnection({
        userId: 'user-1',
        connectionId: 'conn-1',
      });
      expect(res.registered).toBe(false);
    });

    it('throws ForbiddenError when an existing connection belongs to another user', async () => {
      const cancelError = createCancelError([
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: { userId: 'user-1', connectionId: 'conn-1' },
        })
        .mockResolvedValueOnce({
          Item: { userId: 'user-2' }, // owner belongs to another user
        });

      await expect(
        registerConnection({ userId: 'user-1', connectionId: 'conn-1' }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws InternalServerError when existing connection has a missing owner record', async () => {
      const cancelError = createCancelError([
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
        { Code: 'None' },
      ]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        // Connection exists
        .mockResolvedValueOnce({
          Item: { userId: 'user-1', connectionId: 'conn-1' },
        })
        // Owner record is missing
        .mockResolvedValueOnce({ Item: undefined });

      await expect(
        registerConnection({ userId: 'user-1', connectionId: 'conn-1' }),
      ).rejects.toThrow(InternalServerError);
    });

    it('throws InternalServerError when owner record exists but connection record is missing', async () => {
      const cancelError = createCancelError([
        { Code: 'None' },
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        // Connection is missing
        .mockResolvedValueOnce({ Item: undefined })
        // Owner record exists and matches
        .mockResolvedValueOnce({
          Item: { PK: 'CONN#conn-1', SK: 'OWNER', userId: 'user-1' },
        });

      await expect(
        registerConnection({ userId: 'user-1', connectionId: 'conn-1' }),
      ).rejects.toThrow(InternalServerError);
    });

    it('removes connection and decrements presence counter guarded by activeConnectionCount > 0', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await removeConnection({
        userId: 'user-1',
        connectionId: 'conn-1',
      });
      expect(result).toBe('REMOVED');
      const call = mockSend.mock.calls[0][0];
      expect(call.input.TransactItems[1].Update.ConditionExpression).toBe(
        'activeConnectionCount > :zero',
      );
    });

    it('repeated disconnect does not decrement presence counter more than once (returns NOT_FOUND_OR_CHANGED)', async () => {
      const cancelError = createCancelError([
        { Code: 'ConditionalCheckFailed' }, // connection was already deleted
        { Code: 'None' },
        { Code: 'None' },
      ]);

      mockSend.mockRejectedValueOnce(cancelError);

      const result = await removeConnection({
        userId: 'user-1',
        connectionId: 'conn-1',
      });
      expect(result).toBe('NOT_FOUND_OR_CHANGED');
    });

    it('throws InternalServerError if presence counter condition fails on disconnect', async () => {
      const cancelError = createCancelError([
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' }, // presence invariant failure
        { Code: 'None' },
      ]);

      mockSend.mockRejectedValueOnce(cancelError);

      await expect(removeConnection({ userId: 'user-1', connectionId: 'conn-1' })).rejects.toThrow(
        InternalServerError,
      );
    });

    it('stale cleanup does not delete a connection when its heartbeat changes after discovery', async () => {
      const cutoff = '2026-11-23T10:30:00Z';
      const candidate = {
        userId: 'user-1',
        connectionId: 'conn-1',
        lastHeartbeat: '2026-11-23T10:00:00Z',
      };

      // When re-read consistently, heartbeat has changed and is newer than cutoff
      mockSend.mockResolvedValueOnce({
        Item: {
          userId: 'user-1',
          connectionId: 'conn-1',
          lastHeartbeat: '2026-11-23T10:35:00Z',
        },
      });

      const res = await removeStaleConnection(candidate, cutoff);
      expect(res).toBe('NOT_FOUND_OR_CHANGED');
      expect(mockSend).toHaveBeenCalledTimes(1); // Never attempted delete transaction
    });

    it('stale cleanup returns NOT_FOUND_OR_CHANGED if observedLastHeartbeat condition fails on delete', async () => {
      const cutoff = '2026-11-23T10:30:00Z';
      const candidate = {
        userId: 'user-1',
        connectionId: 'conn-1',
        lastHeartbeat: '2026-11-23T10:00:00Z',
      };

      const cancelError = createCancelError([
        { Code: 'ConditionalCheckFailed' }, // lastHeartbeat = :observed failed
        { Code: 'None' },
        { Code: 'None' },
      ]);

      mockSend
        // Re-read consistently confirms candidate is still stale
        .mockResolvedValueOnce({
          Item: {
            userId: 'user-1',
            connectionId: 'conn-1',
            lastHeartbeat: '2026-11-23T10:00:00Z',
          },
        })
        // TransactWrite Delete fails because heartbeat updated concurrently
        .mockRejectedValueOnce(cancelError);

      const res = await removeStaleConnection(candidate, cutoff);
      expect(res).toBe('NOT_FOUND_OR_CHANGED');
    });

    it('heartbeat update does not recreate a deleted connection', async () => {
      const condError = new Error('ConditionalCheckFailed');
      condError.name = 'ConditionalCheckFailedException';

      mockSend.mockRejectedValueOnce(condError);

      const updated = await updateHeartbeat('user-1', 'conn-1');
      expect(updated).toBe(false);

      const call = mockSend.mock.calls[0][0];
      expect(call.input.ConditionExpression).toBe('attribute_exists(PK)');
      expect(call.input.UpdateExpression).toBe('SET lastHeartbeat = :now');
    });

    it('supports paginated connection queries via listUserConnectionsPage', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { userId: 'u1', connectionId: 'c1' },
          { userId: 'u1', connectionId: 'c2' },
        ],
        LastEvaluatedKey: { PK: 'USER#u1', SK: 'CONNECTION#c2' },
      });

      const page = await listUserConnectionsPage('u1', { limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.nextKey).toEqual({ PK: 'USER#u1', SK: 'CONNECTION#c2' });
    });

    it('traverses multiple DynamoDB pages and returns all connections across pages via listUserConnections', async () => {
      // Page 1
      mockSend.mockResolvedValueOnce({
        Items: [
          { userId: 'u1', connectionId: 'c1' },
          { userId: 'u1', connectionId: 'c2' },
        ],
        LastEvaluatedKey: { PK: 'USER#u1', SK: 'CONNECTION#c2' },
      });
      // Page 2
      mockSend.mockResolvedValueOnce({
        Items: [{ userId: 'u1', connectionId: 'c3' }],
      });

      const connections = await listUserConnections('u1');
      expect(connections).toHaveLength(3);
      expect(connections.map((c) => c.connectionId)).toEqual(['c1', 'c2', 'c3']);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 2. Message Management
  // =========================================================================
  describe('Message Management', () => {
    it('returns original message when same client message ID and same payload are sent (replay)', async () => {
      const requestHash = hashRequest({
        roomId: 'r1',
        messageType: 'TEXT',
        content: 'Hello',
      });

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

    it('throws ConflictError when same client message ID is reused with a different payload', async () => {
      const originalHash = hashRequest({
        roomId: 'r1',
        messageType: 'TEXT',
        content: 'Original Content',
      });

      mockSend.mockResolvedValueOnce({
        Item: {
          messageId: 'msg-existing',
          sequenceNumber: 12,
          requestHash: originalHash,
          createdAt: '2026-11-23T10:00:00Z',
        },
      });

      await expect(
        createMessage({
          roomId: 'r1',
          senderId: 'u1',
          clientMessageId: 'c1',
          content: 'Different Content', // Payload changed
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('concurrent message creation does not allocate duplicate sequence numbers (retries with next sequence)', async () => {
      const conflictError = createCancelError([
        { Code: 'ConditionalCheckFailed' }, // counter sequence condition failed
        { Code: 'None' },
        { Code: 'None' },
      ]);

      mockSend
        // Idempotency check: not found
        .mockResolvedValueOnce({ Item: undefined })
        // Attempt 1: current sequence = 5
        .mockResolvedValueOnce({ Item: { sequenceNumber: 5 } })
        // Attempt 1: TransactWrite fails due to counter race
        .mockRejectedValueOnce(conflictError)
        // Attempt 2: current sequence re-read = 6
        .mockResolvedValueOnce({ Item: { sequenceNumber: 6 } })
        // Attempt 2: TransactWrite succeeds
        .mockResolvedValueOnce({});

      const result = await createMessage({
        roomId: 'room-1',
        senderId: 'user-1',
        clientMessageId: 'client-123',
        content: 'Message after race',
      });

      expect(result.duplicate).toBe(false);
      expect(result.sequenceNumber).toBe(7); // Next after 6
    });

    it('propagates non-retryable transaction errors', async () => {
      const nonRetryableError = Object.assign(new Error('Provisioning error'), {
        name: 'ResourceNotFoundException',
      });

      mockSend
        .mockResolvedValueOnce({ Item: undefined })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 5 } })
        .mockRejectedValueOnce(nonRetryableError);

      await expect(
        createMessage({
          roomId: 'room-1',
          senderId: 'user-1',
          clientMessageId: 'client-123',
          content: 'Hello',
        }),
      ).rejects.toThrow('Provisioning error');
    });

    it('rejects sequence exhaustion when sequence reaches MAX_SEQUENCE', async () => {
      mockSend
        .mockResolvedValueOnce({ Item: undefined })
        // Counter at maximum capacity
        .mockResolvedValueOnce({ Item: { sequenceNumber: MAX_SEQUENCE } });

      await expect(
        createMessage({
          roomId: 'room-1',
          senderId: 'user-1',
          clientMessageId: 'client-123',
          content: 'Hello',
        }),
      ).rejects.toThrow(AppError);
    });

    it('rejects invalid maxAttempts values', async () => {
      const base = {
        roomId: 'r1',
        senderId: 'u1',
        clientMessageId: 'c1',
        content: 'Hello',
      };

      await expect(createMessage({ ...base, maxAttempts: 0 })).rejects.toThrow(BadRequestError);
      await expect(createMessage({ ...base, maxAttempts: -1 })).rejects.toThrow(BadRequestError);
      await expect(createMessage({ ...base, maxAttempts: 11 })).rejects.toThrow(BadRequestError);
      await expect(createMessage({ ...base, maxAttempts: 2.5 })).rejects.toThrow(BadRequestError);
    });

    it('exhausts retries and rejects with 503 AppError when counter conflicts persist', async () => {
      const conflictError = createCancelError([
        { Code: 'ConditionalCheckFailed' }, // 0: counter condition failed
        { Code: 'None' },
        { Code: 'None' },
      ]);

      mockSend
        // 1. Initial idempotency check: not found
        .mockResolvedValueOnce({ Item: undefined })
        // Attempt 1: read counter sequence = 10
        .mockResolvedValueOnce({ Item: { sequenceNumber: 10 } })
        // Attempt 1: TransactWrite fails due to counter race
        .mockRejectedValueOnce(conflictError)
        // Attempt 2: read counter sequence = 11
        .mockResolvedValueOnce({ Item: { sequenceNumber: 11 } })
        // Attempt 2: TransactWrite fails due to counter race
        .mockRejectedValueOnce(conflictError)
        // Attempt 3: read counter sequence = 12
        .mockResolvedValueOnce({ Item: { sequenceNumber: 12 } })
        // Attempt 3: TransactWrite fails due to counter race
        .mockRejectedValueOnce(conflictError);

      let thrownError: unknown;
      try {
        await createMessage({
          roomId: 'room-exhaustion',
          senderId: 'user-sender',
          clientMessageId: 'client-exhaustion-test',
          content: 'Exhaustion test message',
          maxAttempts: 3,
        });
      } catch (err) {
        thrownError = err;
      }

      // 4. Verify that it eventually rejects with the expected 503 AppError
      expect(thrownError).toBeInstanceOf(AppError);
      const appError = thrownError as AppError;
      expect(appError.statusCode).toBe(503);
      expect(appError.message).toBe('Too much contention allocating a message sequence');
      expect(appError.details).toEqual({ roomId: 'room-exhaustion' });

      // 5. Verify that it performs exactly 3 transaction attempts
      const transactCalls = mockSend.mock.calls.filter(
        (call) => call[0] instanceof TransactWriteCommand,
      );
      expect(transactCalls).toHaveLength(3);

      // 6. Verify that it does not exceed the configured retry limit (1 idempotency read + 3 attempts * 2 calls)
      expect(mockSend).toHaveBeenCalledTimes(7);
    });

    it('calculates idempotency TTL deterministically from injected now timestamp', async () => {
      const fixedNow = '2026-11-23T12:00:00.000Z';
      const expectedTtl = Math.floor(new Date(fixedNow).getTime() / 1000) + 86400;

      mockSend
        .mockResolvedValueOnce({ Item: undefined })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 10 } })
        .mockResolvedValueOnce({});

      await createMessage({
        roomId: 'room-1',
        senderId: 'user-1',
        clientMessageId: 'client-ttl-test',
        content: 'Testing TTL',
        now: fixedNow,
      });

      const transactCall = mockSend.mock.calls[2][0];
      const idempotencyItem = transactCall.input.TransactItems[2].Put.Item;
      expect(idempotencyItem.ttl).toBe(expectedTtl);
      expect(idempotencyItem.createdAt).toBe(fixedNow);
    });

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
  });

  // =========================================================================
  // 3. Room Management
  // =========================================================================
  describe('Room Management', () => {
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
        .mockResolvedValueOnce({
          Item: { roomId: 'room-1', roomType: 'DIRECT' },
        })
        .mockResolvedValueOnce({ Item: { userId: 'user-A', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: { userId: 'user-B', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      const res = await createDirectRoom({ userA: 'user-A', userB: 'user-B' });
      expect(res.created).toBe(false);
      expect(res.room.roomType).toBe('DIRECT');
    });

    it('throws InternalServerError when direct room exists but metadata is missing', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({ Item: undefined }) // Missing meta
        .mockResolvedValueOnce({ Item: { userId: 'user-A', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: { userId: 'user-B', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      await expect(createDirectRoom({ userA: 'user-A', userB: 'user-B' })).rejects.toThrow(
        InternalServerError,
      );
    });

    it('throws InternalServerError when direct room exists but one membership is missing', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: { roomId: 'room-1', roomType: 'DIRECT' },
        })
        .mockResolvedValueOnce({ Item: { userId: 'user-A', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: undefined }) // Missing member B
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      await expect(createDirectRoom({ userA: 'user-A', userB: 'user-B' })).rejects.toThrow(
        InternalServerError,
      );
    });

    it('throws InternalServerError when direct room exists but counter is missing', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: { roomId: 'room-1', roomType: 'DIRECT' },
        })
        .mockResolvedValueOnce({ Item: { userId: 'user-A', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: { userId: 'user-B', roomId: 'room-1' } })
        .mockResolvedValueOnce({ Item: undefined }); // Missing counter

      await expect(createDirectRoom({ userA: 'user-A', userB: 'user-B' })).rejects.toThrow(
        InternalServerError,
      );
    });

    it('throws InternalServerError when group room exists but counter is missing', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: { roomId: 'g1', roomType: 'GROUP', createdBy: 'admin-1' },
        })
        .mockResolvedValueOnce({ Item: undefined }) // Missing counter
        .mockResolvedValueOnce({
          Item: { userId: 'u1', roomId: 'g1', role: 'ADMIN' },
        });

      await expect(
        createGroupRoom({
          roomId: 'g1',
          createdBy: 'admin-1',
          members: [{ userId: 'u1', role: 'ADMIN' }],
        }),
      ).rejects.toThrow(InternalServerError);
    });

    it('succeeds on retry even when mutable membership changed after creation', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
      const members = [
        { userId: 'u1', role: 'ADMIN' as const },
        { userId: 'u2', role: 'MEMBER' as const },
      ];

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: {
            roomId: 'g1',
            roomType: 'GROUP',
            createdBy: 'admin-1',
            memberCount: 3, // Changed by subsequent addMember
            membershipHash: hashMembership(members),
          },
        })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      const res = await createGroupRoom({
        roomId: 'g1',
        createdBy: 'admin-1',
        members,
      });

      expect(res.created).toBe(false);
      expect(res.room.memberCount).toBe(3);
    });

    it('throws ConflictError when existing group room has a different creator', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
      const members = [{ userId: 'u1', role: 'ADMIN' as const }];

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: {
            roomId: 'g1',
            roomType: 'GROUP',
            createdBy: 'different-creator',
            memberCount: 1,
            membershipHash: hashMembership(members),
          },
        })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      await expect(
        createGroupRoom({
          roomId: 'g1',
          createdBy: 'admin-1',
          members,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError when existing group room has a different room type', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
      const members = [{ userId: 'u1', role: 'ADMIN' as const }];

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: {
            roomId: 'g1',
            roomType: 'DIRECT',
            createdBy: 'admin-1',
            memberCount: 1,
            membershipHash: hashMembership(members),
          },
        })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      await expect(
        createGroupRoom({
          roomId: 'g1',
          createdBy: 'admin-1',
          members,
        }),
      ).rejects.toThrow(ConflictError);
    });

    it('throws ConflictError when existing group room has a different name', async () => {
      const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
      const members = [{ userId: 'u1', role: 'ADMIN' as const }];

      mockSend
        .mockRejectedValueOnce(cancelError)
        .mockResolvedValueOnce({
          Item: {
            roomId: 'g1',
            roomType: 'GROUP',
            createdBy: 'admin-1',
            name: 'Existing Name',
            memberCount: 1,
            membershipHash: hashMembership(members),
          },
        })
        .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

      await expect(
        createGroupRoom({
          roomId: 'g1',
          name: 'Requested Different Name',
          createdBy: 'admin-1',
          members,
        }),
      ).rejects.toThrow(ConflictError);
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

    it('traverses multiple DynamoDB pages and returns all members across pages via listRoomMembers', async () => {
      // Page 1
      mockSend.mockResolvedValueOnce({
        Items: [
          { roomId: 'r1', userId: 'user-1', role: 'ADMIN' },
          { roomId: 'r1', userId: 'user-2', role: 'MEMBER' },
        ],
        LastEvaluatedKey: { GSI1PK: 'ROOM#r1', GSI1SK: 'MEMBER#user-2' },
      });
      // Page 2
      mockSend.mockResolvedValueOnce({
        Items: [{ roomId: 'r1', userId: 'user-3', role: 'MEMBER' }],
      });

      const members = await listRoomMembers('r1');
      expect(members).toHaveLength(3);
      expect(members.map((m) => m.userId)).toEqual(['user-1', 'user-2', 'user-3']);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 4. User Profiles
  // =========================================================================
  describe('User Profiles', () => {
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

      const call = mockSend.mock.calls[0][0];
      expect(call.input.Item.PK).toBe('USER#user-1');
      expect(call.input.Item.SK).toBe('PROFILE');
      expect(call.input.Item.userId).toBe('user-1');
    });

    it('saving a profile replaces the existing profile and removes omitted attributes', async () => {
      mockSend.mockResolvedValueOnce({});

      // Caller saves a new profile with only `displayName`
      const updated = await putUserProfile('user-1', {
        displayName: 'Alice Updated',
      });

      expect(updated).toEqual({
        PK: 'USER#user-1',
        SK: 'PROFILE',
        GSI1PK: 'USERS',
        GSI1SK: 'USER#user-1',
        userId: 'user-1',
        displayName: 'Alice Updated',
      });

      const call = mockSend.mock.calls[0][0];
      // PutCommand replaces the entire item: old attributes not passed are omitted
      expect(call.input.Item).not.toHaveProperty('bio');
      expect(call.input.Item).not.toHaveProperty('location');
    });

    it('ensureUserProfile creates or updates profile with GSI1 keys atomically', async () => {
      mockSend.mockResolvedValueOnce({
        Attributes: {
          PK: 'USER#u-ensure',
          SK: 'PROFILE',
          userId: 'u-ensure',
          email: 'ensure@example.com',
          username: 'ensureuser',
          GSI1PK: 'USERS',
          GSI1SK: 'EMAIL#ensure@example.com',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      });

      const profile = await ensureUserProfile({
        userId: 'u-ensure',
        email: 'ensure@example.com',
        username: 'ensureuser',
        now: '2026-01-01T00:00:00Z',
      });

      expect(profile).toMatchObject({
        userId: 'u-ensure',
        email: 'ensure@example.com',
        GSI1PK: 'USERS',
        GSI1SK: 'EMAIL#ensure@example.com',
      });

      const call = mockSend.mock.calls[0][0];
      expect(call.input.Key).toEqual({ PK: 'USER#u-ensure', SK: 'PROFILE' });
      expect(call.input.UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
      expect(call.input.UpdateExpression).toContain('GSI1PK = :gsi1pk');
    });

    it('getUserProfile retrieves profile by userId', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          PK: 'USER#u-get',
          SK: 'PROFILE',
          userId: 'u-get',
          email: 'get@example.com',
        },
      });

      const profile = await getUserProfile('u-get');
      expect(profile?.userId).toBe('u-get');
      expect(profile?.email).toBe('get@example.com');
      const call = mockSend.mock.calls[0][0];
      expect(call.input.Key).toEqual({ PK: 'USER#u-get', SK: 'PROFILE' });
    });

    it('getUserByEmail queries GSI1 with USERS partition and EMAIL sort key', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            PK: 'USER#u-email',
            SK: 'PROFILE',
            userId: 'u-email',
            email: 'lookup@example.com',
            GSI1PK: 'USERS',
            GSI1SK: 'EMAIL#lookup@example.com',
          },
        ],
      });

      const profile = await getUserByEmail('LOOKUP@EXAMPLE.COM');
      expect(profile?.userId).toBe('u-email');
      expect(profile?.email).toBe('lookup@example.com');

      const call = mockSend.mock.calls[0][0];
      expect(call.input.IndexName).toBe('GSI1');
      expect(call.input.ExpressionAttributeValues[':gsi1pk']).toBe('USERS');
      expect(call.input.ExpressionAttributeValues[':gsi1sk']).toBe('EMAIL#lookup@example.com');
    });

    it('listUsers queries GSI1 to fetch paginated users', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { userId: 'u1', email: 'u1@example.com' },
          { userId: 'u2', email: 'u2@example.com' },
        ],
        LastEvaluatedKey: { PK: 'USER#u2' },
      });

      const page = await listUsers({ limit: 10 });
      expect(page.items).toHaveLength(2);
      expect(page.nextKey).toEqual({ PK: 'USER#u2' });

      const call = mockSend.mock.calls[0][0];
      expect(call.input.IndexName).toBe('GSI1');
      expect(call.input.KeyConditionExpression).toBe('GSI1PK = :gsi1pk');
      expect(call.input.ExpressionAttributeValues[':gsi1pk']).toBe('USERS');
    });
  });

  // =========================================================================
  // 5. Presence
  // =========================================================================
  describe('Presence', () => {
    it('missing presence record is treated as offline with 0 active connections', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const p = await getPresence('user-absent');
      expect(p.online).toBe(false);
      expect(p.activeConnectionCount).toBe(0);
      expect(p.lastSeenAt).toBeUndefined();
    });

    it('multiple active connections keep a user online', async () => {
      mockSend.mockResolvedValueOnce({
        Item: { activeConnectionCount: 3, lastSeenAt: '2026-11-23T12:00:00Z' },
      });

      const p = await getPresence('user-multi');
      expect(p.online).toBe(true);
      expect(p.activeConnectionCount).toBe(3);
    });

    it('removing one connection does not mark user offline while another remains', async () => {
      // Step 1: Remove connection 1
      mockSend.mockResolvedValueOnce({});
      const removeResult = await removeConnection({
        userId: 'user-1',
        connectionId: 'conn-1',
      });
      expect(removeResult).toBe('REMOVED');

      // Step 2: Presence query reflects 1 remaining connection
      mockSend.mockResolvedValueOnce({
        Item: { activeConnectionCount: 1, lastSeenAt: '2026-11-23T12:05:00Z' },
      });
      const p = await getPresence('user-1');
      expect(p.online).toBe(true);
      expect(p.activeConnectionCount).toBe(1);
    });

    it('removing the final connection marks the user offline', async () => {
      // Step 1: Remove final connection
      mockSend.mockResolvedValueOnce({});
      const removeResult = await removeConnection({
        userId: 'user-1',
        connectionId: 'conn-final',
      });
      expect(removeResult).toBe('REMOVED');

      // Step 2: Presence query reflects 0 connections
      mockSend.mockResolvedValueOnce({
        Item: { activeConnectionCount: 0, lastSeenAt: '2026-11-23T12:10:00Z' },
      });
      const p = await getPresence('user-1');
      expect(p.online).toBe(false);
      expect(p.activeConnectionCount).toBe(0);
    });

    it('presence counter cannot become negative (guarded by ConditionExpression on delete)', async () => {
      mockSend.mockResolvedValueOnce({});

      await removeConnection({ userId: 'user-1', connectionId: 'conn-1' });
      const call = mockSend.mock.calls[0][0];
      const presenceUpdate = call.input.TransactItems[1].Update;
      expect(presenceUpdate.ConditionExpression).toBe('activeConnectionCount > :zero');
      expect(presenceUpdate.ExpressionAttributeValues[':zero']).toBe(0);
      expect(presenceUpdate.ExpressionAttributeValues[':minusOne']).toBe(-1);
    });

    it('heartbeat updates do not modify the presence counter', async () => {
      mockSend.mockResolvedValueOnce({});

      const updated = await updateHeartbeat('user-1', 'conn-1', '2026-11-23T12:00:00Z');
      expect(updated).toBe(true);

      const call = mockSend.mock.calls[0][0];
      // Modifies only lastHeartbeat on the connection item
      expect(call.input.Key.SK).toBe('CONNECTION#conn-1');
      expect(call.input.UpdateExpression).toBe('SET lastHeartbeat = :now');
      expect(call.input.UpdateExpression).not.toContain('activeConnectionCount');
    });
  });

  it('verifies existing group room on race and returns created: false when count and hash match', async () => {
    const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
    const members = [{ userId: 'u1', role: 'ADMIN' as const }];
    const expectedHash = hashMembership(members);

    mockSend
      .mockRejectedValueOnce(cancelError)
      .mockResolvedValueOnce({
        Item: {
          roomId: 'g1',
          roomType: 'GROUP',
          createdBy: 'admin-1',
          memberCount: 1,
          membershipHash: expectedHash,
        },
      })
      .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } })
      .mockResolvedValueOnce({
        Item: { userId: 'u1', roomId: 'g1', role: 'ADMIN' },
      });

    const res = await createGroupRoom({
      roomId: 'g1',
      createdBy: 'admin-1',
      members,
    });

    expect(res.created).toBe(false);
    expect(res.room.roomType).toBe('GROUP');
  });

  it('succeeds on retry when existing group room has a different memberCount after membership change', async () => {
    const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
    const members = [{ userId: 'u1', role: 'ADMIN' as const }];

    mockSend
      .mockRejectedValueOnce(cancelError)
      .mockResolvedValueOnce({
        Item: {
          roomId: 'g1',
          roomType: 'GROUP',
          createdBy: 'admin-1',
          memberCount: 2, // Changed count
          membershipHash: hashMembership(members),
        },
      })
      .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

    const res = await createGroupRoom({
      roomId: 'g1',
      createdBy: 'admin-1',
      members,
    });
    expect(res.created).toBe(false);
    expect(res.room.memberCount).toBe(2);
  });

  it('throws ConflictError when existing group room has a different membership hash', async () => {
    const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
    const members = [{ userId: 'u1', role: 'ADMIN' as const }];

    mockSend
      .mockRejectedValueOnce(cancelError)
      .mockResolvedValueOnce({
        Item: {
          roomId: 'g1',
          roomType: 'GROUP',
          createdBy: 'admin-1',
          memberCount: 1,
          membershipHash: 'different-hash-value',
        },
      })
      .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

    await expect(
      createGroupRoom({
        roomId: 'g1',
        createdBy: 'admin-1',
        members,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('throws ConflictError when existing group room has missing membershipHash', async () => {
    const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);
    const members = [{ userId: 'u1', role: 'ADMIN' as const }];

    mockSend
      .mockRejectedValueOnce(cancelError)
      .mockResolvedValueOnce({
        Item: {
          roomId: 'g1',
          roomType: 'GROUP',
          createdBy: 'admin-1',
          memberCount: 1,
          // membershipHash missing
        },
      })
      .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

    await expect(
      createGroupRoom({
        roomId: 'g1',
        createdBy: 'admin-1',
        members,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('throws InternalServerError when existing group room has missing metadata', async () => {
    const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

    mockSend
      .mockRejectedValueOnce(cancelError)
      // Missing room metadata
      .mockResolvedValueOnce({ Item: undefined })
      // Counter exists
      .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } })
      // Membership exists
      .mockResolvedValueOnce({
        Item: { userId: 'u1', roomId: 'g1', role: 'ADMIN' },
      });

    await expect(
      createGroupRoom({
        roomId: 'g1',
        createdBy: 'admin-1',
        members: [{ userId: 'u1', role: 'ADMIN' }],
      }),
    ).rejects.toThrow(InternalServerError);
  });

  it('throws InternalServerError when existing direct room has incorrect room type', async () => {
    const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

    mockSend
      .mockRejectedValueOnce(cancelError)
      // Existing metadata has an incorrect room type
      .mockResolvedValueOnce({
        Item: {
          roomId: 'room-1',
          roomType: 'GROUP',
        },
      })
      .mockResolvedValueOnce({
        Item: { userId: 'user-A', roomId: 'room-1' },
      })
      .mockResolvedValueOnce({
        Item: { userId: 'user-B', roomId: 'room-1' },
      })
      .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

    await expect(createDirectRoom({ userA: 'user-A', userB: 'user-B' })).rejects.toThrow(
      InternalServerError,
    );
  });

  it('throws InternalServerError when existing direct room has incorrect membership records', async () => {
    const cancelError = createCancelError([{ Code: 'ConditionalCheckFailed' }]);

    mockSend
      .mockRejectedValueOnce(cancelError)
      .mockResolvedValueOnce({
        Item: {
          roomId: 'room-1',
          roomType: 'DIRECT',
        },
      })
      // Incorrect user returned for user-A membership
      .mockResolvedValueOnce({
        Item: { userId: 'user-C', roomId: 'room-1' },
      })
      .mockResolvedValueOnce({
        Item: { userId: 'user-B', roomId: 'room-1' },
      })
      .mockResolvedValueOnce({ Item: { sequenceNumber: 0 } });

    await expect(createDirectRoom({ userA: 'user-A', userB: 'user-B' })).rejects.toThrow(
      InternalServerError,
    );
  });
});
