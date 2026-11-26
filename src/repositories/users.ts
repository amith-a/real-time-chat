import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName, queryAll, queryPage } from './client';
import { GSI1_NAME, userGsi1Keys, userKey } from './keys';
import type { IsoTimestamp, Page, UserProfileItem } from './types';

/** AP1: get a user profile by ID. */
export async function getUserProfile(
  userId: string,
  consistent = false,
): Promise<UserProfileItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: userKey(userId),
      ConsistentRead: consistent,
    }),
  );
  return out.Item as UserProfileItem | undefined;
}

/** Lookup user profile by email via GSI1. */
export async function getUserByEmail(email: string): Promise<UserProfileItem | undefined> {
  const normalized = email.trim().toLowerCase();
  const items = await queryAll<UserProfileItem>({
    IndexName: GSI1_NAME,
    KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK = :gsi1sk',
    ExpressionAttributeValues: {
      ':gsi1pk': 'USERS',
      ':gsi1sk': `EMAIL#${normalized}`,
    },
  });
  return items[0];
}

/** List all users via GSI1. */
export function listUsers(
  options: { limit?: number; startKey?: Record<string, unknown> } = {},
): Promise<Page<UserProfileItem>> {
  return queryPage<UserProfileItem>(
    {
      IndexName: GSI1_NAME,
      KeyConditionExpression: 'GSI1PK = :gsi1pk',
      ExpressionAttributeValues: { ':gsi1pk': 'USERS' },
      Limit: options.limit ?? 50,
    },
    options.startKey,
  );
}

/** Search users by email prefix via GSI1. Falls back to listUsers if query is empty. */
export function searchUsers(
  query: string,
  options: { limit?: number; startKey?: Record<string, unknown> } = {},
): Promise<Page<UserProfileItem>> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return listUsers(options);
  }

  return queryPage<UserProfileItem>(
    {
      IndexName: GSI1_NAME,
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: {
        ':gsi1pk': 'USERS',
        ':prefix': `EMAIL#${normalized}`,
      },
      Limit: options.limit ?? 20,
    },
    options.startKey,
  );
}

/**
 * Ensures a user profile exists in DynamoDB (creating it on first connection or refreshing claims).
 * Preserves original createdAt and any custom attributes already stored on the profile.
 */
export async function ensureUserProfile(input: {
  userId: string;
  email?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  now?: IsoTimestamp;
}): Promise<UserProfileItem> {
  const now = input.now ?? new Date().toISOString();
  const normalizedEmail = input.email ? input.email.trim().toLowerCase() : undefined;
  const gsiKeys = userGsi1Keys(input.userId, normalizedEmail);

  const updates: string[] = [
    'createdAt = if_not_exists(createdAt, :now)',
    'userId = if_not_exists(userId, :userId)',
    'updatedAt = :now',
    'GSI1PK = :gsi1pk',
  ];
  const values: Record<string, unknown> = {
    ':now': now,
    ':userId': input.userId,
    ':gsi1pk': gsiKeys.GSI1PK,
    ':gsi1sk': gsiKeys.GSI1SK,
  };

  if (normalizedEmail) {
    updates.push('GSI1SK = :gsi1sk');
    updates.push('email = :email');
    values[':email'] = normalizedEmail;
  } else {
    // Preserve any existing EMAIL# GSI1SK when email claim is omitted on reconnect.
    updates.push('GSI1SK = if_not_exists(GSI1SK, :gsi1sk)');
  }
  if (input.username) {
    updates.push('username = :username');
    values[':username'] = input.username;
  }
  if (input.displayName) {
    updates.push('displayName = :displayName');
    values[':displayName'] = input.displayName;
  }
  if (input.avatarUrl) {
    updates.push('avatarUrl = :avatarUrl');
    values[':avatarUrl'] = input.avatarUrl;
  }

  const out = await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: userKey(input.userId),
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );

  return out.Attributes as UserProfileItem;
}

/**
 * Full replacement of the user profile item. Replaces all non-key attributes.
 * Note: Uses PutItem, so any existing attributes not included in `attributes` are removed.
 */
export async function putUserProfile(
  userId: string,
  attributes: Record<string, unknown> = {},
): Promise<UserProfileItem> {
  const email =
    typeof attributes.email === 'string' ? attributes.email.trim().toLowerCase() : undefined;
  const gsiKeys = userGsi1Keys(userId, email);

  const item: UserProfileItem = {
    ...attributes,
    ...userKey(userId),
    ...gsiKeys,
    userId,
    ...(email && { email }),
  };
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item,
    }),
  );
  return item;
}
