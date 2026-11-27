import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as sendMessageHandler } from '../../../src/handlers/websocket/sendMessage';
import * as repositories from '../../../src/repositories';
import * as shared from '../../../src/shared';
import {
  createInvalidConnectionEvent,
  createMockEvent,
  type ExpectedResponse,
  mockCallback,
  mockContext,
} from './helpers';

describe('SendMessage Handler (sendMessage)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TABLE_NAME: 'test-table',
      API_GATEWAY_MANAGEMENT_ENDPOINT: 'https://test-api.execute-api.ap-south-1.amazonaws.com/dev',
    };
    vi.restoreAllMocks();
    shared.resetConnectionRateLimits();
    vi.spyOn(repositories, 'isMember').mockResolvedValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Validation & Authentication', () => {
    it('returns 400 when connection context is missing', async () => {
      const event = createInvalidConnectionEvent('sendMessage');
      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Missing WebSocket connection context');
    });

    it('returns 401 when authorizer userId is missing', async () => {
      const event = createMockEvent({
        routeKey: 'sendMessage',
        authorizer: { userId: '' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'Hello',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).message).toBe('Missing authenticated userId');
    });

    it('returns 400 when body is missing', async () => {
      const event = createMockEvent({
        routeKey: 'sendMessage',
        body: undefined,
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Missing request body');
    });

    it('returns 400 when body is invalid JSON', async () => {
      const event = createMockEvent({
        routeKey: 'sendMessage',
        body: 'invalid-json{',
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Invalid JSON in request body');
    });

    it('returns 400 when neither recipientUserId nor roomId is provided', async () => {
      const event = createMockEvent({
        routeKey: 'sendMessage',
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          body: 'Hello',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain(
        'Either recipientUserId or roomId must be provided',
      );
    });

    it('returns 400 when both recipientUserId and roomId are provided', async () => {
      const event = createMockEvent({
        routeKey: 'sendMessage',
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          roomId: 'room-1',
          body: 'Hello',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain(
        'Cannot provide both recipientUserId and roomId',
      );
    });

    it('returns 400 when message body is empty', async () => {
      const event = createMockEvent({
        routeKey: 'sendMessage',
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: '   ',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('body cannot be empty');
    });

    it('returns 400 when client sends direct message to themselves', async () => {
      const getUserProfileSpy = vi.spyOn(repositories, 'getUserProfile');
      const createDirectRoomSpy = vi.spyOn(repositories, 'createDirectRoom');
      const createMessageSpy = vi.spyOn(repositories, 'createMessage');

      const event = createMockEvent({
        routeKey: 'sendMessage',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'alice',
          body: 'Note to self',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Cannot send a direct message to yourself');
      expect(getUserProfileSpy).not.toHaveBeenCalled();
      expect(createDirectRoomSpy).not.toHaveBeenCalled();
      expect(createMessageSpy).not.toHaveBeenCalled();
    });

    it('returns 400 when recipient user does not exist', async () => {
      const getUserProfileSpy = vi
        .spyOn(repositories, 'getUserProfile')
        .mockResolvedValue(undefined);
      const createDirectRoomSpy = vi.spyOn(repositories, 'createDirectRoom');
      const createMessageSpy = vi.spyOn(repositories, 'createMessage');

      const event = createMockEvent({
        routeKey: 'sendMessage',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'non-existent-user',
          body: 'Hello',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toContain('does not exist');
      expect(getUserProfileSpy).toHaveBeenCalledWith('non-existent-user', true);
      expect(createDirectRoomSpy).not.toHaveBeenCalled();
      expect(createMessageSpy).not.toHaveBeenCalled();
    });

    it('returns a server error when getUserProfile throws a database error', async () => {
      const getUserProfileSpy = vi
        .spyOn(repositories, 'getUserProfile')
        .mockRejectedValue(new Error('DynamoDB connection timeout'));
      const createDirectRoomSpy = vi.spyOn(repositories, 'createDirectRoom');
      const createMessageSpy = vi.spyOn(repositories, 'createMessage');

      const event = createMockEvent({
        routeKey: 'sendMessage',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'Hello',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(500);
      expect(result.statusCode).not.toBe(400);
      expect(JSON.parse(result.body).message).toBe('Internal server error');
      expect(getUserProfileSpy).toHaveBeenCalledWith('bob', true);
      expect(createDirectRoomSpy).not.toHaveBeenCalled();
      expect(createMessageSpy).not.toHaveBeenCalled();
    });
  });

  describe('Direct 1:1 Messaging', () => {
    it('successfully creates room, persists message, delivers to recipient, and returns ACK', async () => {
      const senderId = 'alice';
      const recipientId = 'bob';
      const expectedRoomId = repositories.directRoomId(senderId, recipientId);

      const getUserProfileSpy = vi.spyOn(repositories, 'getUserProfile').mockResolvedValue({
        PK: `USER#${recipientId}`,
        SK: 'PROFILE',
        userId: recipientId,
        email: 'bob@example.com',
        createdAt: '2026-11-20T00:00:00.000Z',
      });

      const createDirectRoomSpy = vi.spyOn(repositories, 'createDirectRoom').mockResolvedValue({
        room: {
          PK: `ROOM#${expectedRoomId}`,
          SK: 'META',
          roomId: expectedRoomId,
          roomType: 'DIRECT',
          createdAt: '2026-11-24T00:00:00.000Z',
          createdBy: senderId,
          memberCount: 2,
        },
        created: true,
      });

      const createMessageSpy = vi.spyOn(repositories, 'createMessage').mockResolvedValue({
        duplicate: false,
        messageId: 'client-msg-1',
        sequenceNumber: 1,
        createdAt: '2026-11-24T00:00:01.000Z',
      });

      vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (userId) => {
        if (userId === recipientId) {
          return [
            {
              PK: `USER#${recipientId}`,
              SK: 'CONN#conn-bob-1',
              userId: recipientId,
              connectionId: 'conn-bob-1',
              connectedAt: '2026-11-24T00:00:00.000Z',
              lastHeartbeat: '2026-11-24T00:00:00.000Z',
            },
            {
              PK: `USER#${recipientId}`,
              SK: 'CONN#conn-bob-2',
              userId: recipientId,
              connectionId: 'conn-bob-2',
              connectedAt: '2026-11-24T00:00:00.000Z',
              lastHeartbeat: '2026-11-24T00:00:00.000Z',
            },
          ];
        }
        if (userId === senderId) {
          return [
            {
              PK: `USER#${senderId}`,
              SK: 'CONN#conn-alice-current',
              userId: senderId,
              connectionId: 'conn-alice-current',
              connectedAt: '2026-11-24T00:00:00.000Z',
              lastHeartbeat: '2026-11-24T00:00:00.000Z',
            },
            {
              PK: `USER#${senderId}`,
              SK: 'CONN#conn-alice-other-device',
              userId: senderId,
              connectionId: 'conn-alice-other-device',
              connectedAt: '2026-11-24T00:00:00.000Z',
              lastHeartbeat: '2026-11-24T00:00:00.000Z',
            },
          ];
        }
        return [];
      });

      const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

      const event = createMockEvent({
        connectionId: 'conn-alice-current',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'client-msg-1',
          recipientUserId: recipientId,
          body: 'Hello Bob!',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      const ack = JSON.parse(result.body);
      expect(ack).toEqual({
        action: 'ack',
        messageId: 'client-msg-1',
        roomId: expectedRoomId,
        sequenceNumber: 1,
        createdAt: '2026-11-24T00:00:01.000Z',
        isDuplicate: false,
      });

      expect(getUserProfileSpy).toHaveBeenCalledWith(recipientId, true);
      expect(createDirectRoomSpy).toHaveBeenCalledWith({
        userA: senderId,
        userB: recipientId,
      });

      expect(createMessageSpy).toHaveBeenCalledWith({
        roomId: expectedRoomId,
        senderId,
        clientMessageId: 'client-msg-1',
        content: 'Hello Bob!',
        messageType: 'TEXT',
      });

      // Dispatched to Bob's 2 connections + Alice's 1 other device connection = 3 dispatches
      expect(postSpy).toHaveBeenCalledTimes(3);
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-bob-1',
          userId: recipientId,
          payload: expect.objectContaining({
            action: 'message',
            body: 'Hello Bob!',
            sequenceNumber: 1,
          }),
        }),
      );
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-alice-other-device',
          userId: senderId,
        }),
      );
    });

    it('handles idempotent duplicate send without fanning out again', async () => {
      const senderId = 'alice';
      const recipientId = 'bob';
      const expectedRoomId = repositories.directRoomId(senderId, recipientId);

      const getUserProfileSpy = vi.spyOn(repositories, 'getUserProfile').mockResolvedValue({
        PK: `USER#${recipientId}`,
        SK: 'PROFILE',
        userId: recipientId,
        email: 'bob@example.com',
        createdAt: '2026-11-20T00:00:00.000Z',
      });

      vi.spyOn(repositories, 'createDirectRoom').mockResolvedValue({
        room: {} as repositories.RoomItem,
        created: false,
      });

      vi.spyOn(repositories, 'createMessage').mockResolvedValue({
        duplicate: true,
        messageId: 'client-msg-1',
        sequenceNumber: 5,
        createdAt: '2026-11-24T00:00:01.000Z',
      });

      vi.spyOn(repositories, 'listUserConnections').mockResolvedValue([]);

      const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

      const event = createMockEvent({
        connectionId: 'conn-alice-1',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'client-msg-1',
          recipientUserId: recipientId,
          body: 'Hello Bob!',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      const ack = JSON.parse(result.body);
      expect(ack).toEqual({
        action: 'ack',
        messageId: 'client-msg-1',
        roomId: expectedRoomId,
        sequenceNumber: 5,
        createdAt: '2026-11-24T00:00:01.000Z',
        isDuplicate: true,
      });

      // No fan-out on duplicate replay
      expect(getUserProfileSpy).toHaveBeenCalledWith(recipientId, true);
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('persists message and returns ACK without delivering when recipient and sender have no active connections', async () => {
      const senderId = 'alice';
      const recipientId = 'bob';
      const expectedRoomId = repositories.directRoomId(senderId, recipientId);

      vi.spyOn(repositories, 'getUserProfile').mockResolvedValue({
        PK: `USER#${recipientId}`,
        SK: 'PROFILE',
        userId: recipientId,
        email: 'bob@example.com',
        createdAt: '2026-11-20T00:00:00.000Z',
      });

      vi.spyOn(repositories, 'createDirectRoom').mockResolvedValue({
        room: {
          PK: `ROOM#${expectedRoomId}`,
          SK: 'META',
          roomId: expectedRoomId,
          roomType: 'DIRECT',
          createdAt: '2026-11-24T00:00:00.000Z',
          createdBy: senderId,
          memberCount: 2,
        },
        created: false,
      });

      const createMessageSpy = vi.spyOn(repositories, 'createMessage').mockResolvedValue({
        duplicate: false,
        messageId: 'client-msg-offline',
        sequenceNumber: 7,
        createdAt: '2026-11-24T00:00:02.000Z',
      });

      // 1. Mock listUserConnections to return an empty array for recipient and sender
      const listConnectionsSpy = vi
        .spyOn(repositories, 'listUserConnections')
        .mockResolvedValue([]);

      const postSpy = vi.spyOn(shared, 'postToConnection');

      // 2. Send a valid direct message
      const event = createMockEvent({
        connectionId: 'conn-alice-current',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'client-msg-offline',
          recipientUserId: recipientId,
          body: 'Are you online?',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      // 3. Expect HTTP 200
      expect(result.statusCode).toBe(200);

      // 4. Expect createMessage to be called
      expect(createMessageSpy).toHaveBeenCalledWith({
        roomId: expectedRoomId,
        senderId,
        clientMessageId: 'client-msg-offline',
        content: 'Are you online?',
        messageType: 'TEXT',
      });

      // 5. Expect postToConnection not to be called
      expect(postSpy).not.toHaveBeenCalled();

      // 6. Expect the sender ACK to contain the correct messageId, roomId, and sequenceNumber
      const ack = JSON.parse(result.body);
      expect(ack).toEqual({
        action: 'ack',
        messageId: 'client-msg-offline',
        roomId: expectedRoomId,
        sequenceNumber: 7,
        createdAt: '2026-11-24T00:00:02.000Z',
        isDuplicate: false,
      });

      expect(listConnectionsSpy).toHaveBeenCalledWith(recipientId);
      expect(listConnectionsSpy).toHaveBeenCalledWith(senderId);
    });
  });

  describe('Existing Room Messaging', () => {
    it('rejects with 403 when sender is not a member of the room', async () => {
      const isMemberSpy = vi.spyOn(repositories, 'isMember').mockResolvedValue(false);
      const createMessageSpy = vi.spyOn(repositories, 'createMessage');
      const listRoomMembersSpy = vi.spyOn(repositories, 'listRoomMembers');
      const postSpy = vi.spyOn(shared, 'postToConnection');

      const event = createMockEvent({
        routeKey: 'sendMessage',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          roomId: 'room-secret',
          body: 'Can I join?',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;
      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body).message).toBe('You are not a member of this room');
      expect(isMemberSpy).toHaveBeenCalledWith('alice', 'room-secret');
      expect(createMessageSpy).not.toHaveBeenCalled();
      expect(listRoomMembersSpy).not.toHaveBeenCalled();
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('returns a server error when isMember throws a database error', async () => {
      const isMemberSpy = vi
        .spyOn(repositories, 'isMember')
        .mockRejectedValue(new Error('DynamoDB table read error'));
      const createMessageSpy = vi.spyOn(repositories, 'createMessage');
      const listRoomMembersSpy = vi.spyOn(repositories, 'listRoomMembers');
      const postSpy = vi.spyOn(shared, 'postToConnection');

      const event = createMockEvent({
        routeKey: 'sendMessage',
        authorizer: { userId: 'alice' },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-1',
          roomId: 'room-error',
          body: 'Hello',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(500);
      expect(result.statusCode).not.toBe(403);
      expect(JSON.parse(result.body).message).toBe('Internal server error');
      expect(isMemberSpy).toHaveBeenCalledWith('alice', 'room-error');
      expect(createMessageSpy).not.toHaveBeenCalled();
      expect(listRoomMembersSpy).not.toHaveBeenCalled();
      expect(postSpy).not.toHaveBeenCalled();
    });

    it('sends to room members when sender is authorized', async () => {
      const senderId = 'alice';
      const roomId = 'room-alpha';

      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
        {
          PK: `USER#${senderId}`,
          SK: `MEMBER#${roomId}`,
          userId: senderId,
          roomId,
          joinedAt: '',
          role: 'MEMBER',
          GSI1PK: '',
          GSI1SK: '',
        },
        {
          PK: 'USER#bob',
          SK: `MEMBER#${roomId}`,
          userId: 'bob',
          roomId,
          joinedAt: '',
          role: 'MEMBER',
          GSI1PK: '',
          GSI1SK: '',
        },
      ]);

      vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (userId) => {
        if (userId === senderId) {
          return [
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-alice-current',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        if (userId === 'bob') {
          return [
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-1',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        return [];
      });

      vi.spyOn(repositories, 'createMessage').mockResolvedValue({
        duplicate: false,
        messageId: 'msg-alpha-1',
        sequenceNumber: 42,
        createdAt: '2026-11-24T00:00:10.000Z',
      });

      const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

      const event = createMockEvent({
        connectionId: 'conn-alice-current',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-alpha-1',
          roomId,
          body: 'Room broadcast',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        action: 'ack',
        messageId: 'msg-alpha-1',
        roomId,
        sequenceNumber: 42,
        createdAt: '2026-11-24T00:00:10.000Z',
        isDuplicate: false,
      });

      expect(postSpy).toHaveBeenCalledTimes(1);
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-bob-1',
          userId: 'bob',
        }),
      );
    });
  });

  describe('Message Delivery Handling & Resilience', () => {
    const senderId = 'alice';
    const recipientId = 'bob';
    const expectedRoomId = repositories.directRoomId(senderId, recipientId);

    beforeEach(() => {
      vi.spyOn(repositories, 'getUserProfile').mockResolvedValue({
        PK: `USER#${recipientId}`,
        SK: 'PROFILE',
        userId: recipientId,
        email: 'bob@example.com',
        createdAt: '2026-11-20T00:00:00.000Z',
      });
      vi.spyOn(repositories, 'createDirectRoom').mockResolvedValue({
        room: {} as repositories.RoomItem,
        created: false,
      });
      vi.spyOn(repositories, 'createMessage').mockResolvedValue({
        duplicate: false,
        messageId: 'msg-deliv-1',
        sequenceNumber: 10,
        createdAt: '2026-11-24T00:00:10.000Z',
      });
    });

    it('handles all successful deliveries', async () => {
      vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (userId) => {
        if (userId === recipientId) {
          return [
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-1',
              connectedAt: '',
              lastHeartbeat: '',
            },
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-2',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        return [];
      });

      const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

      const event = createMockEvent({
        connectionId: 'conn-alice-current',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-deliv-1',
          recipientUserId: recipientId,
          body: 'Hello everyone!',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).isDuplicate).toBe(false);
      expect(postSpy).toHaveBeenCalledTimes(2);
    });

    it('distinguishes stale connections (GoneException) and preserves sender ACK', async () => {
      vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (userId) => {
        if (userId === recipientId) {
          return [
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-alive',
              connectedAt: '',
              lastHeartbeat: '',
            },
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-stale',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        return [];
      });

      // conn-bob-alive succeeds (true), conn-bob-stale returns false (pruned 410)
      const postSpy = vi
        .spyOn(shared, 'postToConnection')
        .mockImplementation(async ({ connectionId }) => {
          return connectionId === 'conn-bob-alive';
        });

      const event = createMockEvent({
        connectionId: 'conn-alice-current',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-deliv-1',
          recipientUserId: recipientId,
          body: 'Testing stale pruning',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        action: 'ack',
        messageId: 'msg-deliv-1',
        roomId: expectedRoomId,
        sequenceNumber: 10,
        createdAt: '2026-11-24T00:00:10.000Z',
        isDuplicate: false,
      });

      expect(postSpy).toHaveBeenCalledTimes(2);
    });

    it('logs unexpected delivery failures without exposing message body and continues other deliveries', async () => {
      vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (userId) => {
        if (userId === recipientId) {
          return [
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-ok',
              connectedAt: '',
              lastHeartbeat: '',
            },
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-fail',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        return [];
      });

      const warnSpy = vi.spyOn(shared.Logger.prototype, 'warn');
      const secretBody = 'Top Secret Message Body';

      const postSpy = vi
        .spyOn(shared, 'postToConnection')
        .mockImplementation(async ({ connectionId }) => {
          if (connectionId === 'conn-bob-fail') {
            throw new Error('Simulated AWS 500 error');
          }
          return true;
        });

      const event = createMockEvent({
        connectionId: 'conn-alice-current',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-deliv-1',
          recipientUserId: recipientId,
          body: secretBody,
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      // Sender ACK is still returned
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).sequenceNumber).toBe(10);

      // Both connections were attempted
      expect(postSpy).toHaveBeenCalledTimes(2);

      // Warning was logged for the failed connection
      expect(warnSpy).toHaveBeenCalledWith(
        'Delivery failure to connection',
        expect.objectContaining({
          connectionId: 'conn-bob-fail',
          targetUserId: recipientId,
          errorMessage: 'Simulated AWS 500 error',
        }),
      );

      // Verify secret body is NEVER logged
      for (const call of warnSpy.mock.calls) {
        const loggedJson = JSON.stringify(call);
        expect(loggedJson).not.toContain(secretBody);
      }
    });

    it('concurrently gathers room member connections without duplicates and excludes active sender', async () => {
      const roomId = 'room-dedup';
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
        {
          PK: `USER#${senderId}`,
          SK: `MEMBER#${roomId}`,
          userId: senderId,
          roomId,
          joinedAt: '',
          role: 'MEMBER',
          GSI1PK: '',
          GSI1SK: '',
        },
        {
          PK: 'USER#bob',
          SK: `MEMBER#${roomId}`,
          userId: 'bob',
          roomId,
          joinedAt: '',
          role: 'MEMBER',
          GSI1PK: '',
          GSI1SK: '',
        },
        {
          PK: 'USER#charlie',
          SK: `MEMBER#${roomId}`,
          userId: 'charlie',
          roomId,
          joinedAt: '',
          role: 'MEMBER',
          GSI1PK: '',
          GSI1SK: '',
        },
      ]);

      vi.spyOn(repositories, 'listUserConnections').mockImplementation(async (userId) => {
        if (userId === senderId) {
          return [
            // Active sending connection (should be excluded)
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-alice-active',
              connectedAt: '',
              lastHeartbeat: '',
            },
            // Alice's second device (should be included)
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-alice-tablet',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        if (userId === 'bob') {
          return [
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-1',
              connectedAt: '',
              lastHeartbeat: '',
            },
            // Duplicate of bob's connection
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-bob-1',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        if (userId === 'charlie') {
          return [
            {
              PK: '',
              SK: '',
              userId,
              connectionId: 'conn-charlie-1',
              connectedAt: '',
              lastHeartbeat: '',
            },
          ];
        }
        return [];
      });

      const postSpy = vi.spyOn(shared, 'postToConnection').mockResolvedValue(true);

      const event = createMockEvent({
        connectionId: 'conn-alice-active',
        routeKey: 'sendMessage',
        authorizer: { userId: senderId },
        body: JSON.stringify({
          action: 'sendMessage',
          messageId: 'msg-room-1',
          roomId,
          body: 'Hello room',
        }),
      });

      const result = (await sendMessageHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);

      // Targeted connections: conn-alice-tablet, conn-bob-1, conn-charlie-1 (exactly 3, no duplicates, active excluded)
      expect(postSpy).toHaveBeenCalledTimes(3);
      const dispatchedConnectionIds = postSpy.mock.calls.map((call) => call[0].connectionId);
      expect(dispatchedConnectionIds).toEqual([
        'conn-alice-tablet',
        'conn-bob-1',
        'conn-charlie-1',
      ]);
      expect(dispatchedConnectionIds).not.toContain('conn-alice-active');
    });
  });
});
