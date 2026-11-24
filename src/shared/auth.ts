import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { UnauthorizedError } from './errors';

export interface HttpAuthUser {
  userId: string;
  email?: string;
  username?: string;
}

export function getHttpAuthenticatedUser(event: APIGatewayProxyEventV2): HttpAuthUser {
  const claims = (
    event.requestContext as {
      authorizer?: {
        jwt?: {
          claims?: {
            sub?: string;
            email?: string;
            'cognito:username'?: string;
            username?: string;
            [key: string]: unknown;
          };
        };
      };
    }
  )?.authorizer?.jwt?.claims;

  const userId =
    typeof claims?.sub === 'string' && claims.sub.trim() ? claims.sub.trim() : undefined;
  if (!userId) {
    throw new UnauthorizedError(
      'Missing or invalid authenticated user identity: sub claim is required',
    );
  }

  return {
    userId,
    email: typeof claims?.email === 'string' ? claims.email.trim() : undefined,
    username:
      typeof claims?.['cognito:username'] === 'string'
        ? claims['cognito:username'].trim()
        : typeof claims?.username === 'string'
          ? claims.username.trim()
          : undefined,
  };
}
