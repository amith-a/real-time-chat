import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getUserProfile, putUserProfile } from '../../src/repositories';
import { createTestTable, safeTeardown } from './helpers';

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
});
