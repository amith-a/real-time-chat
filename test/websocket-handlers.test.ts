import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as connectHandler } from '../src/handlers/websocket/connect';
import { handler as defaultHandler } from '../src/handlers/websocket/default';
import { handler as disconnectHandler } from '../src/handlers/websocket/disconnect';
import * as repos from '../src/repositories';
import { ForbiddenError } from '../src/shared';

const mockContext = {} as Context;
const mockCallback = () => {};

interface ExpectedResponse {
  statusCode: number;
  body: string;
}

function createMockEvent(
  overrides: {
    connectionId?: string;
    domainName?: string;
    stage?: string;
    routeKey?: string;
    body?: string;
    authorizer?: { userId?: string; email?: string; username?: string };
  } = {},
): APIGatewayProxyWebsocketEventV2 {
  const requestContext = {
    routeKey: overrides.routeKey || '$connect',
    messageId: 'msg-123',
    eventType: 'CONNECT',
    extendedRequestId: 'ext-123',
    requestTime: '2026-11-22T00:00:00Z',
    messageDirection: 'IN',
    stage: overrides.stage || 'dev',
    connectedAt: 1700000000,
    requestTimeEpoch: 1700000000,
    requestId: 'req-123',
    domainName: overrides.domainName || 'api.example.com',
    connectionId: overrides.connectionId || 'test-conn-id',
    apiId: 'test-api-id',
    authorizer:
      overrides.authorizer !== undefined
        ? overrides.authorizer
        : {
            userId: 'user-123',
            email: 'user@example.com',
          },
  };

  return {
    isBase64Encoded: false,
    requestContext: requestContext as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body: overrides.body,
  };
}

function createInvalidConnectionEvent(routeKey: string): APIGatewayProxyWebsocketEventV2 {
  const event = createMockEvent({ routeKey });

  return {
    ...event,
    requestContext: {
      ...event.requestContext,
      connectionId: undefined,
    },
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

describe('WebSocket Route Handlers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Connect Handler ($connect)', () => {
    it('returns 200 with Connected body for valid connection (TABLE_NAME unset)', async () => {
      delete process.env.TABLE_NAME;
      const event = createMockEvent({ connectionId: 'conn-abc' });
      const result = (await connectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result).toEqual({
        statusCode: 200,
        body: 'Connected',
      });
    });

    it('returns 400 when connection context is invalid', async () => {
      const event = createInvalidConnectionEvent('$connect');
      const result = (await connectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Missing WebSocket connection context',
      });
    });

    it('returns 401 when authorizer userId is missing', async () => {
      const event = createMockEvent({ connectionId: 'conn-abc', authorizer: {} });
      const result = (await connectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Missing authenticated userId',
      });
    });

    it('registers connection and returns 200 when TABLE_NAME is set', async () => {
      process.env.TABLE_NAME = 'mock-table';
      const registerSpy = vi
        .spyOn(repos, 'registerConnection')
        .mockResolvedValueOnce({ registered: true });

      const event = createMockEvent({
        connectionId: 'conn-xyz',
        authorizer: { userId: 'u-1', email: 'u1@example.com' },
      });
      const result = (await connectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result).toEqual({
        statusCode: 200,
        body: 'Connected',
      });
      expect(registerSpy).toHaveBeenCalledWith({
        userId: 'u-1',
        connectionId: 'conn-xyz',
        now: expect.any(String),
      });
    });

    it('returns 200 when duplicate connection is received from same user', async () => {
      process.env.TABLE_NAME = 'mock-table';
      vi.spyOn(repos, 'registerConnection').mockResolvedValueOnce({ registered: false });

      const event = createMockEvent({
        connectionId: 'conn-dup',
        authorizer: { userId: 'u-1', email: 'u1@example.com' },
      });
      const result = (await connectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result).toEqual({
        statusCode: 200,
        body: 'Connected',
      });
    });

    it('returns 403 when registerConnection throws ForbiddenError (connection owned by another user)', async () => {
      process.env.TABLE_NAME = 'mock-table';
      vi.spyOn(repos, 'registerConnection').mockRejectedValueOnce(
        new ForbiddenError('Connection is registered to a different user'),
      );

      const event = createMockEvent({ connectionId: 'conn-stolen' });
      const result = (await connectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Connection is registered to a different user',
      });
    });

    it('returns 500 when registerConnection throws an unexpected database error', async () => {
      process.env.TABLE_NAME = 'mock-table';
      vi.spyOn(repos, 'registerConnection').mockRejectedValueOnce(
        new Error('Unexpected DynamoDB failure'),
      );

      const event = createMockEvent({ connectionId: 'conn-err' });
      const result = (await connectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Internal server error',
      });
    });
  });

  describe('Disconnect Handler ($disconnect)', () => {
    it('returns 200 with Disconnected body for valid disconnection (TABLE_NAME unset)', async () => {
      delete process.env.TABLE_NAME;
      const event = createMockEvent({
        connectionId: 'conn-abc',
        routeKey: '$disconnect',
      });
      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result).toEqual({
        statusCode: 200,
        body: 'Disconnected',
      });
    });

    it('returns 400 when connection context is invalid', async () => {
      const event = createInvalidConnectionEvent('$disconnect');
      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Missing WebSocket connection context',
      });
    });

    it('removes connection using authorizer userId when present and TABLE_NAME is set', async () => {
      process.env.TABLE_NAME = 'mock-table';
      const removeSpy = vi.spyOn(repos, 'removeConnection').mockResolvedValueOnce('REMOVED');
      const getOwnerSpy = vi.spyOn(repos, 'getConnectionOwner');

      const event = createMockEvent({
        connectionId: 'conn-auth',
        routeKey: '$disconnect',
        authorizer: { userId: 'u-auth-1' },
      });
      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(removeSpy).toHaveBeenCalledWith({
        userId: 'u-auth-1',
        connectionId: 'conn-auth',
      });
      expect(getOwnerSpy).not.toHaveBeenCalled();
    });

    it('resolves connection owner via repository when authorizer context is absent', async () => {
      process.env.TABLE_NAME = 'mock-table';
      const getOwnerSpy = vi
        .spyOn(repos, 'getConnectionOwner')
        .mockResolvedValueOnce('resolved-user-99');
      const removeSpy = vi.spyOn(repos, 'removeConnection').mockResolvedValueOnce('REMOVED');

      // Standard API Gateway $disconnect event: NO authorizer context!
      const event = createMockEvent({
        connectionId: 'conn-no-auth',
        routeKey: '$disconnect',
      });
      (event.requestContext as { authorizer?: Record<string, unknown> }).authorizer = undefined;

      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(getOwnerSpy).toHaveBeenCalledWith('conn-no-auth');
      expect(removeSpy).toHaveBeenCalledWith({
        userId: 'resolved-user-99',
        connectionId: 'conn-no-auth',
      });
    });

    it('returns 200 gracefully when connection owner cannot be resolved', async () => {
      process.env.TABLE_NAME = 'mock-table';
      vi.spyOn(repos, 'getConnectionOwner').mockResolvedValueOnce(undefined);
      const removeSpy = vi.spyOn(repos, 'removeConnection');

      const event = createMockEvent({
        connectionId: 'conn-unknown',
        routeKey: '$disconnect',
      });
      (event.requestContext as { authorizer?: Record<string, unknown> }).authorizer = undefined;

      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(removeSpy).not.toHaveBeenCalled();
    });

    it('returns 200 gracefully and delegates to sweeper when removeConnection throws error', async () => {
      process.env.TABLE_NAME = 'mock-table';
      vi.spyOn(repos, 'getConnectionOwner').mockResolvedValueOnce('user-fail');
      vi.spyOn(repos, 'removeConnection').mockRejectedValueOnce(
        new Error('DynamoDB TransactionConflict'),
      );

      const event = createMockEvent({
        connectionId: 'conn-fail',
        routeKey: '$disconnect',
      });
      (event.requestContext as { authorizer?: Record<string, unknown> }).authorizer = undefined;

      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Disconnected');
    });

    it('returns 200 when authorizer user does not own the connection (safe handling)', async () => {
      process.env.TABLE_NAME = 'mock-table';
      vi.spyOn(repos, 'removeConnection').mockResolvedValueOnce('NOT_FOUND_OR_CHANGED');

      const event = createMockEvent({
        connectionId: 'conn-other',
        routeKey: '$disconnect',
        authorizer: { userId: 'imposter-user', email: 'imposter@example.com' },
      });
      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Disconnected');
    });

    it('returns 200 gracefully when authorizer is present but removeConnection throws database error', async () => {
      process.env.TABLE_NAME = 'mock-table';
      vi.spyOn(repos, 'removeConnection').mockRejectedValueOnce(
        new Error('DynamoDB cleanup failure'),
      );

      const event = createMockEvent({
        connectionId: 'conn-auth-fail',
        routeKey: '$disconnect',
        authorizer: { userId: 'user-auth-fail', email: 'fail@example.com' },
      });
      const result = (await disconnectHandler(
        event,
        mockContext,
        mockCallback,
      )) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(result.body).toBe('Disconnected');
    });
  });

  describe('Default Handler ($default)', () => {
    it('returns 200 with Unknown action for unrecognized messages', async () => {
      const event = createMockEvent({
        connectionId: 'conn-abc',
        routeKey: '$default',
        body: JSON.stringify({ action: 'nonExistentAction' }),
      });
      const result = (await defaultHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Unknown action',
      });
    });

    it('returns 400 when connection context is invalid', async () => {
      const event = createInvalidConnectionEvent('$default');
      const result = (await defaultHandler(event, mockContext, mockCallback)) as ExpectedResponse;

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        message: 'Missing WebSocket connection context',
      });
    });
  });
});
