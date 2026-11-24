import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handler as usersHttpHandler } from '../../src/handlers/http/users';
import {
  ensureUserProfile,
  getUserByEmail,
  getUserProfile,
  listUsers,
  putUserProfile,
  searchUsers,
} from '../../src/repositories';
import type { HttpResponse } from '../../src/shared';
import { createTestTable, pollUntil, safeTeardown } from './helpers';

describe('user profiles (DynamoDB Local)', () => {
  let table: string;
  beforeAll(async () => {
    table = await createTestTable();
  });
  afterAll(async () => {
    await safeTeardown(table);
  });

  it('saves and retrieves user profile, replacing omitted attributes', async () => {
    await putUserProfile('u100', {
      displayName: 'Alice',
      email: 'alice@example.com',
      avatarUrl: 'https://example.com/pic.png',
    });
    const profile1 = await getUserProfile('u100');
    expect(profile1).toMatchObject({
      userId: 'u100',
      displayName: 'Alice',
      email: 'alice@example.com',
      avatarUrl: 'https://example.com/pic.png',
    });

    // Update profile omitting avatarUrl
    await putUserProfile('u100', { displayName: 'Alice Updated', email: 'alice@example.com' });
    const profile2 = await getUserProfile('u100');
    expect(profile2).toMatchObject({
      userId: 'u100',
      displayName: 'Alice Updated',
      email: 'alice@example.com',
    });
    expect(profile2?.avatarUrl).toBeUndefined();
  });

  it('ensureUserProfile creates on first call and idempotently updates without losing createdAt', async () => {
    const t0 = '2026-01-01T10:00:00.000Z';
    const t1 = '2026-01-01T10:30:00.000Z';

    // 1. Initial creation (e.g. first WebSocket connect)
    const initial = await ensureUserProfile({
      userId: 'u200',
      email: 'bob@example.com',
      username: 'bob200',
      displayName: 'Bob Original',
      now: t0,
    });

    expect(initial).toMatchObject({
      userId: 'u200',
      email: 'bob@example.com',
      username: 'bob200',
      displayName: 'Bob Original',
      createdAt: t0,
      updatedAt: t0,
      GSI1PK: 'USERS',
      GSI1SK: 'EMAIL#bob@example.com',
    });

    // 2. Re-connect later with updated email
    const updated = await ensureUserProfile({
      userId: 'u200',
      email: 'bob.new@example.com',
      now: t1,
    });

    expect(updated).toMatchObject({
      userId: 'u200',
      email: 'bob.new@example.com',
      username: 'bob200', // preserved
      displayName: 'Bob Original', // preserved
      createdAt: t0, // preserved!
      updatedAt: t1, // updated!
      GSI1PK: 'USERS',
      GSI1SK: 'EMAIL#bob.new@example.com',
    });
  });

  it('looks up users by email via GSI1', async () => {
    await ensureUserProfile({
      userId: 'u300',
      email: 'carol@example.com',
      username: 'carol',
    });

    // Poll GSI1 until indexed
    const found = await pollUntil(
      () => getUserByEmail('CAROL@EXAMPLE.COM'),
      (user) => user?.userId === 'u300',
      { description: 'user indexed by email in GSI1' },
    );

    expect(found).toMatchObject({
      userId: 'u300',
      email: 'carol@example.com',
      username: 'carol',
    });
  });

  it('lists registered users via GSI1', async () => {
    await ensureUserProfile({ userId: 'u401', email: 'dave1@example.com' });
    await ensureUserProfile({ userId: 'u402', email: 'dave2@example.com' });

    const page = await pollUntil(
      () => listUsers({ limit: 50 }),
      (p) => p.items.some((u) => u.userId === 'u401') && p.items.some((u) => u.userId === 'u402'),
      { description: 'users listed in GSI1' },
    );

    expect(page.items.length).toBeGreaterThanOrEqual(2);
  });

  it('searches users by email prefix via GSI1', async () => {
    await ensureUserProfile({
      userId: 'u501',
      email: 'eve.search@example.com',
      username: 'evesearch',
    });
    await ensureUserProfile({
      userId: 'u502',
      email: 'eve.other@example.com',
      username: 'eveother',
    });
    await ensureUserProfile({ userId: 'u503', email: 'frank@example.com', username: 'frank' });

    // Poll until indexed and search by prefix "eve.sea"
    const searchResult = await pollUntil(
      () => searchUsers('eve.sea'),
      (res) => res.items.some((u) => u.userId === 'u501'),
      { description: 'user found by prefix in searchUsers' },
    );

    expect(searchResult.items).toHaveLength(1);
    expect(searchResult.items[0].userId).toBe('u501');
    expect(searchResult.items[0].email).toBe('eve.search@example.com');
  });

  it('executes users HTTP handler end-to-end against DynamoDB Local', async () => {
    await ensureUserProfile({
      userId: 'u601',
      email: 'grace@example.com',
      username: 'grace',
      displayName: 'Grace Hopper',
    });

    const mockEvent = {
      version: '2.0',
      routeKey: 'GET /users/u601',
      rawPath: '/users/u601',
      pathParameters: { userId: 'u601' },
      requestContext: {
        http: { method: 'GET', path: '/users/u601' },
        requestId: 'req-test-1',
        authorizer: {
          jwt: {
            claims: { sub: 'u601', email: 'grace@example.com' },
          },
        },
      },
    } as unknown as Parameters<typeof usersHttpHandler>[0];

    const res = (await usersHttpHandler(mockEvent, {} as never, () => {})) as HttpResponse;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.userId).toBe('u601');
    expect(body.displayName).toBe('Grace Hopper');
  });
});
