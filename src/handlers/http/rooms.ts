import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  addMember,
  createGroupRoom,
  getRoom,
  isMember,
  listRoomMembers,
  listRoomsForUserPage,
  type MemberRole,
  type MembershipItem,
  type RoomItem,
  removeMember,
} from '../../repositories';
import {
  BadRequestError,
  ForbiddenError,
  formatHttpResponse,
  getHttpAuthenticatedUser,
  handleHttpError,
  logger,
  NotFoundError,
  parseJsonBody,
} from '../../shared';

export interface RoomDto {
  roomId: string;
  roomType: 'DIRECT' | 'GROUP';
  name?: string;
  createdBy: string;
  memberCount?: number;
  createdAt: string;
}

export function toRoomDto(item: RoomItem): RoomDto {
  return {
    roomId: item.roomId,
    roomType: item.roomType,
    name: item.name,
    createdBy: item.createdBy,
    memberCount: item.memberCount,
    createdAt: item.createdAt,
  };
}

export interface RoomMemberDto {
  userId: string;
  roomId: string;
  role: MemberRole;
  joinedAt: string;
}

export function toRoomMemberDto(item: MembershipItem): RoomMemberDto {
  return {
    userId: item.userId,
    roomId: item.roomId,
    role: item.role,
    joinedAt: item.joinedAt,
  };
}

export function encodeCursor(key?: Record<string, unknown>): string | undefined {
  if (!key || Object.keys(key).length === 0) return undefined;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
}

export function decodeCursor(cursor?: string): Record<string, unknown> | undefined {
  if (cursor === undefined || cursor === '') return undefined;

  const trimmed = cursor.trim();
  if (!trimmed) return undefined;

  const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!base64Regex.test(trimmed)) {
    throw new BadRequestError('Invalid pagination cursor: not valid base64');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
  } catch {
    throw new BadRequestError('Invalid pagination cursor: malformed JSON payload');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('Invalid pagination cursor: expected key object');
  }

  const key = parsed as Record<string, unknown>;
  if (Object.keys(key).length === 0) {
    throw new BadRequestError('Invalid pagination cursor: key object cannot be empty');
  }

  if (!key.PK || !key.SK) {
    throw new BadRequestError(
      'Invalid pagination cursor: missing required DynamoDB key attributes (PK, SK)',
    );
  }

  return key;
}

interface CreateRoomBody {
  name?: string;
  members?: Array<{ userId: string; role?: MemberRole }>;
}

interface AddMemberBody {
  userId?: string;
  role?: MemberRole;
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

    // 1. CORS Preflight
    if (method === 'OPTIONS') {
      return formatHttpResponse(200, {});
    }

    // 2. Authenticate caller
    const authUser = getHttpAuthenticatedUser(event);

    const pathRoomId = event.pathParameters?.roomId?.trim();
    const pathUserId = event.pathParameters?.userId?.trim();

    // 3. POST /rooms — Create Group Room
    if (method === 'POST' && (!pathRoomId || rawPath === '/rooms' || rawPath === '/dev/rooms')) {
      const body = parseJsonBody<CreateRoomBody>(event) || {};
      const name = typeof body.name === 'string' ? body.name.trim() : undefined;
      if (name && name.length > 100) {
        throw new BadRequestError('Room name must not exceed 100 characters');
      }

      const requestedMembers = Array.isArray(body.members) ? body.members : [];
      const memberMap = new Map<string, MemberRole>();

      // Creator is always added as ADMIN
      memberMap.set(authUser.userId, 'ADMIN');

      for (const m of requestedMembers) {
        if (!m || typeof m.userId !== 'string' || !m.userId.trim()) {
          throw new BadRequestError('Each member must have a valid non-empty userId');
        }
        const memberId = m.userId.trim();
        if (memberId.includes('#')) {
          throw new BadRequestError('userId must not contain "#"');
        }
        if (memberId === authUser.userId) {
          continue; // Creator already added
        }
        if (memberMap.has(memberId)) {
          throw new BadRequestError(`Duplicate member ${memberId} in group room creation`);
        }
        const role: MemberRole = m.role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
        memberMap.set(memberId, role);
      }

      const allMembers = Array.from(memberMap.entries()).map(([userId, role]) => ({
        userId,
        role,
      }));

      const roomId = randomUUID();
      const result = await createGroupRoom({
        roomId,
        name,
        createdBy: authUser.userId,
        members: allMembers,
        validateUsers: true,
      });

      return formatHttpResponse(201, toRoomDto(result.room));
    }

    // 4. GET /rooms — List User's Rooms
    if (method === 'GET' && (!pathRoomId || rawPath === '/rooms' || rawPath === '/dev/rooms')) {
      let limit = 50;
      const limitParam = event.queryStringParameters?.limit;
      if (limitParam !== undefined && limitParam !== '') {
        const parsedLimit = Number(limitParam);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
          throw new BadRequestError('limit must be an integer between 1 and 100');
        }
        limit = Math.min(parsedLimit, 100);
      }

      const startKey = decodeCursor(event.queryStringParameters?.cursor);
      const page = await listRoomsForUserPage(authUser.userId, { limit, startKey });

      return formatHttpResponse(200, {
        items: page.items.map(toRoomMemberDto),
        nextCursor: encodeCursor(page.nextKey),
        hasMore: Boolean(page.nextKey),
      });
    }

    // From here, pathRoomId is required
    if (!pathRoomId) {
      throw new NotFoundError(`Route ${method} ${rawPath} not found`);
    }

    if (pathRoomId.includes('#')) {
      throw new BadRequestError('roomId must not contain "#"');
    }

    const isMembersSubRoute = rawPath.includes('/members');

    // 5. POST /rooms/{roomId}/members — Add member
    if (method === 'POST' && isMembersSubRoute && !pathUserId) {
      const body = parseJsonBody<AddMemberBody>(event) || {};
      const targetUserId = typeof body.userId === 'string' ? body.userId.trim() : undefined;
      if (!targetUserId) {
        throw new BadRequestError('userId is required');
      }
      if (targetUserId.includes('#')) {
        throw new BadRequestError('userId must not contain "#"');
      }

      const role: MemberRole = body.role === 'ADMIN' ? 'ADMIN' : 'MEMBER';

      const result = await addMember({
        roomId: pathRoomId,
        userId: targetUserId,
        role,
        addedBy: authUser.userId,
      });

      return formatHttpResponse(201, { member: toRoomMemberDto(result.member) });
    }

    // 6. DELETE /rooms/{roomId}/members/{userId} — Remove member or leave
    if (method === 'DELETE' && isMembersSubRoute && pathUserId) {
      if (pathUserId.includes('#')) {
        throw new BadRequestError('userId must not contain "#"');
      }

      await removeMember({
        roomId: pathRoomId,
        userId: pathUserId,
        removedBy: authUser.userId,
      });

      return formatHttpResponse(200, { message: 'Member removed successfully' });
    }

    // 7. GET /rooms/{roomId}/members — List room members (AP7)
    if (method === 'GET' && isMembersSubRoute) {
      const userIsMember = await isMember(authUser.userId, pathRoomId);
      if (!userIsMember) {
        throw new ForbiddenError('You are not a member of this room');
      }

      const members = await listRoomMembers(pathRoomId);
      return formatHttpResponse(200, { items: members.map(toRoomMemberDto) });
    }

    // 8. GET /rooms/{roomId} — Get room metadata (AP5)
    if (method === 'GET' && !isMembersSubRoute) {
      const userIsMember = await isMember(authUser.userId, pathRoomId);
      if (!userIsMember) {
        throw new ForbiddenError('You are not a member of this room');
      }

      const room = await getRoom(pathRoomId, true);
      if (!room) {
        throw new NotFoundError(`Room ${pathRoomId} not found`);
      }

      return formatHttpResponse(200, toRoomDto(room));
    }

    throw new NotFoundError(`Method ${method} not allowed on ${rawPath}`);
  } catch (error) {
    return handleHttpError(error, log);
  }
};
