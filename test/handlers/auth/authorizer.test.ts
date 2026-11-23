import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  createAuthorizerHandler,
  extractToken,
  generatePolicy,
  type ITokenVerifier,
} from '../../../src/handlers/auth/authorizer';

function createMockEvent(options: {
  queryStringParameters?: Record<string, string>;
  headers?: Record<string, string>;
  methodArn?: string;
}): APIGatewayRequestAuthorizerEvent {
  return {
    type: 'REQUEST',
    methodArn:
      options.methodArn || 'arn:aws:execute-api:us-east-1:123456789012:api-id/dev/$connect',
    resource: '$connect',
    path: '/dev',
    httpMethod: 'GET',
    headers: options.headers || {},
    multiValueHeaders: {},
    queryStringParameters: options.queryStringParameters || {},
    multiValueQueryStringParameters: {},
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as unknown as APIGatewayRequestAuthorizerEvent['requestContext'],
  };
}

describe('WebSocket Authorizer', () => {
  describe('extractToken', () => {
    it('extracts token from queryStringParameters.token', () => {
      const event = createMockEvent({
        queryStringParameters: { token: 'mock-token-from-query' },
      });
      expect(extractToken(event)).toBe('mock-token-from-query');
    });

    it('extracts token from queryStringParameters.idToken', () => {
      const event = createMockEvent({
        queryStringParameters: { idToken: 'mock-id-token' },
      });
      expect(extractToken(event)).toBe('mock-id-token');
    });

    it('extracts token from headers.Authorization with Bearer prefix', () => {
      const event = createMockEvent({
        headers: { Authorization: 'Bearer mock-header-token' },
      });
      expect(extractToken(event)).toBe('mock-header-token');
    });

    it('returns null when no token is present', () => {
      const event = createMockEvent({});
      expect(extractToken(event)).toBeNull();
    });
  });

  describe('generatePolicy', () => {
    it('generates an Allow policy with context', () => {
      const policy = generatePolicy(
        'user-123',
        'Allow',
        'arn:aws:execute-api:region:account:api/$connect',
        {
          userId: 'user-123',
          email: 'test@example.com',
        },
      );

      expect(policy.principalId).toBe('user-123');
      expect(policy.policyDocument.Statement[0]).toEqual({
        Action: 'execute-api:Invoke',
        Effect: 'Allow',
        Resource: 'arn:aws:execute-api:region:account:api/$connect',
      });
      expect(policy.context).toEqual({
        userId: 'user-123',
        email: 'test@example.com',
      });
    });

    it('generates a Deny policy without context', () => {
      const policy = generatePolicy(
        'anonymous',
        'Deny',
        'arn:aws:execute-api:region:account:api/$connect',
      );

      expect(policy.principalId).toBe('anonymous');
      expect(policy.policyDocument.Statement[0].Effect).toBe('Deny');
      expect(policy.context).toBeUndefined();
    });
  });

  describe('authorizer handler with verifier', () => {
    const mockMethodArn = 'arn:aws:execute-api:us-east-1:123456789012:api-id/dev/$connect';

    it('accepts valid ID token and returns user identity in policy and context', async () => {
      const mockVerifier: ITokenVerifier = {
        verify: vi.fn().mockResolvedValue({
          sub: 'user-sub-uuid',
          email: 'user@example.com',
          'cognito:username': 'testuser',
        }),
      };

      const authorizer = createAuthorizerHandler(mockVerifier);
      const event = createMockEvent({
        queryStringParameters: { token: 'valid.jwt.token' },
        methodArn: mockMethodArn,
      });

      const response = await authorizer(event);

      expect(mockVerifier.verify).toHaveBeenCalledWith('valid.jwt.token');
      expect(response.principalId).toBe('user-sub-uuid');
      expect(response.policyDocument.Statement[0].Effect).toBe('Allow');
      expect((response.policyDocument.Statement[0] as { Resource: string }).Resource).toBe(
        mockMethodArn,
      );
      expect(response.context).toEqual({
        userId: 'user-sub-uuid',
        email: 'user@example.com',
        username: 'testuser',
      });
    });

    it('rejects expired token and returns Deny policy', async () => {
      const mockVerifier: ITokenVerifier = {
        verify: vi.fn().mockRejectedValue(new Error('Token has expired')),
      };

      const authorizer = createAuthorizerHandler(mockVerifier);
      const event = createMockEvent({
        queryStringParameters: { token: 'expired.jwt.token' },
        methodArn: mockMethodArn,
      });

      const response = await authorizer(event);

      expect(response.principalId).toBe('anonymous');
      expect(response.policyDocument.Statement[0].Effect).toBe('Deny');
      expect((response.policyDocument.Statement[0] as { Resource: string }).Resource).toBe(
        mockMethodArn,
      );
      expect(response.context).toBeUndefined();
    });

    it('rejects invalid signature or malformed token and returns Deny policy', async () => {
      const mockVerifier: ITokenVerifier = {
        verify: vi.fn().mockRejectedValue(new Error('Invalid signature')),
      };

      const authorizer = createAuthorizerHandler(mockVerifier);
      const event = createMockEvent({
        queryStringParameters: { token: 'invalid.signature.token' },
        methodArn: mockMethodArn,
      });

      const response = await authorizer(event);

      expect(response.principalId).toBe('anonymous');
      expect(response.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('rejects when token is absent in both query params and headers', async () => {
      const mockVerifier: ITokenVerifier = {
        verify: vi.fn(),
      };

      const authorizer = createAuthorizerHandler(mockVerifier);
      const event = createMockEvent({
        methodArn: mockMethodArn,
      });

      const response = await authorizer(event);

      expect(mockVerifier.verify).not.toHaveBeenCalled();
      expect(response.principalId).toBe('anonymous');
      expect(response.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });
});
