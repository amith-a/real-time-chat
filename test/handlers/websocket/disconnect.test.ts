import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as disconnectHandler } from '../../../src/handlers/websocket/disconnect';
import * as repos from '../../../src/repositories';
import {
  createInvalidConnectionEvent,
  createMockEvent,
  type ExpectedResponse,
  mockCallback,
  mockContext,
} from './helpers';

describe('Disconnect Handler ($disconnect)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns 200 with Disconnected body for valid disconnection (TABLE_NAME unset)', async () => {
    delete process.env.TABLE_NAME;
    const event = createMockEvent({
      connectionId: 'conn-abc',
      routeKey: '$disconnect',
    });
    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

    expect(result).toEqual({
      statusCode: 200,
      body: 'Disconnected',
    });
  });

  it('returns 400 when connection context is invalid', async () => {
    const event = createInvalidConnectionEvent('$disconnect');
    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

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
    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

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

    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

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

    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

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

    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

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
    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

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
    const result = (await disconnectHandler(event, mockContext, mockCallback)) as ExpectedResponse;

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('Disconnected');
  });
});
