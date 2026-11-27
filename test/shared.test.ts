import { afterEach, describe, expect, it, vi } from 'vitest';
import * as repositories from '../src/repositories';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  formatResponse,
  getAuthenticatedUser,
  getAuthorizerUser,
  getConnectionId,
  getManagementApiClient,
  getRouteKey,
  getWebSocketContext,
  isAppError,
  NotFoundError,
  parseJsonBody,
  postToConnection,
  resetManagementApiClients,
  sanitize,
  sendMessageSchema,
  setManagementApiClient,
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

  describe('Schemas', () => {
    describe('sendMessageSchema - Valid Payloads', () => {
      it('validates a minimal direct 1:1 message payload and defaults messageType to TEXT', () => {
        const parsed = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'user-456',
          body: 'Hello',
        });

        expect(parsed.action).toBe('sendMessage');
        expect(parsed.messageId).toBe('msg-1');
        expect(parsed.recipientUserId).toBe('user-456');
        expect(parsed.roomId).toBeUndefined();
        expect(parsed.body).toBe('Hello');
        expect(parsed.messageType).toBe('TEXT');
      });

      it('validates direct message with explicit messageType (IMAGE and FILE)', () => {
        const imageMsg = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: 'msg-img',
          recipientUserId: 'user-456',
          body: 'https://example.com/img.png',
          messageType: 'IMAGE',
        });
        expect(imageMsg.messageType).toBe('IMAGE');

        const fileMsg = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: 'msg-file',
          recipientUserId: 'user-456',
          body: 'https://example.com/doc.pdf',
          messageType: 'FILE',
        });
        expect(fileMsg.messageType).toBe('FILE');
      });

      it('validates a minimal existing-room message payload', () => {
        const parsed = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: 'msg-2',
          roomId: 'room-123',
          body: 'Hello room',
        });

        expect(parsed.action).toBe('sendMessage');
        expect(parsed.messageId).toBe('msg-2');
        expect(parsed.roomId).toBe('room-123');
        expect(parsed.recipientUserId).toBeUndefined();
        expect(parsed.body).toBe('Hello room');
        expect(parsed.messageType).toBe('TEXT');
      });

      it('validates existing-room message with explicit messageType TEXT', () => {
        const parsed = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: 'msg-room-text',
          roomId: 'room-123',
          body: 'Explicit text message',
          messageType: 'TEXT',
        });

        expect(parsed.messageType).toBe('TEXT');
      });
    });

    describe('sendMessageSchema - Missing Fields & Action Validation', () => {
      it('rejects when action is missing or incorrect', () => {
        const missingAction = sendMessageSchema.safeParse({
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(missingAction.success).toBe(false);

        const invalidAction = sendMessageSchema.safeParse({
          action: 'otherAction',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(invalidAction.success).toBe(false);
      });

      it('rejects when messageId is missing', () => {
        const result = sendMessageSchema.safeParse({
          action: 'sendMessage',
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((i) => i.path.includes('messageId'))).toBe(true);
        }
      });

      it('rejects when body is missing', () => {
        const result = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((i) => i.path.includes('body'))).toBe(true);
        }
      });

      it('rejects when neither recipientUserId nor roomId is provided', () => {
        const result = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-4',
          body: 'Hello',
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe(
            'Either recipientUserId or roomId must be provided',
          );
        }
      });

      it('rejects when both recipientUserId and roomId are provided', () => {
        const result = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-3',
          recipientUserId: 'bob',
          roomId: 'room-1',
          body: 'Hello',
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe(
            'Cannot provide both recipientUserId and roomId in the same request',
          );
        }
      });
    });

    describe('sendMessageSchema - Message Types', () => {
      it('rejects unsupported message types', () => {
        for (const invalidType of ['VIDEO', 'AUDIO', 'system', 'CUSTOM', '', 123]) {
          const result = sendMessageSchema.safeParse({
            action: 'sendMessage',
            messageId: 'msg-1',
            recipientUserId: 'bob',
            body: 'Hello',
            messageType: invalidType,
          });
          expect(result.success).toBe(false);
        }
      });
    });

    describe('sendMessageSchema - Whitespace-only & Empty Content', () => {
      it('rejects empty or whitespace-only messageId', () => {
        const emptyId = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: '',
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(emptyId.success).toBe(false);

        const whitespaceId = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: '   ',
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(whitespaceId.success).toBe(false);
      });

      it('rejects empty or whitespace-only body', () => {
        const emptyBody = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: '',
        });
        expect(emptyBody.success).toBe(false);

        const whitespaceBody = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: '   \n\t  ',
        });
        expect(whitespaceBody.success).toBe(false);
        if (!whitespaceBody.success) {
          expect(
            whitespaceBody.error.issues.some((i) => i.message.includes('body cannot be empty')),
          ).toBe(true);
        }
      });

      it('rejects whitespace-only recipientUserId when no roomId is provided', () => {
        const result = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: '   ',
          body: 'Hello',
        });
        expect(result.success).toBe(false);
      });

      it('rejects whitespace-only roomId when no recipientUserId is provided', () => {
        const result = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          roomId: '   ',
          body: 'Hello',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('sendMessageSchema - Boundary Lengths', () => {
      it('accepts messageId at boundary min (1 char) and max (64 chars)', () => {
        const minId = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'a',
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(minId.success).toBe(true);

        const maxId = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'a'.repeat(64),
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(maxId.success).toBe(true);
      });

      it('rejects messageId exceeding 64 characters', () => {
        const overLimit = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'a'.repeat(65),
          recipientUserId: 'bob',
          body: 'Hello',
        });
        expect(overLimit.success).toBe(false);
        if (!overLimit.success) {
          expect(overLimit.error.issues[0].message).toBe('messageId must not exceed 64 characters');
        }
      });

      it('accepts body at boundary min (1 char) and max (4096 chars)', () => {
        const minBody = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'x',
        });
        expect(minBody.success).toBe(true);

        const maxBody = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'x'.repeat(4096),
        });
        expect(maxBody.success).toBe(true);
      });

      it('rejects body exceeding 4096 characters', () => {
        const overBody = sendMessageSchema.safeParse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'x'.repeat(4097),
        });
        expect(overBody.success).toBe(false);
        if (!overBody.success) {
          expect(overBody.error.issues[0].message).toBe('body must not exceed 4096 characters');
        }
      });
    });

    describe('sendMessageSchema - Trimming & Field Sanitization', () => {
      it('trims leading and trailing whitespace from messageId, recipientUserId, roomId, and body', () => {
        const directParsed = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: '  msg-padded  ',
          recipientUserId: '  user-bob  ',
          body: '  Padded message text  ',
        });
        expect(directParsed.messageId).toBe('msg-padded');
        expect(directParsed.recipientUserId).toBe('user-bob');
        expect(directParsed.body).toBe('Padded message text');

        const roomParsed = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: '  msg-padded-2  ',
          roomId: '  room-123  ',
          body: '  Room message text  ',
        });
        expect(roomParsed.messageId).toBe('msg-padded-2');
        expect(roomParsed.roomId).toBe('room-123');
        expect(roomParsed.body).toBe('Room message text');
      });

      it('strips unexpected/extra fields by default in standard Zod object schema', () => {
        const parsed = sendMessageSchema.parse({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'Hello',
          unexpectedField: 'ignored',
          nested: { hacked: true },
        } as Record<string, unknown>);

        expect(parsed).not.toHaveProperty('unexpectedField');
        expect(parsed).not.toHaveProperty('nested');
        expect(parsed).toEqual({
          action: 'sendMessage',
          messageId: 'msg-1',
          recipientUserId: 'bob',
          body: 'Hello',
          messageType: 'TEXT',
        });
      });
    });
  });

  describe('Management API (postToConnection)', () => {
    it('successfully sends payload to connection', async () => {
      const mockClient = {
        send: vi.fn().mockResolvedValue({}),
      };

      const result = await postToConnection({
        connectionId: 'conn-1',
        payload: { action: 'message', text: 'hi' },
        client:
          mockClient as unknown as import('@aws-sdk/client-apigatewaymanagementapi').ApiGatewayManagementApiClient,
      });

      expect(result).toBe(true);
      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it('handles GoneException by auto-pruning connection and returning false', async () => {
      const removeConnectionSpy = vi
        .spyOn(repositories, 'removeConnection')
        .mockResolvedValue('REMOVED');

      const goneError = new Error('Gone');
      goneError.name = 'GoneException';
      (goneError as { statusCode?: number }).statusCode = 410;

      const mockClient = {
        send: vi.fn().mockRejectedValue(goneError),
      };

      const result = await postToConnection({
        connectionId: 'conn-dead',
        userId: 'user-bob',
        payload: { action: 'message' },
        client:
          mockClient as unknown as import('@aws-sdk/client-apigatewaymanagementapi').ApiGatewayManagementApiClient,
      });

      expect(result).toBe(false);
      expect(removeConnectionSpy).toHaveBeenCalledWith({
        userId: 'user-bob',
        connectionId: 'conn-dead',
      });
    });

    it('rethrows non-410 errors', async () => {
      const networkError = new Error('Network timeout');
      const mockClient = {
        send: vi.fn().mockRejectedValue(networkError),
      };

      await expect(
        postToConnection({
          connectionId: 'conn-1',
          payload: { action: 'message' },
          client:
            mockClient as unknown as import('@aws-sdk/client-apigatewaymanagementapi').ApiGatewayManagementApiClient,
        }),
      ).rejects.toThrow('Network timeout');
    });
  });

  describe('Management API Client Caching', () => {
    const originalEnv = process.env.API_GATEWAY_MANAGEMENT_ENDPOINT;

    afterEach(() => {
      resetManagementApiClients();
      if (originalEnv !== undefined) {
        process.env.API_GATEWAY_MANAGEMENT_ENDPOINT = originalEnv;
      } else {
        delete process.env.API_GATEWAY_MANAGEMENT_ENDPOINT;
      }
    });

    it('reuses the same client for repeated calls with the same endpoint', () => {
      const endpoint = 'https://api-1.execute-api.ap-south-1.amazonaws.com/dev';
      const client1 = getManagementApiClient(endpoint);
      const client2 = getManagementApiClient(endpoint);

      expect(client1).toBe(client2);
    });

    it('does not share clients between different endpoints', () => {
      const endpoint1 = 'https://api-1.execute-api.ap-south-1.amazonaws.com/dev';
      const endpoint2 = 'https://api-2.execute-api.ap-south-1.amazonaws.com/dev';
      const client1 = getManagementApiClient(endpoint1);
      const client2 = getManagementApiClient(endpoint2);

      expect(client1).not.toBe(client2);
    });

    it('falls back to API_GATEWAY_MANAGEMENT_ENDPOINT when no endpoint argument is supplied', () => {
      process.env.API_GATEWAY_MANAGEMENT_ENDPOINT =
        'https://env-api.execute-api.ap-south-1.amazonaws.com/dev';

      const client1 = getManagementApiClient();
      const client2 = getManagementApiClient();

      expect(client1).toBe(client2);
    });

    it('overrides the cached client when setManagementApiClient() is called', () => {
      const customMockClient = {
        send: vi.fn(),
      } as unknown as import('@aws-sdk/client-apigatewaymanagementapi').ApiGatewayManagementApiClient;

      setManagementApiClient(customMockClient);

      expect(getManagementApiClient('https://any-endpoint.com')).toBe(customMockClient);
      expect(getManagementApiClient()).toBe(customMockClient);
    });

    it('restores normal client creation and caching when the injected client is reset', () => {
      const customMockClient = {
        send: vi.fn(),
      } as unknown as import('@aws-sdk/client-apigatewaymanagementapi').ApiGatewayManagementApiClient;

      setManagementApiClient(customMockClient);
      expect(getManagementApiClient()).toBe(customMockClient);

      setManagementApiClient(undefined);

      const normalClient1 = getManagementApiClient('https://normal-endpoint.com');
      const normalClient2 = getManagementApiClient('https://normal-endpoint.com');

      expect(normalClient1).not.toBe(customMockClient);
      expect(normalClient1).toBe(normalClient2);
    });
  });
});
