import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type {
  APIGatewayAuthorizerResult,
  APIGatewayRequestAuthorizerEvent,
  Statement,
} from 'aws-lambda';

export interface AuthorizerContext {
  userId: string;
  email: string;
  username: string;
}

export interface JwtPayload {
  sub: string;
  email?: string;
  'cognito:username'?: string;
  [key: string]: unknown;
}

export interface ITokenVerifier {
  verify(token: string): Promise<JwtPayload>;
}

/**
 * Generates an IAM policy for API Gateway authorizer responses.
 */
export function generatePolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string | number | boolean>,
): APIGatewayAuthorizerResult {
  const statement: Statement = {
    Action: 'execute-api:Invoke',
    Effect: effect,
    Resource: resource,
  };

  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [statement],
    },
    ...(context ? { context } : {}),
  };
}

/**
 * Extracts authentication token from WebSocket request authorizer event.
 *
 * API Gateway WebSocket `WebSocketAuthorizer` sets `IdentitySource: route.request.querystring.token`
 * because browser `WebSocket` APIs cannot attach custom `Authorization` headers (and requiring
 * both in `IdentitySource` would reject browser clients before invoking this Lambda).
 * Header/alternate query fallbacks are retained for direct non-browser and test invocations.
 */
export function extractToken(event: APIGatewayRequestAuthorizerEvent): string | null {
  const queryParams = event.queryStringParameters || {};
  const headers = event.headers || {};

  const rawToken =
    queryParams.token ||
    queryParams.idToken ||
    queryParams.Authorization ||
    queryParams.authorization ||
    headers.Authorization ||
    headers.authorization;

  if (!rawToken) {
    return null;
  }

  // Handle 'Bearer <token>' prefix if present
  return rawToken.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Creates the authorizer handler with the provided token verifier.
 * Enables clean dependency injection for unit testing without network JWKS calls.
 */
export function createAuthorizerHandler(verifier: ITokenVerifier) {
  return async (event: APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
    const resource = event.methodArn;

    try {
      const token = extractToken(event);
      if (!token) {
        // Missing token: Deny access without logging sensitive data
        return generatePolicy('anonymous', 'Deny', resource);
      }

      // Verify signature, audience, issuer, expiration, and token use
      const payload = await verifier.verify(token);

      const userId = payload.sub;
      const email = typeof payload.email === 'string' ? payload.email : '';
      const username =
        typeof payload['cognito:username'] === 'string'
          ? (payload['cognito:username'] as string)
          : userId;

      return generatePolicy(userId, 'Allow', resource, {
        userId,
        email,
        username,
      });
    } catch {
      // Reject invalid or expired tokens (do not log raw token or secret)
      return generatePolicy('anonymous', 'Deny', resource);
    }
  };
}

// Default verifier using CognitoJwtVerifier (configured via environment variables)
let defaultVerifier: ITokenVerifier | null = null;

function getDefaultVerifier(): ITokenVerifier {
  if (!defaultVerifier) {
    const userPoolId = process.env.USER_POOL_ID;
    const clientId = process.env.USER_POOL_CLIENT_ID;

    if (!userPoolId || !clientId) {
      throw new Error('Missing USER_POOL_ID or USER_POOL_CLIENT_ID environment variable');
    }

    const verifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: 'id',
    });

    defaultVerifier = {
      verify: (token: string) => verifier.verify(token) as Promise<JwtPayload>,
    };
  }

  return defaultVerifier;
}

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const verifier = getDefaultVerifier();
  const authorizer = createAuthorizerHandler(verifier);
  return authorizer(event);
};
