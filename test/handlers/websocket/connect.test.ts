import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as connectHandler } from '../../../src/handlers/websocket/connect';
import * as repos from '../../../src/repositories';
import { ForbiddenError } from '../../../src/shared';
import {
  createInvalidConnectionEvent,
  createMockEvent,
  type ExpectedResponse,
  mockCallback,
  mockContext,
} from './helpers';

describe('Connect Handler ($connect)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.spyOn(repos, 'ensureUserProfile').mockResolvedValue({
      PK: 'USER#u-1',
      SK: 'PROFILE',
      userId: 'u-1',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

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
    const ensureSpy = vi.spyOn(repos, 'ensureUserProfile').mockResolvedValueOnce({
      PK: 'USER#u-1',
      SK: 'PROFILE',
      userId: 'u-1',
    });
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
    expect(ensureSpy).toHaveBeenCalledWith({
      userId: 'u-1',
      email: 'u1@example.com',
      username: undefined,
      now: expect.any(String),
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
