import type { APIGatewayProxyWebsocketEventV2, Context } from 'aws-lambda';

export const mockContext = {} as Context;
export const mockCallback = () => {};

export interface ExpectedResponse {
  statusCode: number;
  body: string;
}

export function createMockEvent(
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

export function createInvalidConnectionEvent(routeKey: string): APIGatewayProxyWebsocketEventV2 {
  const event = createMockEvent({ routeKey });

  return {
    ...event,
    requestContext: {
      ...event.requestContext,
      connectionId: undefined,
    },
  } as unknown as APIGatewayProxyWebsocketEventV2;
}
