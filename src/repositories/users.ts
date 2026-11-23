import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, getTableName } from './client';
import { userKey } from './keys';
import type { UserProfileItem } from './types';

/** AP1: get a user profile. */
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

/**
 * Full replacement of the user profile item. Replaces all non-key attributes.
 * Note: Uses PutItem, so any existing attributes not included in `attributes` are removed.
 */
export async function putUserProfile(
  userId: string,
  attributes: Record<string, unknown> = {},
): Promise<UserProfileItem> {
  const item: UserProfileItem = {
    ...attributes,
    ...userKey(userId),
    userId,
  };
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item,
    }),
  );
  return item;
}

/** @deprecated Use putUserProfile instead to be explicit that this is a full replacement. */
export const saveUserProfile = putUserProfile;
