import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureUserProfile,
  getUserByEmail,
  getUserProfile,
  listUsers,
  putUserProfile,
} from '../../src/repositories';
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
});
