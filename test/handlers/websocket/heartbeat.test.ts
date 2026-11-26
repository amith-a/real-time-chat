import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../../src/handlers/websocket/heartbeat';
import * as repositories from '../../../src/repositories';
import { HEARTBEAT_INTERVAL_MS, WEBSOCKET_IDLE_TIMEOUT_MS } from '../../../src/shared';

const mockContext = {} as Context;
const mockCallback = () => {};

function makeEvent(body?: string): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
      routeKey: 'heartbeat',
      messageId: 'msg-hb-1',
      eventType: 'MESSAGE',
      extendedRequestId: 'ext-1',
      requestTime: '2026-11-26T00:00:00Z',
      messageDirection: 'IN',
      stage: 'dev',
      connectedAt: 1700000000,
      requestTimeEpoch: 1700000000,
      requestId: 'req-hb-1',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      connectionId: 'conn-alice-1',
      apiId: 'api-1',
    } as unknown as APIGatewayProxyWebsocketEventV2['requestContext'],
    body,
  };
}

describe('WebSocket heartbeat handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps HEARTBEAT_INTERVAL_MS strictly below WEBSOCKET_IDLE_TIMEOUT_MS', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(WEBSOCKET_IDLE_TIMEOUT_MS);
  });

  it('resolves userId via getConnectionOwner, updates lastHeartbeat, and returns status=ok', async () => {
    const ownerSpy = vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    const updateSpy = vi.spyOn(repositories, 'updateHeartbeat').mockResolvedValue(true);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'heartbeat' })),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(ownerSpy).toHaveBeenCalledWith('conn-alice-1');
    expect(updateSpy).toHaveBeenCalledWith('alice', 'conn-alice-1', expect.any(String));

    const body = JSON.parse(res.body);
    expect(body).toEqual({
      action: 'heartbeatAck',
      status: 'ok',
      timestamp: expect.any(String),
      nextHeartbeatMs: HEARTBEAT_INTERVAL_MS,
    });
  });

  it('returns status=reconnect when connection owner cannot be resolved', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue(undefined);
    const updateSpy = vi.spyOn(repositories, 'updateHeartbeat');

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'heartbeat' })),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(updateSpy).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.action).toBe('heartbeatAck');
    expect(body.status).toBe('reconnect');
  });

  it('returns status=reconnect when connection was already swept', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockResolvedValue('alice');
    vi.spyOn(repositories, 'updateHeartbeat').mockResolvedValue(false);

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'heartbeat' })),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.action).toBe('heartbeatAck');
    expect(body.status).toBe('reconnect');
  });

  it('returns 400 for invalid action payload', async () => {
    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'invalid' })),
      mockContext,
      mockCallback,
    )) as { statusCode: number };

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for malformed JSON payload', async () => {
    const res = (await handler(makeEvent('{invalid-json'), mockContext, mockCallback)) as {
      statusCode: number;
      body: string;
    };

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      message: expect.stringContaining('Invalid JSON'),
    });
  });

  it('returns 500 when an unexpected repository error occurs', async () => {
    vi.spyOn(repositories, 'getConnectionOwner').mockRejectedValue(
      new Error('DynamoDB unavailable'),
    );

    const res = (await handler(
      makeEvent(JSON.stringify({ action: 'heartbeat' })),
      mockContext,
      mockCallback,
    )) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      message: 'Internal server error',
    });
  });
});
