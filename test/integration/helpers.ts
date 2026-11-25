import { randomUUID } from 'node:crypto';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { resetDocClient } from '../../src/repositories/client';

let sharedRawClient: DynamoDBClient | undefined;

/**
 * Returns the configured DYNAMODB_ENDPOINT or throws a clear error if missing.
 * Integration tests must not run or silently pass without an explicit endpoint.
 */
export function requireEndpoint(): string {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'DYNAMODB_ENDPOINT environment variable is required to run integration tests (e.g. DYNAMODB_ENDPOINT=http://localhost:8000). Start DynamoDB Local via "docker compose up -d" before running integration tests.',
    );
  }
  return endpoint;
}

/** Reuses a single DynamoDBClient instance across table operations. */
export function getRawClient(): DynamoDBClient {
  if (!sharedRawClient) {
    const endpoint = requireEndpoint();
    sharedRawClient = new DynamoDBClient({
      region: 'ap-south-1',
      endpoint,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
  }
  return sharedRawClient;
}

/** Destroys the shared DynamoDB client and resets repository DocumentClient. */
export function closeClients(): void {
  if (sharedRawClient) {
    sharedRawClient.destroy();
    sharedRawClient = undefined;
  }
  resetDocClient();
}

/**
 * Bounded polling helper for eventually consistent DynamoDB reads (e.g. GSIs or Table Status).
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const { timeoutMs = 4000, intervalMs = 50, description = 'condition' } = options;
  const start = Date.now();
  let lastVal: T;
  while (Date.now() - start < timeoutMs) {
    lastVal = await fn();
    if (predicate(lastVal)) {
      return lastVal;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
}

/*
 *  Creates an isolated table with the same schema as infra/core.
 * yaml and waits until it is ACTIVE.
 */
export async function createTestTable(): Promise<string> {
  const name = `test-chat-${randomUUID()}`;
  await getRawClient().send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  // Poll until table and all secondary indexes are ACTIVE before returning
  await pollUntil(
    async () => {
      const desc = await getRawClient().send(new DescribeTableCommand({ TableName: name }));
      const tableActive = desc.Table?.TableStatus === 'ACTIVE';
      const gsis = desc.Table?.GlobalSecondaryIndexes ?? [];
      const gsisActive = gsis.every((g) => g.IndexStatus === 'ACTIVE');
      return tableActive && gsisActive;
    },
    (ready) => ready,
    { timeoutMs: 10000, intervalMs: 50, description: `table ${name} and GSI1 to become ACTIVE` },
  );

  process.env.TABLE_NAME = name;
  resetDocClient();
  return name;
}

export async function deleteTestTable(name: string): Promise<void> {
  await getRawClient().send(new DeleteTableCommand({ TableName: name }));
}

/** Safely deletes the table and always ensures clients are closed in a finally block. */
export async function safeTeardown(name: string): Promise<void> {
  try {
    await deleteTestTable(name);
  } finally {
    closeClients();
  }
}

export const now = (): string => new Date().toISOString();
