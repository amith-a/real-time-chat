import { type DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConnectionOwner,
  resetDocClient,
  resetTableName,
  setDocClient,
  setTableName,
} from '../src/repositories';

describe('Connections Repository (getConnectionOwner)', () => {
  const mockSend = vi.fn();
  const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;

  beforeEach(() => {
    mockSend.mockReset();
    setDocClient(mockDocClient);
    setTableName('TestChatTable');
  });

  afterEach(() => {
    resetDocClient();
    resetTableName();
  });

  it('uses a strongly consistent DynamoDB read (ConsistentRead: true)', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        PK: 'CONN#conn-123',
        SK: 'OWNER',
        userId: 'user-alice',
      },
    });

    const owner = await getConnectionOwner('conn-123');

    expect(owner).toBe('user-alice');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(GetCommand);
    expect(cmd.input).toEqual({
      TableName: 'TestChatTable',
      Key: { PK: 'CONN#conn-123', SK: 'OWNER' },
      ConsistentRead: true,
    });
  });

  it('returns undefined when owner item does not exist', async () => {
    mockSend.mockResolvedValueOnce({});

    const owner = await getConnectionOwner('conn-missing');

    expect(owner).toBeUndefined();
  });
});
