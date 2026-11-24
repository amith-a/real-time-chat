import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  isMember,
  listLatestMessages,
  listMessagesAfter,
  type MessageItem,
  type MessageType,
} from '../../repositories';
import {
  BadRequestError,
  ForbiddenError,
  formatHttpResponse,
  getHttpAuthenticatedUser,
  handleHttpError,
  logger,
  NotFoundError,
} from '../../shared';

export interface MessageDto {
  messageId: string;
  roomId: string;
  sequenceNumber: number;
  senderId: string;
  content: string;
  body: string;
  messageType: MessageType;
  createdAt: string;
  clientMessageId?: string;
}

export function toMessageDto(item: MessageItem): MessageDto {
  return {
    messageId: item.messageId,
    roomId: item.roomId,
    sequenceNumber: item.sequenceNumber,
    senderId: item.senderId,
    content: item.content,
    body: item.content,
    messageType: item.messageType,
    createdAt: item.createdAt,
    ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
  };
}

export function decodeCursor(
  cursor?: string,
  roomId?: string,
): Record<string, unknown> | undefined {
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

  // DynamoDB primary table queries require PK and SK
  if (!key.PK || !key.SK) {
    throw new BadRequestError(
      'Invalid pagination cursor: missing required DynamoDB key attributes (PK, SK)',
    );
  }

  // Validate cursor matches the requested room
  if (roomId !== undefined && key.PK !== `ROOM#${roomId}`) {
    throw new BadRequestError(
      'Invalid pagination cursor: cursor does not belong to the requested room',
    );
  }

  // Validate cursor points to a message record (not META or MEMBER#)
  if (typeof key.SK === 'string' && !key.SK.startsWith('MSG#')) {
    throw new BadRequestError(
      'Invalid pagination cursor: cursor does not point to a message record',
    );
  }

  return key;
}

export function encodeCursor(key?: Record<string, unknown>): string | undefined {
  if (!key || Object.keys(key).length === 0) return undefined;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
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

    const roomId = event.pathParameters?.roomId?.trim();
    if (!roomId) {
      throw new BadRequestError('roomId is required');
    }
    if (roomId.includes('#')) {
      throw new BadRequestError('roomId must not contain "#"');
    }

    // Strongly consistent membership authorization check
    const member = await isMember(authUser.userId, roomId);
    if (!member) {
      throw new ForbiddenError('You are not a member of this room');
    }

    // Parse limit parameter (default 50, clamped to 1..100)
    let limit = 50;
    const limitParam = event.queryStringParameters?.limit;
    if (limitParam !== undefined && limitParam !== '') {
      const parsedLimit = Number(limitParam);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        throw new BadRequestError('limit must be an integer between 1 and 100');
      }
      limit = Math.min(parsedLimit, 100);
    }

    // Parse after parameter (optional integer >= 0 for catch-up recovery)
    let afterSequence: number | undefined;
    const afterParam = event.queryStringParameters?.after;
    if (afterParam !== undefined && afterParam !== '') {
      const parsedAfter = Number(afterParam);
      if (!Number.isInteger(parsedAfter) || parsedAfter < 0) {
        throw new BadRequestError('after must be a non-negative integer');
      }
      afterSequence = parsedAfter;
    }

    const startKey = decodeCursor(event.queryStringParameters?.cursor, roomId);

    // Query messages: recovery mode (?after=N) vs browsing mode (latest first)
    const page =
      afterSequence !== undefined
        ? await listMessagesAfter(roomId, afterSequence, { limit, startKey })
        : await listLatestMessages(roomId, { limit, startKey });

    return formatHttpResponse(200, {
      items: page.items.map(toMessageDto),
      nextCursor: encodeCursor(page.nextKey),
      hasMore: Boolean(page.nextKey),
    });
  } catch (error) {
    return handleHttpError(error, log);
  }
};
