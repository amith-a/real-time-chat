import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handler as connectHandler } from '../src/handlers/websocket/connect';
import { handler as defaultHandler } from '../src/handlers/websocket/default';
import { handler as disconnectHandler } from '../src/handlers/websocket/disconnect';

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
  } = {},
): APIGatewayProxyWebsocketEventV2 {
  return {
    isBase64Encoded: false,
    requestContext: {
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
    },
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
  describe('Connect Handler ($connect)', () => {
    it('returns 200 with Connected body for valid connection', async () => {
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
  });

  describe('Disconnect Handler ($disconnect)', () => {
    it('returns 200 with Disconnected body for valid disconnection', async () => {
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
