import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as defaultHandler } from '../../../src/handlers/websocket/default';
import {
  createInvalidConnectionEvent,
  createMockEvent,
  type ExpectedResponse,
  mockCallback,
  mockContext,
} from './helpers';

describe('Default Handler ($default)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

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
