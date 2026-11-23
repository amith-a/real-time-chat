import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDirectRoom,
  createGroupRoom,
  directRoomId,
  getMembership,
  isMember,
  listRoomMembers,
  listRoomsForUser,
} from '../../src/repositories';
import { InternalServerError } from '../../src/shared/errors';
import { createTestTable, now, pollUntil, safeTeardown } from './helpers';

describe('rooms (DynamoDB Local)', () => {
  let table: string;
  beforeAll(async () => {
    table = await createTestTable();
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
      ).rejects.toBeInstanceOf(InternalServerError);
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
      ).rejects.toBeInstanceOf(InternalServerError);
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
      ).rejects.toBeInstanceOf(InternalServerError);
    });

    it('rejects duplicate creation with different creator', async () => {
      await expect(
        createGroupRoom({
          roomId: 'neg-group-1',
          createdBy: 'imposter', // different creator
          name: 'Team Alpha',
          members: baseMembers,
        }),
      ).rejects.toBeInstanceOf(InternalServerError);
    });

    it('rejects duplicate creation with different name', async () => {
      await expect(
        createGroupRoom({
          roomId: 'neg-group-1',
          createdBy: 'owner1',
          name: 'Completely Different Name',
          members: baseMembers,
        }),
      ).rejects.toBeInstanceOf(InternalServerError);
    });
  });
});
