import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  handler as messagesHandler,
  toMessageDto,
} from '../../../src/handlers/http/messages';
import type { MessageItem } from '../../../src/repositories';
import * as repositories from '../../../src/repositories';
import type { HttpResponse } from '../../../src/shared';

const mockContext = {} as Context;
const mockCallback = () => {};

function createHttpEvent(
  overrides: {
    method?: string;
    rawPath?: string;
    userId?: string;
    roomId?: string;
    pathParameters?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    claims?: Record<string, unknown>;
  } = {},
): APIGatewayProxyEventV2 {
  const method = overrides.method || 'GET';
  const roomId = overrides.roomId || 'test-room-123';
  const rawPath = overrides.rawPath || `/rooms/${roomId}/messages`;
  const pathParameters =
    overrides.pathParameters !== undefined ? overrides.pathParameters : { roomId };
  const claims =
    overrides.claims !== undefined
      ? overrides.claims
      : {
          sub: overrides.userId || 'auth-user-123',
          email: 'auth@example.com',
          'cognito:username': 'authuser',
        };

  return {
    version: '2.0',
    routeKey: `${method} /rooms/{roomId}/messages`,
    rawPath,
    rawQueryString: '',
    headers: {
      authorization: 'Bearer token',
    },
    queryStringParameters: overrides.queryStringParameters,
    pathParameters,
    requestContext: {
      accountId: '123456789012',
      apiId: 'http-api-id',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test-agent',
      },
      requestId: 'req-msg-1',
      routeKey: `${method} /rooms/{roomId}/messages`,
      stage: 'dev',
      time: '24/Nov/2026:10:00:00 +0000',
      timeEpoch: 1700000000000,
      authorizer: {
        jwt: {
          claims,
          scopes: [],
        },
      },
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function sampleMessage(
  seq: number,
  roomId = 'test-room-123',
  senderId = 'user-alice',
): MessageItem {
  return {
    PK: `ROOM#${roomId}`,
    SK: `MSG#${String(seq).padStart(10, '0')}`,
    messageId: `msg-${seq}`,
    clientMessageId: `cli-${seq}`,
    roomId,
    senderId,
    content: `Message ${seq}`,
    sequenceNumber: seq,
    createdAt: new Date(1700000000000 + seq * 1000).toISOString(),
    messageType: 'TEXT',
  };
}

describe('Messages HTTP Handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CORS and Method Handling', () => {
    it('handles OPTIONS preflight request', async () => {
      const event = createHttpEvent({ method: 'OPTIONS' });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res.headers['Access-Control-Allow-Methods']).toContain('GET');
    });

    it('returns 404 for unsupported HTTP methods', async () => {
      const event = createHttpEvent({ method: 'POST' });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toContain('Method POST not allowed');
    });
  });

  describe('Authentication', () => {
    it('returns 401 when JWT authorizer claims are missing sub', async () => {
      const event = createHttpEvent({ claims: {} });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).message).toContain('sub claim is required');
    });

    it('returns 401 when claims sub is whitespace only', async () => {
      const event = createHttpEvent({ claims: { sub: '   ' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).message).toContain('sub claim is required');
    });
  });

  describe('Parameter Validation', () => {
    it('returns 400 when roomId is missing', async () => {
      const event = createHttpEvent({ pathParameters: {} });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('roomId is required');
    });

    it('returns 400 when roomId contains "#"', async () => {
      const event = createHttpEvent({ roomId: 'bad#room#id' });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('roomId must not contain "#"');
    });

    it('returns 400 when limit is less than 1', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const event = createHttpEvent({ queryStringParameters: { limit: '0' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('limit must be an integer between 1 and 100');
    });

    it('returns 400 when limit is not an integer', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const event = createHttpEvent({ queryStringParameters: { limit: 'abc' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('limit must be an integer between 1 and 100');
    });

    it('clamps limit to 100 when greater than 100', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const listSpy = vi.spyOn(repositories, 'listLatestMessages').mockResolvedValue({
        items: [],
      });
      const event = createHttpEvent({ queryStringParameters: { limit: '250' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(listSpy).toHaveBeenCalledWith('test-room-123', { limit: 100, startKey: undefined });
    });

    it('returns 400 when after sequence is negative', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const event = createHttpEvent({ queryStringParameters: { after: '-1' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('after must be a non-negative integer');
    });

    it('returns 400 when after sequence is not an integer', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const event = createHttpEvent({ queryStringParameters: { after: 'xyz' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('after must be a non-negative integer');
    });
  });

  describe('Membership Authorization', () => {
    it('returns 403 Forbidden when user is not a member of the room', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(false);
      vi.spyOn(repositories, 'getRoom').mockResolvedValue({
        PK: 'ROOM#private-room',
        SK: 'META',
        roomId: 'private-room',
        roomType: 'GROUP',
        createdBy: 'user-admin',
        memberCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const listSpy = vi.spyOn(repositories, 'listLatestMessages');

      const event = createHttpEvent({ userId: 'stranger-user', roomId: 'private-room' });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toBe('You are not a member of this room');
      expect(listSpy).not.toHaveBeenCalled();
    });

    it('returns 404 Not Found when room does not exist', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(false);
      vi.spyOn(repositories, 'getRoom').mockResolvedValue(undefined);

      const event = createHttpEvent({ userId: 'stranger-user', roomId: 'missing-room' });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toContain('Room missing-room not found');
    });

    it('returns 500 when isMember database call fails', async () => {
      vi.spyOn(repositories, 'isMember').mockRejectedValue(new Error('DynamoDB timeout'));
      const event = createHttpEvent();
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).message).toBe('Internal server error');
    });
  });

  describe('Cursor Decoding and Validation', () => {
    it('returns 400 when cursor is not valid base64', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const event = createHttpEvent({ queryStringParameters: { cursor: '!!!not-base64!!!' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('not valid base64');
    });

    it('returns 400 when cursor base64 decodes to invalid JSON', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const invalidJsonBase64 = Buffer.from('this is not json').toString('base64');
      const event = createHttpEvent({ queryStringParameters: { cursor: invalidJsonBase64 } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('malformed JSON payload');
    });

    it('returns 400 when cursor decodes to non-object (e.g. array)', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const arrayBase64 = Buffer.from(JSON.stringify(['key1', 'key2'])).toString('base64');
      const event = createHttpEvent({ queryStringParameters: { cursor: arrayBase64 } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('expected key object');
    });

    it('returns 400 when cursor is an empty object', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const emptyBase64 = Buffer.from(JSON.stringify({})).toString('base64');
      const event = createHttpEvent({ queryStringParameters: { cursor: emptyBase64 } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('key object cannot be empty');
    });

    it('returns 400 when cursor is missing required PK or SK', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const missingSkBase64 = Buffer.from(JSON.stringify({ PK: 'ROOM#test' })).toString('base64');
      const event = createHttpEvent({ queryStringParameters: { cursor: missingSkBase64 } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('missing required DynamoDB key attributes');
    });

    it('returns 400 when cursor belongs to a different room', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const foreignCursor = Buffer.from(
        JSON.stringify({ PK: 'ROOM#other-room-999', SK: 'MSG#0000000050' }),
      ).toString('base64');
      const event = createHttpEvent({ queryStringParameters: { cursor: foreignCursor } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain(
        'cursor does not belong to the requested room',
      );
    });

    it('returns 400 when cursor points to META instead of a message record', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const metaCursor = Buffer.from(
        JSON.stringify({ PK: 'ROOM#test-room-123', SK: 'META' }),
      ).toString('base64');
      const event = createHttpEvent({ queryStringParameters: { cursor: metaCursor } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('cursor does not point to a message record');
    });

    it('returns 400 when cursor points to MEMBER# item instead of a message record', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const memberCursor = Buffer.from(
        JSON.stringify({ PK: 'ROOM#test-room-123', SK: 'MEMBER#user-alice' }),
      ).toString('base64');
      const event = createHttpEvent({ queryStringParameters: { cursor: memberCursor } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('cursor does not point to a message record');
    });

    it('passes decoded cursor to repository when valid', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const startKey = { PK: 'ROOM#test-room-123', SK: 'MSG#0000000050' };
      const validCursor = Buffer.from(JSON.stringify(startKey)).toString('base64');
      const listSpy = vi.spyOn(repositories, 'listLatestMessages').mockResolvedValue({
        items: [],
      });

      const event = createHttpEvent({ queryStringParameters: { cursor: validCursor } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(listSpy).toHaveBeenCalledWith('test-room-123', { limit: 50, startKey });
    });
  });

  describe('Browsing Mode (Latest Messages)', () => {
    it('retrieves latest messages and strips internal PK/SK partition keys', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const mockItems = [sampleMessage(5), sampleMessage(4), sampleMessage(3)];
      const nextKey = { PK: 'ROOM#test-room-123', SK: 'MSG#0000000003' };

      vi.spyOn(repositories, 'listLatestMessages').mockResolvedValue({
        items: mockItems,
        nextKey,
      });

      const event = createHttpEvent({ queryStringParameters: { limit: '20' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.items).toHaveLength(3);
      expect(body.items[0]).toEqual({
        messageId: 'msg-5',
        clientMessageId: 'cli-5',
        roomId: 'test-room-123',
        sequenceNumber: 5,
        senderId: 'user-alice',
        content: 'Message 5',
        body: 'Message 5',
        messageType: 'TEXT',
        createdAt: mockItems[0].createdAt,
      });

      // Assert internal keys are NOT exposed
      for (const item of body.items) {
        expect(item.PK).toBeUndefined();
        expect(item.SK).toBeUndefined();
      }

      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBe(Buffer.from(JSON.stringify(nextKey)).toString('base64'));
    });

    it('returns empty items and hasMore false when room has no messages', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      vi.spyOn(repositories, 'listLatestMessages').mockResolvedValue({
        items: [],
        nextKey: undefined,
      });

      const event = createHttpEvent();
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toEqual([]);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeUndefined();
    });
  });

  describe('Catch-Up Recovery Mode (?after=N)', () => {
    it('queries messages strictly after sequence in ascending order', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const mockItems = [sampleMessage(11), sampleMessage(12)];
      const afterSpy = vi.spyOn(repositories, 'listMessagesAfter').mockResolvedValue({
        items: mockItems,
      });

      const event = createHttpEvent({ queryStringParameters: { after: '10', limit: '50' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(afterSpy).toHaveBeenCalledWith('test-room-123', 10, {
        limit: 50,
        startKey: undefined,
      });

      const body = JSON.parse(res.body);
      expect(body.items.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual([11, 12]);
      expect(body.hasMore).toBe(false);
    });

    it('accepts after=0 for catching up from the start of the room', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      const afterSpy = vi.spyOn(repositories, 'listMessagesAfter').mockResolvedValue({
        items: [sampleMessage(1)],
      });

      const event = createHttpEvent({ queryStringParameters: { after: '0' } });
      const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(afterSpy).toHaveBeenCalledWith('test-room-123', 0, {
        limit: 50,
        startKey: undefined,
      });
    });
  });

  describe('Helper Functions', () => {
    it('toMessageDto formats message correctly with or without clientMessageId', () => {
      const msgWithClient = sampleMessage(1);
      const dto1 = toMessageDto(msgWithClient);
      expect(dto1.clientMessageId).toBe('cli-1');
      expect(dto1.body).toBe(msgWithClient.content);

      const msgWithoutClient: MessageItem = {
        ...sampleMessage(2),
        clientMessageId: '',
      };
      const dto2 = toMessageDto(msgWithoutClient);
      expect(dto2.clientMessageId).toBeUndefined();
    });

    it('encodeCursor returns undefined for falsy or empty key', () => {
      expect(encodeCursor(undefined)).toBeUndefined();
      expect(encodeCursor({})).toBeUndefined();
    });

    it('decodeCursor returns undefined for falsy or empty string', () => {
      expect(decodeCursor(undefined)).toBeUndefined();
      expect(decodeCursor('')).toBeUndefined();
      expect(decodeCursor('   ')).toBeUndefined();
    });
  });
});
