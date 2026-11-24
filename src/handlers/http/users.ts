import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { getUserProfile, listUsers, searchUsers, type UserProfileItem } from '../../repositories';
import {
  BadRequestError,
  formatHttpResponse,
  getHttpAuthenticatedUser,
  type HttpAuthUser,
  handleHttpError,
  logger,
  NotFoundError,
} from '../../shared';

export type { HttpAuthUser };
export { getHttpAuthenticatedUser };

export interface PublicUserDto {
  userId: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
}

export function toPublicUserDto(profile: UserProfileItem): PublicUserDto {
  return {
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName || profile.name,
    avatarUrl: profile.avatarUrl,
  };
}

export interface OwnUserProfileDto extends PublicUserDto {
  email?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function toOwnUserProfileDto(
  profile: UserProfileItem,
  authUser: HttpAuthUser,
): OwnUserProfileDto {
  return {
    userId: profile.userId,
    email: profile.email || authUser.email,
    username: profile.username || authUser.username,
    displayName: profile.displayName || profile.name,
    avatarUrl: profile.avatarUrl,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function decodeCursor(cursor?: string): Record<string, unknown> | undefined {
  if (cursor === undefined || cursor === '') return undefined;

  const trimmed = cursor.trim();
  if (!trimmed) return undefined;

  // 1. Verify standard Base64 encoding
  const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!base64Regex.test(trimmed)) {
    throw new BadRequestError('Invalid pagination cursor: not valid base64');
  }

  // 2. Decode and parse JSON
  let parsed: unknown;
  try {
    const jsonStr = Buffer.from(trimmed, 'base64').toString('utf8');
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new BadRequestError('Invalid pagination cursor: malformed JSON payload');
  }

  // 3. Validate decoded DynamoDB key structure
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('Invalid pagination cursor: expected key object');
  }

  const key = parsed as Record<string, unknown>;
  const entries = Object.entries(key);
  if (entries.length === 0) {
    throw new BadRequestError('Invalid pagination cursor: key object cannot be empty');
  }

  for (const [k, v] of entries) {
    if (typeof v !== 'string' || !v.trim()) {
      throw new BadRequestError(
        `Invalid pagination cursor: attribute ${k} must be a non-empty string`,
      );
    }
  }

  // DynamoDB GSI1 queries require primary and index partition keys
  if (!key.PK || !key.GSI1PK) {
    throw new BadRequestError(
      'Invalid pagination cursor: missing required DynamoDB key attributes (PK, GSI1PK)',
    );
  }

  return key;
}

export function encodeCursor(key?: Record<string, unknown>): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key)).toString('base64');
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = logger.withContext({
    path: event.rawPath,
    method: event.requestContext.http.method,
    requestId: event.requestContext.requestId,
  });

  try {
    const method = event.requestContext.http.method.toUpperCase();
    const rawPath = event.rawPath || '';

    // Handle CORS preflight if invoked directly
    if (method === 'OPTIONS') {
      return formatHttpResponse(200, {});
    }

    if (method !== 'GET') {
      throw new NotFoundError(`Method ${method} not allowed on ${rawPath}`);
    }

    // Require authentication
    const authUser = getHttpAuthenticatedUser(event);
    const pathUserId = event.pathParameters?.userId;

    // 1. GET /users/me
    if (rawPath.endsWith('/users/me') || pathUserId === 'me') {
      const profile = await getUserProfile(authUser.userId);
      if (!profile) {
        return formatHttpResponse(200, {
          userId: authUser.userId,
          email: authUser.email,
          username: authUser.username,
        });
      }
      return formatHttpResponse(200, toOwnUserProfileDto(profile, authUser));
    }

    // 2. GET /users/{userId}
    if (pathUserId) {
      const profile = await getUserProfile(pathUserId);
      if (!profile) {
        throw new NotFoundError(`User ${pathUserId} not found`);
      }
      return formatHttpResponse(200, toPublicUserDto(profile));
    }

    // 3. GET /users?query=...&limit=...&cursor=...
    const query =
      event.queryStringParameters?.query ||
      event.queryStringParameters?.search ||
      event.queryStringParameters?.q ||
      '';
    const limit = Math.min(
      Math.max(Number.parseInt(event.queryStringParameters?.limit || '20', 10) || 20, 1),
      100,
    );
    const startKey = decodeCursor(event.queryStringParameters?.cursor);

    const page = query.trim()
      ? await searchUsers(query, { limit, startKey })
      : await listUsers({ limit, startKey });

    return formatHttpResponse(200, {
      items: page.items.map(toPublicUserDto),
      nextCursor: encodeCursor(page.nextKey),
      hasMore: Boolean(page.nextKey),
    });
  } catch (error) {
    return handleHttpError(error, log);
  }
};
