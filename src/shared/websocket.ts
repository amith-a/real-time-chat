import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { BadRequestError, UnauthorizedError } from './errors';

export interface AuthorizerContext {
  userId?: string;
  email?: string;
  username?: string;
  [key: string]: unknown;
}

export interface AuthenticatedUser {
  userId: string;
  email?: string;
  username?: string;
}

export interface WebSocketContext {
  connectionId: string;
  domainName: string;
  stage: string;
}

/**
 * Extracts and validates the authenticated user from the WebSocket authorizer context.
 * Throws UnauthorizedError if authorizer context or userId is missing.
 */
export function getAuthenticatedUser(event: APIGatewayProxyWebsocketEventV2): AuthenticatedUser {
  const authorizer = (
    event.requestContext as {
      authorizer?: {
        userId?: string;
        principalId?: string;
        email?: string;
        username?: string;
        [key: string]: unknown;
      };
    }
  )?.authorizer;

  const userId = authorizer?.userId || authorizer?.principalId;

  if (typeof userId !== 'string' || !userId.trim()) {
    throw new UnauthorizedError('Missing authenticated userId');
  }

  return {
    userId: userId.trim(),
    email: typeof authorizer?.email === 'string' ? authorizer.email.trim() : undefined,
    username: typeof authorizer?.username === 'string' ? authorizer.username.trim() : undefined,
  };
}

/**
 * Safely extracts authorizer user information if present, without throwing.
 * Useful for routes where authorizer context is optional or best-effort (e.g. $disconnect).
 */
export function getAuthorizerUser(
  event: APIGatewayProxyWebsocketEventV2,
): Partial<AuthenticatedUser> | undefined {
  const authorizer = (
    event.requestContext as {
      authorizer?: {
        userId?: string;
        principalId?: string;
        email?: string;
        username?: string;
        [key: string]: unknown;
      };
    }
  )?.authorizer;

  if (!authorizer) {
    return undefined;
  }

  const userId = authorizer.userId || authorizer.principalId;

  return {
    userId: typeof userId === 'string' ? userId.trim() : undefined,
    email: typeof authorizer.email === 'string' ? authorizer.email.trim() : undefined,
    username: typeof authorizer.username === 'string' ? authorizer.username.trim() : undefined,
  };
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
