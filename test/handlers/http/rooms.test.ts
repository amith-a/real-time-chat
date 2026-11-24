import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handler as roomsHandler,
  toRoomDto,
  toRoomMemberDto,
} from '../../../src/handlers/http/rooms';
import type { MembershipItem, RoomItem } from '../../../src/repositories';
import * as repositories from '../../../src/repositories';
import { type HttpResponse, NotFoundError } from '../../../src/shared';

const mockContext = {} as Context;
const mockCallback = () => {};

function createHttpEvent(
  overrides: {
    method?: string;
    rawPath?: string;
    userId?: string;
    pathParameters?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    body?: string;
    claims?: Record<string, unknown>;
  } = {},
): APIGatewayProxyEventV2 {
  const method = overrides.method || 'GET';
  const rawPath = overrides.rawPath || '/rooms';
  const claims =
    overrides.claims !== undefined
      ? overrides.claims
      : {
          sub: overrides.userId || 'user-admin',
          email: 'admin@example.com',
          'cognito:username': 'admin',
        };

  return {
    version: '2.0',
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString: '',
    headers: {
      authorization: 'Bearer token',
      'content-type': 'application/json',
    },
    queryStringParameters: overrides.queryStringParameters,
    pathParameters: overrides.pathParameters,
    body: overrides.body,
    requestContext: {
      accountId: '123456789012',
      apiId: 'http-api-id',
      domainName: 'test.execute-api.ap-south-1.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method,
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test-agent',
      },
      requestId: 'req-rooms-1',
      routeKey: `${method} ${rawPath}`,
      stage: 'dev',
      time: '24/Nov/2026:10:00:00 +0000',
      timeEpoch: 1700000000000,
      authorizer: {
        jwt: {
          claims,
          scopes: [],
        },
      },
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function sampleRoom(overrides: Partial<RoomItem> = {}): RoomItem {
  return {
    PK: `ROOM#${overrides.roomId || 'room-123'}`,
    SK: 'META',
    roomId: overrides.roomId || 'room-123',
    roomType: overrides.roomType || 'GROUP',
    name: overrides.name || 'Engineering Group',
    createdBy: overrides.createdBy || 'user-admin',
    memberCount: overrides.memberCount ?? 3,
    createdAt: '2026-11-24T10:00:00.000Z',
  };
}

function sampleMembership(
  userId: string,
  roomId = 'room-123',
  role: 'ADMIN' | 'MEMBER' = 'MEMBER',
): MembershipItem {
  return {
    PK: `USER#${userId}`,
    SK: `ROOM#${roomId}`,
    GSI1PK: `ROOM#${roomId}`,
    GSI1SK: `MEMBER#${userId}`,
    userId,
    roomId,
    role,
    joinedAt: '2026-11-24T10:00:00.000Z',
  };
}

describe('Rooms HTTP Handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CORS and Authentication', () => {
    it('handles OPTIONS preflight request', async () => {
      const event = createHttpEvent({ method: 'OPTIONS' });
      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(200);
      expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res.headers['Access-Control-Allow-Methods']).toContain('POST');
    });

    it('returns 401 when claims sub is missing', async () => {
      const event = createHttpEvent({ claims: {} });
      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).message).toContain('sub claim is required');
    });
  });

  describe('POST /rooms — Create Group Room', () => {
    it('creates a group room and assigns creator as ADMIN', async () => {
      const room = sampleRoom({ roomId: 'grp-abc', name: 'Core Team', createdBy: 'user-admin' });
      const createSpy = vi.spyOn(repositories, 'createGroupRoom').mockResolvedValue({
        room,
        created: true,
      });

      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms',
        userId: 'user-admin',
        body: JSON.stringify({
          name: 'Core Team',
          members: [{ userId: 'user-bob', role: 'MEMBER' }],
        }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.roomId).toBe('grp-abc');
      expect(body.name).toBe('Core Team');
      expect(body.createdBy).toBe('user-admin');

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Core Team',
          createdBy: 'user-admin',
          validateUsers: true,
          members: [
            { userId: 'user-admin', role: 'ADMIN' },
            { userId: 'user-bob', role: 'MEMBER' },
          ],
        }),
      );
    });

    it('returns 400 when room name exceeds 100 characters', async () => {
      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms',
        body: JSON.stringify({ name: 'A'.repeat(101) }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('Room name must not exceed 100 characters');
    });

    it('returns 400 when member userId contains "#"', async () => {
      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms',
        body: JSON.stringify({
          members: [{ userId: 'invalid#id' }],
        }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('must not contain "#"');
    });

    it('returns 404 when a requested initial member does not exist in users', async () => {
      vi.spyOn(repositories, 'createGroupRoom').mockRejectedValueOnce(
        new NotFoundError('User user-ghost does not exist'),
      );

      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms',
        userId: 'user-admin',
        body: JSON.stringify({
          name: 'Core Team',
          members: [{ userId: 'user-ghost', role: 'MEMBER' }],
        }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toContain('User user-ghost does not exist');
    });
  });

  describe('GET /rooms — List User Rooms', () => {
    it('returns paginated list of rooms for the authenticated user', async () => {
      const items = [sampleMembership('user-admin', 'r1'), sampleMembership('user-admin', 'r2')];
      vi.spyOn(repositories, 'listRoomsForUserPage').mockResolvedValue({
        items,
        nextKey: { PK: 'USER#user-admin', SK: 'ROOM#r2' },
      });

      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms',
        userId: 'user-admin',
        queryStringParameters: { limit: '10' },
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.items).toHaveLength(2);
      expect(body.hasMore).toBe(true);
      expect(body.nextCursor).toBeDefined();
    });

    it('returns 400 when limit is less than 1', async () => {
      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms',
        queryStringParameters: { limit: '0' },
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('limit must be an integer between 1 and 100');
    });
  });

  describe('GET /rooms/{roomId} — Get Room Details', () => {
    it('returns 403 Forbidden when caller is not a member', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(false);

      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms/room-123',
        pathParameters: { roomId: 'room-123' },
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toBe('You are not a member of this room');
    });

    it('returns 404 when room does not exist', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      vi.spyOn(repositories, 'getRoom').mockResolvedValue(undefined);

      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms/room-123',
        pathParameters: { roomId: 'room-123' },
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toContain('Room room-123 not found');
    });

    it('returns room details when caller is an active member', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      vi.spyOn(repositories, 'getRoom').mockResolvedValue(sampleRoom({ roomId: 'room-123' }));

      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms/room-123',
        pathParameters: { roomId: 'room-123' },
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.roomId).toBe('room-123');
      expect(body.roomType).toBe('GROUP');
    });
  });

  describe('GET /rooms/{roomId}/members — List Room Members', () => {
    it('returns 403 when caller is not a member', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(false);

      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms/room-123/members',
        pathParameters: { roomId: 'room-123' },
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(403);
    });

    it('returns member list when caller is a member', async () => {
      vi.spyOn(repositories, 'isMember').mockResolvedValue(true);
      vi.spyOn(repositories, 'listRoomMembers').mockResolvedValue([
        sampleMembership('user-admin', 'room-123', 'ADMIN'),
        sampleMembership('user-bob', 'room-123', 'MEMBER'),
      ]);

      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms/room-123/members',
        pathParameters: { roomId: 'room-123' },
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toHaveLength(2);
      expect(body.items[0].userId).toBe('user-admin');
      expect(body.items[0].role).toBe('ADMIN');
    });
  });

  describe('POST /rooms/{roomId}/members — Add Member', () => {
    it('returns 400 when target userId is missing', async () => {
      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms/room-123/members',
        pathParameters: { roomId: 'room-123' },
        body: JSON.stringify({}),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toBe('userId is required');
    });

    it('adds member successfully when authorized by admin', async () => {
      const newMember = sampleMembership('user-charlie', 'room-123', 'MEMBER');
      vi.spyOn(repositories, 'addMember').mockResolvedValue({ member: newMember });

      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms/room-123/members',
        pathParameters: { roomId: 'room-123' },
        userId: 'user-admin',
        body: JSON.stringify({ userId: 'user-charlie', role: 'MEMBER' }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.member.userId).toBe('user-charlie');
      expect(body.member.role).toBe('MEMBER');
    });
  });

  describe('DELETE /rooms/{roomId}/members/{userId} — Remove Member or Leave', () => {
    it('removes member when authorized', async () => {
      vi.spyOn(repositories, 'removeMember').mockResolvedValue({ success: true });

      const event = createHttpEvent({
        method: 'DELETE',
        rawPath: '/rooms/room-123/members/user-charlie',
        pathParameters: { roomId: 'room-123', userId: 'user-charlie' },
        userId: 'user-admin',
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).message).toBe('Member removed successfully');
    });
  });

  describe('DTO Transformers', () => {
    it('toRoomDto strips internal PK and SK keys', () => {
      const room = sampleRoom();
      const dto = toRoomDto(room);

      expect((dto as unknown as { PK?: string }).PK).toBeUndefined();
      expect((dto as unknown as { SK?: string }).SK).toBeUndefined();
      expect(dto.roomId).toBe(room.roomId);
    });

    it('toRoomMemberDto strips internal keys', () => {
      const membership = sampleMembership('u1', 'r1', 'ADMIN');
      const dto = toRoomMemberDto(membership);

      expect((dto as unknown as { PK?: string }).PK).toBeUndefined();
      expect((dto as unknown as { GSI1PK?: string }).GSI1PK).toBeUndefined();
      expect(dto.userId).toBe('u1');
      expect(dto.role).toBe('ADMIN');
    });
  });
});
