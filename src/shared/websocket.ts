import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { BadRequestError } from './errors';

export interface AuthorizerContext {
  userId?: string;
  email?: string;
  username?: string;
  [key: string]: unknown;
}

export interface WebSocketContext {
  connectionId: string;
  domainName: string;
  stage: string;
}

export function getWebSocketContext(event: APIGatewayProxyWebsocketEventV2): WebSocketContext {
  const { connectionId, domainName, stage } = event.requestContext || {};

  if (!connectionId || !domainName || !stage) {
    throw new BadRequestError('Missing WebSocket connection context');
  }

  return {
    connectionId,
    domainName,
    stage,
  };
}

/**
 * Extracts connectionId from WebSocket event.
 */
export function getConnectionId(event: APIGatewayProxyWebsocketEventV2): string {
  const { connectionId } = getWebSocketContext(event);
  return connectionId;
}

/**
 * Extracts route key from WebSocket event.
 */
export function getRouteKey(event: APIGatewayProxyWebsocketEventV2): string {
  return event.requestContext?.routeKey || '$default';
}

/**
 * Safely parses JSON body from WebSocket message event.
 */
export function parseJsonBody<T>(event: APIGatewayProxyWebsocketEventV2): T {
  if (!event.body) {
    throw new BadRequestError('Missing request body');
  }

  try {
    return JSON.parse(event.body) as T;
  } catch {
    throw new BadRequestError('Invalid JSON in request body');
  }
}
