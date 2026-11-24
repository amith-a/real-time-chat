import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handler as messagesHandler } from '../../src/handlers/http/messages';
import { createDirectRoom, createMessage } from '../../src/repositories';
import type { HttpResponse } from '../../src/shared';
import { createTestTable, now, safeTeardown } from './helpers';

const mockContext = {} as Context;
const mockCallback = () => {};

function createHttpEvent(
  overrides: {
    method?: string;
    userId?: string;
    roomId?: string;
    pathParameters?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    claims?: Record<string, unknown>;
  } = {},
): APIGatewayProxyEventV2 {
  const method = overrides.method || 'GET';
  const roomId = overrides.roomId || 'test-room';
  const rawPath = `/rooms/${roomId}/messages`;
  const pathParameters =
    overrides.pathParameters !== undefined ? overrides.pathParameters : { roomId };
  const claims =
    overrides.claims !== undefined
      ? overrides.claims
      : {
          sub: overrides.userId || 'user-alice',
          email: 'alice@example.com',
          'cognito:username': 'alice',
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
      requestId: 'req-history-integration',
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

describe('History API Integration (DynamoDB Local)', () => {
  let table: string;
  let roomId: string;
  const userAlice = 'user-alice';
  const userBob = 'user-bob';
  const userCharlie = 'user-charlie';

  beforeAll(async () => {
    table = await createTestTable();

    // 1. Create a direct room between Alice and Bob
    const roomResult = await createDirectRoom({
      userA: userAlice,
      userB: userBob,
      now: now(),
    });
    roomId = roomResult.room.roomId;

    // 2. Insert 5 sequential messages into the room
    for (let i = 1; i <= 5; i++) {
      await createMessage({
        roomId,
        senderId: i % 2 === 1 ? userAlice : userBob,
        clientMessageId: `hist-cli-${i}`,
        content: `Message content ${i}`,
      });
    }
  });

  afterAll(async () => {
    await safeTeardown(table);
  });

  it('rejects non-members with 403 Forbidden', async () => {
    const event = createHttpEvent({
      userId: userCharlie,
      roomId,
    });
    const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('You are not a member of this room');
  });

  it('rejects requests with missing sub claim with 401 Unauthorized', async () => {
    const event = createHttpEvent({
      roomId,
      claims: {},
    });
    const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

    expect(res.statusCode).toBe(401);
  });

  it('returns messages newest first by default, strictly excluding META and COUNTER items', async () => {
    const event = createHttpEvent({
      userId: userAlice,
      roomId,
    });
    const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.items).toHaveLength(5);

    // Verify ordering: newest first (descending sequence numbers)
    const sequences = body.items.map((m: { sequenceNumber: number }) => m.sequenceNumber);
    expect(sequences).toEqual([5, 4, 3, 2, 1]);

    // Verify DTO sanitization: no PK/SK internal attributes
    for (const item of body.items) {
      expect(item.PK).toBeUndefined();
      expect(item.SK).toBeUndefined();
      expect(item.roomId).toBe(roomId);
      expect(item.messageId).toBeDefined();
      expect(item.content).toBeDefined();
      expect(item.body).toBe(item.content);
    }
  });

  it('paginates forward through history with cursors', async () => {
    // Page 1: limit 2
    const page1Event = createHttpEvent({
      userId: userAlice,
      roomId,
      queryStringParameters: { limit: '2' },
    });
    const page1Res = (await messagesHandler(page1Event, mockContext, mockCallback)) as HttpResponse;
    expect(page1Res.statusCode).toBe(200);
    const page1Body = JSON.parse(page1Res.body);

    expect(page1Body.items.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual([
      5, 4,
    ]);
    expect(page1Body.hasMore).toBe(true);
    expect(page1Body.nextCursor).toBeDefined();

    // Page 2: limit 2 using nextCursor
    const page2Event = createHttpEvent({
      userId: userAlice,
      roomId,
      queryStringParameters: { limit: '2', cursor: page1Body.nextCursor },
    });
    const page2Res = (await messagesHandler(page2Event, mockContext, mockCallback)) as HttpResponse;
    expect(page2Res.statusCode).toBe(200);
    const page2Body = JSON.parse(page2Res.body);

    expect(page2Body.items.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual([
      3, 2,
    ]);
    expect(page2Body.hasMore).toBe(true);
    expect(page2Body.nextCursor).toBeDefined();

    // Page 3: limit 2 using page 2's nextCursor
    const page3Event = createHttpEvent({
      userId: userAlice,
      roomId,
      queryStringParameters: { limit: '2', cursor: page2Body.nextCursor },
    });
    const page3Res = (await messagesHandler(page3Event, mockContext, mockCallback)) as HttpResponse;
    expect(page3Res.statusCode).toBe(200);
    const page3Body = JSON.parse(page3Res.body);

    expect(page3Body.items.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual([1]);
    expect(page3Body.hasMore).toBe(false);
  });

  it('supports catch-up recovery mode (?after=N) returning messages ascending', async () => {
    // Catch-up sync after sequence 2 -> should return messages 3, 4, 5 in ascending order
    const event = createHttpEvent({
      userId: userAlice,
      roomId,
      queryStringParameters: { after: '2' },
    });
    const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.items.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual([3, 4, 5]);
    expect(body.hasMore).toBe(false);
  });

  it('returns empty items when catch-up sequence is up-to-date', async () => {
    const event = createHttpEvent({
      userId: userAlice,
      roomId,
      queryStringParameters: { after: '5' },
    });
    const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.items).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it('returns all messages ascending when after=0', async () => {
    const event = createHttpEvent({
      userId: userAlice,
      roomId,
      queryStringParameters: { after: '0' },
    });
    const res = (await messagesHandler(event, mockContext, mockCallback)) as HttpResponse;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.items.map((m: { sequenceNumber: number }) => m.sequenceNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });
});
