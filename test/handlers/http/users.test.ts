import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as usersHandler } from '../../../src/handlers/http/users';
import * as repositories from '../../../src/repositories';
import type { HttpResponse } from '../../../src/shared';

const mockContext = {} as Context;
const mockCallback = () => {};

function createHttpEvent(
  overrides: {
    method?: string;
    rawPath?: string;
    userId?: string;
    pathParameters?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    claims?: Record<string, unknown>;
  } = {},
): APIGatewayProxyEventV2 {
  const method = overrides.method || 'GET';
  const rawPath = overrides.rawPath || '/users';
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
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString: '',
    headers: {
      authorization: 'Bearer token',
    },
    queryStringParameters: overrides.queryStringParameters,
    pathParameters: overrides.pathParameters,
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
      requestId: 'req-http-1',
      routeKey: `${method} ${rawPath}`,
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

describe('Users HTTP Handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CORS and Method Handling', () => {
    it('handles OPTIONS preflight request', async () => {
      const event = createHttpEvent({ method: 'OPTIONS' });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res.headers['Access-Control-Allow-Methods']).toContain('GET');
    });

    it('returns 404 for unsupported HTTP methods', async () => {
      const event = createHttpEvent({ method: 'POST', rawPath: '/users' });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toContain('Method POST not allowed');
    });

    it('returns 401 when JWT authorizer claims are missing sub', async () => {
      const event = createHttpEvent({ claims: {} });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).message).toContain(
        'Missing or invalid authenticated user identity: sub claim is required',
      );
    });

    it('returns 401 when claims contain username but are missing required sub claim', async () => {
      const event = createHttpEvent({ claims: { username: 'unauthorized-user' } });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).message).toContain(
        'Missing or invalid authenticated user identity: sub claim is required',
      );
    });
  });

  describe('GET /users/me', () => {
    it('returns sanitized user profile if it exists', async () => {
      const mockProfile: repositories.UserProfileItem = {
        PK: 'USER#user-1',
        SK: 'PROFILE',
        userId: 'user-1',
        email: 'user1@example.com',
        username: 'user1',
        displayName: 'User One',
        createdAt: '2026-11-20T00:00:00Z',
      };
      vi.spyOn(repositories, 'getUserProfile').mockResolvedValue(mockProfile);

      const event = createHttpEvent({ rawPath: '/users/me', userId: 'user-1' });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        userId: 'user-1',
        email: 'user1@example.com',
        username: 'user1',
        displayName: 'User One',
        createdAt: '2026-11-20T00:00:00Z',
      });
      expect(body).not.toHaveProperty('PK');
      expect(body).not.toHaveProperty('SK');
    });

    it('returns fallback identity claims if profile is not yet in database', async () => {
      vi.spyOn(repositories, 'getUserProfile').mockResolvedValue(undefined);

      const event = createHttpEvent({
        rawPath: '/users/me',
        userId: 'user-new',
        claims: {
          sub: 'user-new',
          email: 'new@example.com',
          'cognito:username': 'newuser',
        },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        userId: 'user-new',
        email: 'new@example.com',
        username: 'newuser',
      });
    });
  });

  describe('GET /users/{userId}', () => {
    it('returns public user DTO when found (omitting email and DynamoDB keys)', async () => {
      const mockProfile: repositories.UserProfileItem = {
        PK: 'USER#bob-123',
        SK: 'PROFILE',
        GSI1PK: 'USERS',
        GSI1SK: 'EMAIL#bob@example.com',
        userId: 'bob-123',
        email: 'bob@example.com',
        username: 'bob',
        displayName: 'Bob Builder',
        avatarUrl: 'https://example.com/bob.png',
        createdAt: '2026-11-20T00:00:00Z',
      };
      vi.spyOn(repositories, 'getUserProfile').mockResolvedValue(mockProfile);

      const event = createHttpEvent({
        rawPath: '/users/bob-123',
        pathParameters: { userId: 'bob-123' },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        userId: 'bob-123',
        username: 'bob',
        displayName: 'Bob Builder',
        avatarUrl: 'https://example.com/bob.png',
      });
      expect(body).not.toHaveProperty('email');
      expect(body).not.toHaveProperty('PK');
      expect(body).not.toHaveProperty('SK');
      expect(body).not.toHaveProperty('GSI1PK');
      expect(body).not.toHaveProperty('GSI1SK');
    });

    it('returns 404 when user is not found', async () => {
      vi.spyOn(repositories, 'getUserProfile').mockResolvedValue(undefined);

      const event = createHttpEvent({
        rawPath: '/users/unknown',
        pathParameters: { userId: 'unknown' },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toContain('User unknown not found');
    });
  });

  describe('GET /users (Directory & Search)', () => {
    it('lists users returning public DTOs when no query is specified', async () => {
      const mockUsers: repositories.UserProfileItem[] = [
        {
          PK: 'USER#1',
          SK: 'PROFILE',
          userId: '1',
          username: 'alice',
          displayName: 'Alice',
          email: 'alice@example.com',
          createdAt: '',
        },
        {
          PK: 'USER#2',
          SK: 'PROFILE',
          userId: '2',
          username: 'bob',
          displayName: 'Bob',
          email: 'bob@example.com',
          createdAt: '',
        },
      ];
      const listSpy = vi.spyOn(repositories, 'listUsers').mockResolvedValue({
        items: mockUsers,
        nextKey: { PK: 'USER#2', GSI1PK: 'USERS' },
      });

      const event = createHttpEvent({
        rawPath: '/users',
        queryStringParameters: { limit: '10' },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.items).toHaveLength(2);
      expect(data.items[0]).toEqual({
        userId: '1',
        username: 'alice',
        displayName: 'Alice',
      });
      expect(data.items[0]).not.toHaveProperty('email');
      expect(data.items[0]).not.toHaveProperty('PK');
      expect(data.items[1]).toEqual({
        userId: '2',
        username: 'bob',
        displayName: 'Bob',
      });
      expect(data.items[1]).not.toHaveProperty('email');
      expect(data.hasMore).toBe(true);
      expect(data.nextCursor).toBeDefined();

      expect(listSpy).toHaveBeenCalledWith({
        limit: 10,
        startKey: undefined,
      });
    });

    it('searches users by query prefix returning public DTOs without email leak', async () => {
      const searchSpy = vi.spyOn(repositories, 'searchUsers').mockResolvedValue({
        items: [
          {
            PK: 'USER#1',
            SK: 'PROFILE',
            userId: '1',
            username: 'alice',
            displayName: 'Alice In Wonderland',
            email: 'alice@example.com',
            createdAt: '',
          },
        ],
        nextKey: undefined,
      });

      const event = createHttpEvent({
        rawPath: '/users',
        queryStringParameters: { query: 'ali' },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.items).toHaveLength(1);
      expect(data.items[0]).toEqual({
        userId: '1',
        username: 'alice',
        displayName: 'Alice In Wonderland',
      });
      expect(data.items[0]).not.toHaveProperty('email');
      expect(data.hasMore).toBe(false);
      expect(data.nextCursor).toBeUndefined();

      expect(searchSpy).toHaveBeenCalledWith('ali', {
        limit: 20,
        startKey: undefined,
      });
    });

    it('decodes valid base64 pagination cursor properly', async () => {
      const listSpy = vi.spyOn(repositories, 'listUsers').mockResolvedValue({
        items: [],
        nextKey: undefined,
      });

      const rawKey = { PK: 'USER#xyz', GSI1PK: 'USERS' };
      const cursor = Buffer.from(JSON.stringify(rawKey)).toString('base64');

      const event = createHttpEvent({
        rawPath: '/users',
        queryStringParameters: { cursor },
      });
      await usersHandler(event, mockContext, mockCallback);

      expect(listSpy).toHaveBeenCalledWith({
        limit: 20,
        startKey: rawKey,
      });
    });

    it('returns 400 when cursor is not valid base64', async () => {
      const event = createHttpEvent({
        rawPath: '/users',
        queryStringParameters: { cursor: 'invalid!base64===' },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('Invalid pagination cursor: not valid base64');
    });

    it('returns 400 when cursor base64 decodes to invalid JSON', async () => {
      const invalidJsonCursor = Buffer.from('not-json').toString('base64');
      const event = createHttpEvent({
        rawPath: '/users',
        queryStringParameters: { cursor: invalidJsonCursor },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain(
        'Invalid pagination cursor: malformed JSON payload',
      );
    });

    it('returns 400 when cursor is missing required DynamoDB key attributes', async () => {
      const emptyKeyCursor = Buffer.from(JSON.stringify({})).toString('base64');
      const event = createHttpEvent({
        rawPath: '/users',
        queryStringParameters: { cursor: emptyKeyCursor },
      });
      const res = (await usersHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain(
        'Invalid pagination cursor: key object cannot be empty',
      );

      const invalidKeyCursor = Buffer.from(JSON.stringify({ someAttr: 'val' })).toString('base64');
      const event2 = createHttpEvent({
        rawPath: '/users',
        queryStringParameters: { cursor: invalidKeyCursor },
      });
      const res2 = (await usersHandler(event2, mockContext, mockCallback)) as HttpResponse;

      expect(res2.statusCode).toBe(400);
      expect(JSON.parse(res2.body).message).toContain(
        'Invalid pagination cursor: missing required DynamoDB key attributes',
      );
    });
  });
});
