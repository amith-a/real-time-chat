import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handler as roomsHandler } from '../../src/handlers/http/rooms';
import {
  addMember,
  createDirectRoom,
  createGroupRoom,
  directRoomId,
  ensureUserProfile,
  getMembership,
  getRoom,
  isMember,
  listRoomMembers,
  listRoomsForUser,
  removeMember,
} from '../../src/repositories';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  type HttpResponse,
  NotFoundError,
} from '../../src/shared';
import { createTestTable, now, pollUntil, safeTeardown } from './helpers';

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
  } = {},
): APIGatewayProxyEventV2 {
  const method = overrides.method || 'GET';
  const rawPath = overrides.rawPath || '/rooms';
  const userId = overrides.userId || 'admin1';

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
      requestId: 'req-rooms-integration',
      routeKey: `${method} ${rawPath}`,
      stage: 'dev',
      time: '24/Nov/2026:10:00:00 +0000',
      timeEpoch: 1700000000000,
      authorizer: {
        jwt: {
          claims: {
            sub: userId,
            email: `${userId}@example.com`,
          },
          scopes: [],
        },
      },
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

describe('rooms (DynamoDB Local)', () => {
  let table: string;
  beforeAll(async () => {
    table = await createTestTable();
    await Promise.all([
      ensureUserProfile({ userId: 'admin1', email: 'admin1@example.com' }),
      ensureUserProfile({ userId: 'member1', email: 'member1@example.com' }),
      ensureUserProfile({ userId: 'member2', email: 'member2@example.com' }),
      ensureUserProfile({ userId: 'owner1', email: 'owner1@example.com' }),
      ensureUserProfile({ userId: 'user1', email: 'user1@example.com' }),
      ensureUserProfile({ userId: 'user2', email: 'user2@example.com' }),
      ensureUserProfile({ userId: 'user3', email: 'user3@example.com' }),
      ensureUserProfile({ userId: 'imposter', email: 'imposter@example.com' }),
    ]);
  });
  afterAll(async () => {
    await safeTeardown(table);
  });

  it('creates a direct room with both memberships', async () => {
    const result = await createDirectRoom({ userA: 'alice', userB: 'bob', now: now() });
    expect(result.created).toBe(true);
    expect(result.room.roomId).toBe(directRoomId('alice', 'bob'));
    expect(await isMember('alice', result.room.roomId)).toBe(true);
    expect(await isMember('bob', result.room.roomId)).toBe(true);
    expect(await isMember('carol', result.room.roomId)).toBe(false);
  });

  it('is idempotent: a repeat does not overwrite and reports created = false', async () => {
    const first = await createDirectRoom({
      userA: 'dan',
      userB: 'eve',
      now: '2026-01-01T00:00:00.000Z',
    });
    const second = await createDirectRoom({
      userA: 'eve',
      userB: 'dan',
      now: '2026-02-02T00:00:00.000Z',
    });
    expect(second.created).toBe(false);
    expect(second.room.roomId).toBe(first.room.roomId);
    const membership = await getMembership('dan', first.room.roomId);
    expect(membership?.joinedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('exactly one of many concurrent creators wins', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => createDirectRoom({ userA: 'fay', userB: 'gus', now: now() })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.room.roomId)).size).toBe(1);
  });

  it('lists members through GSI1 with polling for eventual consistency', async () => {
    const { room } = await createDirectRoom({ userA: 'hal', userB: 'ivy', now: now() });
    // GSI reads are eventually consistent; poll until members appear
    const members = await pollUntil(
      () => listRoomMembers(room.roomId),
      (m) => m.length === 2,
      { description: 'GSI1 room members replication' },
    );
    expect(members.map((m) => m.userId).sort()).toEqual(['hal', 'ivy']);
    expect((await listRoomsForUser('hal')).map((m) => m.roomId)).toContain(room.roomId);
  });

  it('creates a group room with creator and initial members, and verifies idempotency', async () => {
    const members = [
      { userId: 'admin1', role: 'ADMIN' as const },
      { userId: 'member1', role: 'MEMBER' as const },
      { userId: 'member2', role: 'MEMBER' as const },
    ];
    const created = await createGroupRoom({
      roomId: 'group-1',
      createdBy: 'admin1',
      name: 'Project Discussion',
      members,
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(created.created).toBe(true);
    expect(created.room.name).toBe('Project Discussion');
    expect(created.room.memberCount).toBe(3);
    expect(await isMember('admin1', 'group-1')).toBe(true);
    expect(await isMember('member1', 'group-1')).toBe(true);

    const adminMembership = await getMembership('admin1', 'group-1');
    expect(adminMembership?.role).toBe('ADMIN');

    // Repeated request with same members and creator reports created = false
    const duplicate = await createGroupRoom({
      roomId: 'group-1',
      createdBy: 'admin1',
      name: 'Project Discussion',
      members,
      now: '2026-02-01T00:00:00.000Z',
    });
    expect(duplicate.created).toBe(false);
  });

  it('rejects group room creation if any member or creator does not exist in users', async () => {
    await expect(
      createGroupRoom({
        roomId: 'nonexistent-members-group',
        createdBy: 'admin1',
        name: 'Ghost Room',
        members: [
          { userId: 'admin1', role: 'ADMIN' },
          { userId: 'ghost-member-12345', role: 'MEMBER' },
        ],
        validateUsers: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      createGroupRoom({
        roomId: 'nonexistent-creator-group',
        createdBy: 'ghost-creator-67890',
        name: 'Ghost Room 2',
        members: [{ userId: 'admin1', role: 'MEMBER' }],
        validateUsers: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('negative group room verification', () => {
    const baseMembers = [
      { userId: 'owner1', role: 'ADMIN' as const },
      { userId: 'user1', role: 'MEMBER' as const },
    ];

    beforeAll(async () => {
      await createGroupRoom({
        roomId: 'neg-group-1',
        createdBy: 'owner1',
        name: 'Team Alpha',
        members: baseMembers,
        now: '2026-01-01T00:00:00.000Z',
      });
    });

    it('rejects duplicate creation with different member set', async () => {
      const differentMembers = [
        { userId: 'owner1', role: 'ADMIN' as const },
        { userId: 'user2', role: 'MEMBER' as const }, // different member
      ];
      await expect(
        createGroupRoom({
          roomId: 'neg-group-1',
          createdBy: 'owner1',
          name: 'Team Alpha',
          members: differentMembers,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects duplicate creation with different member count', async () => {
      const moreMembers = [...baseMembers, { userId: 'user3', role: 'MEMBER' as const }];
      await expect(
        createGroupRoom({
          roomId: 'neg-group-1',
          createdBy: 'owner1',
          name: 'Team Alpha',
          members: moreMembers,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects duplicate creation with different member role', async () => {
      const changedRoles = [
        { userId: 'owner1', role: 'ADMIN' as const },
        { userId: 'user1', role: 'ADMIN' as const }, // changed from MEMBER to ADMIN
      ];
      await expect(
        createGroupRoom({
          roomId: 'neg-group-1',
          createdBy: 'owner1',
          name: 'Team Alpha',
          members: changedRoles,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects duplicate creation with different creator', async () => {
      await expect(
        createGroupRoom({
          roomId: 'neg-group-1',
          createdBy: 'imposter', // different creator
          name: 'Team Alpha',
          members: baseMembers,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects duplicate creation with different name', async () => {
      await expect(
        createGroupRoom({
          roomId: 'neg-group-1',
          createdBy: 'owner1',
          name: 'Completely Different Name',
          members: baseMembers,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('membership management (addMember & removeMember)', () => {
    const roomId = 'manage-group-1';
    const adminUser = 'admin-mgr';
    const regularMember = 'reg-mgr';
    const newUser = 'new-user-mgr';

    beforeAll(async () => {
      await ensureUserProfile({ userId: adminUser, email: `${adminUser}@example.com` });
      await ensureUserProfile({ userId: regularMember, email: `${regularMember}@example.com` });
      await ensureUserProfile({ userId: newUser, email: `${newUser}@example.com` });

      await createGroupRoom({
        roomId,
        createdBy: adminUser,
        name: 'Membership Test Room',
        members: [
          { userId: adminUser, role: 'ADMIN' },
          { userId: regularMember, role: 'MEMBER' },
        ],
      });
    });

    it('allows an ADMIN to add a new member, updating memberCount', async () => {
      const result = await addMember({
        roomId,
        userId: newUser,
        role: 'MEMBER',
        addedBy: adminUser,
      });

      expect(result.member.userId).toBe(newUser);
      expect(result.member.role).toBe('MEMBER');
      expect(await isMember(newUser, roomId)).toBe(true);

      const room = await getRoom(roomId, true);
      expect(room?.memberCount).toBe(3);
    });

    it('rejects adding a member if requester is not an ADMIN', async () => {
      await expect(
        addMember({
          roomId,
          userId: 'random-user',
          addedBy: regularMember,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('rejects adding an already existing member with ConflictError', async () => {
      await expect(
        addMember({
          roomId,
          userId: newUser,
          addedBy: adminUser,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects adding a user who does not exist with NotFoundError', async () => {
      await expect(
        addMember({
          roomId,
          userId: 'non-existent-user-id',
          addedBy: adminUser,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects removing another member if requester is not an ADMIN', async () => {
      await expect(
        removeMember({
          roomId,
          userId: newUser,
          removedBy: regularMember,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('allows an ADMIN to remove another member, decrementing memberCount', async () => {
      const result = await removeMember({
        roomId,
        userId: newUser,
        removedBy: adminUser,
      });

      expect(result.success).toBe(true);
      expect(await isMember(newUser, roomId)).toBe(false);

      const room = await getRoom(roomId, true);
      expect(room?.memberCount).toBe(2);
    });

    it('allows a member to leave the room (self-removal)', async () => {
      const result = await removeMember({
        roomId,
        userId: regularMember,
        removedBy: regularMember,
      });

      expect(result.success).toBe(true);
      expect(await isMember(regularMember, roomId)).toBe(false);

      const room = await getRoom(roomId, true);
      expect(room?.memberCount).toBe(1);
    });

    it('rejects removing the last remaining member of a group room', async () => {
      await expect(
        removeMember({
          roomId,
          userId: adminUser,
          removedBy: adminUser,
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe('membership concurrency and authorization guarantees', () => {
    const concAdmin = 'conc-admin';
    const concMember1 = 'conc-member-1';
    const concMember2 = 'conc-member-2';
    const concCandidate = 'conc-candidate';
    const concOutsider = 'conc-outsider';

    beforeAll(async () => {
      await ensureUserProfile({ userId: concAdmin, email: `${concAdmin}@example.com` });
      await ensureUserProfile({ userId: concMember1, email: `${concMember1}@example.com` });
      await ensureUserProfile({ userId: concMember2, email: `${concMember2}@example.com` });
      await ensureUserProfile({ userId: concCandidate, email: `${concCandidate}@example.com` });
      await ensureUserProfile({ userId: concOutsider, email: `${concOutsider}@example.com` });
    });

    it('handles concurrent attempts to add the same member safely without inconsistent counts', async () => {
      const concRoomId = 'conc-add-room';
      await createGroupRoom({
        roomId: concRoomId,
        createdBy: concAdmin,
        name: 'Concurrent Add Room',
        members: [
          { userId: concAdmin, role: 'ADMIN' },
          { userId: concMember1, role: 'MEMBER' },
        ],
      });

      // 5 concurrent attempts to add concCandidate
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          addMember({
            roomId: concRoomId,
            userId: concCandidate,
            addedBy: concAdmin,
          }),
        ),
      );

      const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
      const rejected = attempts.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
      }

      // Member count should be incremented exactly once (from 2 to 3)
      const room = await getRoom(concRoomId, true);
      expect(room?.memberCount).toBe(3);
      expect(await isMember(concCandidate, concRoomId)).toBe(true);
    });

    it('handles concurrent attempts to remove the same member safely', async () => {
      const concRoomId = 'conc-add-room'; // now has concAdmin, concMember1, concCandidate (3 members)

      // 5 concurrent attempts to remove concCandidate
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          removeMember({
            roomId: concRoomId,
            userId: concCandidate,
            removedBy: concAdmin,
          }),
        ),
      );

      const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
      const rejected = attempts.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundError);
      }

      // Member count should be decremented exactly once (from 3 to 2)
      const room = await getRoom(concRoomId, true);
      expect(room?.memberCount).toBe(2);
      expect(await isMember(concCandidate, concRoomId)).toBe(false);
    });

    it('prevents removing the last member during concurrent self-removal requests', async () => {
      const raceRoomId = 'last-member-race-room';
      await createGroupRoom({
        roomId: raceRoomId,
        createdBy: concMember1,
        name: 'Last Member Race',
        members: [
          { userId: concMember1, role: 'ADMIN' },
          { userId: concMember2, role: 'MEMBER' },
        ],
      });

      // Both members attempt self-removal concurrently
      const attempts = await Promise.allSettled([
        removeMember({ roomId: raceRoomId, userId: concMember1, removedBy: concMember1 }),
        removeMember({ roomId: raceRoomId, userId: concMember2, removedBy: concMember2 }),
      ]);

      const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
      const rejected = attempts.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestError);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
        /Cannot remove the last (member|admin)/,
      );

      // Exactly 1 member remains, and memberCount is exactly 1 (never 0)
      const room = await getRoom(raceRoomId, true);
      expect(room?.memberCount).toBe(1);
    });

    it('enforces admin-only add and remove permissions and rejects nonmembers', async () => {
      const authRoomId = 'auth-check-room';
      await createGroupRoom({
        roomId: authRoomId,
        createdBy: concAdmin,
        name: 'Auth Room',
        members: [
          { userId: concAdmin, role: 'ADMIN' },
          { userId: concMember1, role: 'MEMBER' },
        ],
      });

      // 1. Non-admin cannot add member
      await expect(
        addMember({
          roomId: authRoomId,
          userId: concCandidate,
          addedBy: concMember1,
        }),
      ).rejects.toThrow('Only room admins can add members');

      // 2. Non-admin cannot remove other members
      await expect(
        removeMember({
          roomId: authRoomId,
          userId: concAdmin,
          removedBy: concMember1,
        }),
      ).rejects.toThrow('Only room admins can remove other members');

      // 3. Outsider cannot add or remove
      await expect(
        addMember({
          roomId: authRoomId,
          userId: concCandidate,
          addedBy: concOutsider,
        }),
      ).rejects.toThrow('Only room admins can add members');

      await expect(
        removeMember({
          roomId: authRoomId,
          userId: concMember1,
          removedBy: concOutsider,
        }),
      ).rejects.toThrow('You are not a member of this room');

      // 4. Regular member can self-leave
      const leaveResult = await removeMember({
        roomId: authRoomId,
        userId: concMember1,
        removedBy: concMember1,
      });
      expect(leaveResult.success).toBe(true);
      expect(await isMember(concMember1, authRoomId)).toBe(false);
    });

    it('prevents addMember from succeeding if admin privileges are revoked or admin leaves concurrently (stale authorization)', async () => {
      const staleAuthRoomId = 'stale-auth-room';
      const adminA = 'stale-admin-a';
      const adminB = 'stale-admin-b';
      const candidateUser = 'stale-candidate';

      await ensureUserProfile({ userId: adminA, email: `${adminA}@example.com` });
      await ensureUserProfile({ userId: adminB, email: `${adminB}@example.com` });
      await ensureUserProfile({ userId: candidateUser, email: `${candidateUser}@example.com` });

      await createGroupRoom({
        roomId: staleAuthRoomId,
        createdBy: adminA,
        name: 'Stale Auth Room',
        members: [
          { userId: adminA, role: 'ADMIN' },
          { userId: adminB, role: 'ADMIN' },
        ],
        validateUsers: true,
      });

      // Admin B removes Admin A
      await removeMember({
        roomId: staleAuthRoomId,
        userId: adminA,
        removedBy: adminB,
      });

      // Admin A attempts to add candidate after removal -> rejected
      await expect(
        addMember({
          roomId: staleAuthRoomId,
          userId: candidateUser,
          addedBy: adminA,
        }),
      ).rejects.toThrow('Only room admins can add members');

      // Candidate was not added and memberCount remains 1
      expect(await isMember(candidateUser, staleAuthRoomId)).toBe(false);
      const room = await getRoom(staleAuthRoomId, true);
      expect(room?.memberCount).toBe(1);
    });
  });

  describe('rooms HTTP API endpoints', () => {
    let createdRoomId: string;
    const httpAdmin = 'http-admin-1';
    const httpMember = 'http-member-2';
    const httpStranger = 'http-stranger-3';
    const httpNewbie = 'http-newbie-4';

    beforeAll(async () => {
      await ensureUserProfile({ userId: httpAdmin, email: `${httpAdmin}@example.com` });
      await ensureUserProfile({ userId: httpMember, email: `${httpMember}@example.com` });
      await ensureUserProfile({ userId: httpStranger, email: `${httpStranger}@example.com` });
      await ensureUserProfile({ userId: httpNewbie, email: `${httpNewbie}@example.com` });
    });

    it('POST /rooms creates a group room and assigns creator as ADMIN', async () => {
      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms',
        userId: httpAdmin,
        body: JSON.stringify({
          name: 'HTTP Team Room',
          members: [{ userId: httpMember, role: 'MEMBER' }],
        }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      expect(body.roomId).toBeDefined();
      expect(body.name).toBe('HTTP Team Room');
      expect(body.createdBy).toBe(httpAdmin);
      expect(body.memberCount).toBe(2);

      createdRoomId = body.roomId;
    });

    it('POST /rooms rejects creation if any requested member does not exist in users', async () => {
      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms',
        userId: httpAdmin,
        body: JSON.stringify({
          name: 'Invalid Room',
          members: [{ userId: 'ghost-member-999', role: 'MEMBER' }],
        }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toMatch(/does not exist/);
    });

    it('POST /rooms rejects creation when duplicate members are provided', async () => {
      const event = createHttpEvent({
        method: 'POST',
        rawPath: '/rooms',
        userId: httpAdmin,
        body: JSON.stringify({
          name: 'Duplicate Member Room',
          members: [
            { userId: httpMember, role: 'MEMBER' },
            { userId: httpMember, role: 'MEMBER' },
          ],
        }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('Duplicate member');
    });

    it('GET /rooms lists the user conversations and group rooms (AP6)', async () => {
      const event = createHttpEvent({
        method: 'GET',
        rawPath: '/rooms',
        userId: httpAdmin,
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.items.length).toBeGreaterThanOrEqual(1);
      const match = body.items.find((r: { roomId: string }) => r.roomId === createdRoomId);
      expect(match).toBeDefined();
      expect(match.role).toBe('ADMIN');
    });

    it('GET /rooms/{roomId} returns room details for an active member', async () => {
      const event = createHttpEvent({
        method: 'GET',
        rawPath: `/rooms/${createdRoomId}`,
        pathParameters: { roomId: createdRoomId },
        userId: httpMember,
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.roomId).toBe(createdRoomId);
      expect(body.name).toBe('HTTP Team Room');
    });

    it('GET /rooms/{roomId} rejects non-members with 403 Forbidden', async () => {
      const event = createHttpEvent({
        method: 'GET',
        rawPath: `/rooms/${createdRoomId}`,
        pathParameters: { roomId: createdRoomId },
        userId: httpStranger,
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toBe('You are not a member of this room');
    });

    it('POST /rooms/{roomId}/members allows ADMIN to add a new member', async () => {
      const event = createHttpEvent({
        method: 'POST',
        rawPath: `/rooms/${createdRoomId}/members`,
        pathParameters: { roomId: createdRoomId },
        userId: httpAdmin,
        body: JSON.stringify({ userId: httpNewbie, role: 'MEMBER' }),
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.member.userId).toBe(httpNewbie);
      expect(body.member.role).toBe('MEMBER');
    });

    it('GET /rooms/{roomId}/members queries room members via GSI1 (AP7)', async () => {
      // Poll GSI1 until the newly added member appears
      const members = await pollUntil(
        () => listRoomMembers(createdRoomId),
        (m) => m.length === 3,
        { description: 'GSI1 members replication in integration test' },
      );
      expect(members.map((m) => m.userId).sort()).toEqual(
        [httpAdmin, httpMember, httpNewbie].sort(),
      );

      const event = createHttpEvent({
        method: 'GET',
        rawPath: `/rooms/${createdRoomId}/members`,
        pathParameters: { roomId: createdRoomId },
        userId: httpMember,
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items.length).toBe(3);
    });

    it('GET /rooms/{roomId}/members rejects nonmembers with 403 Forbidden', async () => {
      const event = createHttpEvent({
        method: 'GET',
        rawPath: `/rooms/${createdRoomId}/members`,
        pathParameters: { roomId: createdRoomId },
        userId: httpStranger,
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toBe('You are not a member of this room');
    });

    it('DELETE /rooms/{roomId}/members/{userId} allows member to leave', async () => {
      const event = createHttpEvent({
        method: 'DELETE',
        rawPath: `/rooms/${createdRoomId}/members/${httpNewbie}`,
        pathParameters: { roomId: createdRoomId, userId: httpNewbie },
        userId: httpNewbie,
      });

      const res = (await roomsHandler(event, mockContext, mockCallback)) as HttpResponse;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).message).toBe('Member removed successfully');

      expect(await isMember(httpNewbie, createdRoomId)).toBe(false);
    });

    it('rejects adding or removing members in a direct (1:1) chat room', async () => {
      const direct = await createDirectRoom({ userA: 'alice', userB: 'bob', now: now() });
      await expect(
        addMember({
          roomId: direct.room.roomId,
          userId: 'carol',
          addedBy: 'alice',
        }),
      ).rejects.toBeInstanceOf(BadRequestError);

      await expect(
        removeMember({
          roomId: direct.room.roomId,
          userId: 'bob',
          removedBy: 'alice',
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it('guarantees memberCount always matches actual membership records in DynamoDB', async () => {
      const auditRoomId = 'audit-count-room';
      await createGroupRoom({
        roomId: auditRoomId,
        createdBy: httpAdmin,
        name: 'Audit Count Room',
        members: [
          { userId: httpAdmin, role: 'ADMIN' },
          { userId: httpMember, role: 'MEMBER' },
        ],
        validateUsers: true,
      });

      // 1. Initial creation: 2 members
      let room = await getRoom(auditRoomId, true);
      let members = await pollUntil(
        () => listRoomMembers(auditRoomId),
        (m) => m.length === 2,
        { description: 'GSI1 members after creation' },
      );
      expect(room?.memberCount).toBe(2);
      expect(members).toHaveLength(2);

      // 2. Add 1 member -> 3 members
      await addMember({ roomId: auditRoomId, userId: httpNewbie, addedBy: httpAdmin });
      room = await getRoom(auditRoomId, true);
      members = await pollUntil(
        () => listRoomMembers(auditRoomId),
        (m) => m.length === 3,
        { description: 'GSI1 members after addMember' },
      );
      expect(room?.memberCount).toBe(3);
      expect(members).toHaveLength(3);

      // 3. Remove 1 member -> 2 members
      await removeMember({ roomId: auditRoomId, userId: httpNewbie, removedBy: httpAdmin });
      room = await getRoom(auditRoomId, true);
      members = await pollUntil(
        () => listRoomMembers(auditRoomId),
        (m) => m.length === 2,
        { description: 'GSI1 members after removeMember' },
      );
      expect(room?.memberCount).toBe(2);
      expect(members).toHaveLength(2);
    });
  });
});
