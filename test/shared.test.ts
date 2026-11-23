import { describe, expect, it } from 'vitest';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  formatResponse,
  getAuthenticatedUser,
  getAuthorizerUser,
  getConnectionId,
  getRouteKey,
  getWebSocketContext,
  isAppError,
  NotFoundError,
  parseJsonBody,
  sanitize,
  UnauthorizedError,
} from '../src/shared';

describe('Shared Utilities', () => {
  describe('Errors', () => {
    it('creates AppError with correct defaults', () => {
      const err = new AppError('Something failed');
      expect(err.message).toBe('Something failed');
      expect(err.statusCode).toBe(500);
      expect(err.isOperational).toBe(true);
      expect(isAppError(err)).toBe(true);
    });

    it('creates specific error subclasses with expected status codes', () => {
      expect(new BadRequestError().statusCode).toBe(400);
      expect(new UnauthorizedError().statusCode).toBe(401);
      expect(new ForbiddenError().statusCode).toBe(403);
      expect(new NotFoundError().statusCode).toBe(404);
    });
  });

  describe('Sanitization (Security Logging)', () => {
    it('redacts sensitive token keys in objects', () => {
      const input = {
        userId: 'user-123',
        token: 'secret-jwt-token',
        idToken: 'secret-id-token',
        password: 'my-password',
        authorization: 'Bearer secret',
        nested: {
          secret: 'nested-secret',
          safeField: 'visible',
        },
      };

      const sanitized = sanitize(input) as Record<string, unknown>;

      expect(sanitized.userId).toBe('user-123');
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.idToken).toBe('[REDACTED]');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.authorization).toBe('[REDACTED]');
      expect((sanitized.nested as Record<string, unknown>).secret).toBe('[REDACTED]');
      expect((sanitized.nested as Record<string, unknown>).safeField).toBe('visible');
    });

    it('redacts tokens from URLs', () => {
      const url = 'wss://api.example.com/dev?token=eyJhbGciOiJIUzI1NiJ9.abc&stage=dev';
      const sanitized = sanitize(url);
      expect(sanitized).toBe('wss://api.example.com/dev?token=[REDACTED]&stage=dev');
    });
  });

  describe('Response Formatter', () => {
    it('formats plain text responses', () => {
      const res = formatResponse(200, 'Connected');
      expect(res).toEqual({
        statusCode: 200,
        body: 'Connected',
      });
    });

    it('stringifies object responses', () => {
      const res = formatResponse(400, { error: 'Unknown' });
      expect(res).toEqual({
        statusCode: 400,
        body: JSON.stringify({ error: 'Unknown' }),
      });
    });
  });

  describe('WebSocket Event Helpers', () => {
    it('extracts connectionId and routeKey', () => {
      const event = {
        requestContext: {
          connectionId: 'conn-123',
          domainName: 'api.example.com',
          stage: 'dev',
          routeKey: '$connect',
        },
      } as unknown as Parameters<typeof getWebSocketContext>[0];

      expect(getWebSocketContext(event)).toEqual({
        connectionId: 'conn-123',
        domainName: 'api.example.com',
        stage: 'dev',
      });
      expect(getConnectionId(event)).toBe('conn-123');
      expect(getRouteKey(event)).toBe('$connect');
    });

    it('throws BadRequestError when connectionId is missing', () => {
      const event = { requestContext: {} } as unknown as Parameters<typeof getWebSocketContext>[0];
      expect(() => getWebSocketContext(event)).toThrow(BadRequestError);
      expect(() => getConnectionId(event)).toThrow(BadRequestError);
    });

    it('parses valid JSON body', () => {
      const event = {
        body: JSON.stringify({ action: 'ping', data: 42 }),
      } as unknown as Parameters<typeof parseJsonBody>[0];

      expect(parseJsonBody<{ action: string }>(event)).toEqual({
        action: 'ping',
        data: 42,
      });
    });

    it('throws BadRequestError on malformed JSON body', () => {
      const event = { body: 'not-json' } as unknown as Parameters<typeof parseJsonBody>[0];
      expect(() => parseJsonBody(event)).toThrow(BadRequestError);
    });

    it('extracts authenticated user from authorizer context', () => {
      const event = {
        requestContext: {
          authorizer: {
            userId: 'user-456',
            email: 'user@example.com',
            username: 'testuser',
          },
        },
      } as unknown as Parameters<typeof getAuthenticatedUser>[0];

      expect(getAuthenticatedUser(event)).toEqual({
        userId: 'user-456',
        email: 'user@example.com',
        username: 'testuser',
      });
    });

    it('falls back to principalId if userId is omitted', () => {
      const event = {
        requestContext: {
          authorizer: {
            principalId: 'principal-789',
            email: 'admin@example.com',
          },
        },
      } as unknown as Parameters<typeof getAuthenticatedUser>[0];

      expect(getAuthenticatedUser(event)).toEqual({
        userId: 'principal-789',
        email: 'admin@example.com',
        username: undefined,
      });
    });

    it('throws UnauthorizedError when authorizer or userId is missing', () => {
      const eventNoAuth = { requestContext: {} } as unknown as Parameters<
        typeof getAuthenticatedUser
      >[0];
      expect(() => getAuthenticatedUser(eventNoAuth)).toThrow(UnauthorizedError);

      const eventEmptyUser = {
        requestContext: { authorizer: { userId: '  ' } },
      } as unknown as Parameters<typeof getAuthenticatedUser>[0];
      expect(() => getAuthenticatedUser(eventEmptyUser)).toThrow(UnauthorizedError);
    });

    it('safely extracts authorizer user without throwing via getAuthorizerUser', () => {
      const eventNoAuth = { requestContext: {} } as unknown as Parameters<
        typeof getAuthorizerUser
      >[0];
      expect(getAuthorizerUser(eventNoAuth)).toBeUndefined();

      const eventWithAuth = {
        requestContext: { authorizer: { userId: 'u1', email: 'u1@example.com' } },
      } as unknown as Parameters<typeof getAuthorizerUser>[0];
      expect(getAuthorizerUser(eventWithAuth)).toEqual({
        userId: 'u1',
        email: 'u1@example.com',
        username: undefined,
      });
    });
  });
});
