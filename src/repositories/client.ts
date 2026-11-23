import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
  ScanCommand,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Page } from './types';

let docClient: DynamoDBDocumentClient | undefined;
let customTableName: string | undefined;

/**
 * Lazily created DocumentClient so module load stays cheap and tests can point
 * at DynamoDB Local or use custom endpoints/clients.
 */
export function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    const endpoint = process.env.DYNAMODB_ENDPOINT;
    const base = new DynamoDBClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-south-1',
      ...(endpoint && {
        endpoint,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }),
    });
    docClient = DynamoDBDocumentClient.from(base, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return docClient;
}

export function setDocClient(client?: DynamoDBDocumentClient): void {
  docClient = client;
}

export function resetDocClient(): void {
  docClient = undefined;
}

export function getTableName(): string {
  const name = customTableName ?? process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not set');
  }
  return name;
}

export function setTableName(name?: string): void {
  customTableName = name;
}

export function resetTableName(): void {
  customTableName = undefined;
}

type QueryParams = Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>;
type ScanParams = Omit<ScanCommandInput, 'TableName' | 'ExclusiveStartKey'>;

/** One page of a Query. The caller decides whether to fetch more. */
export async function queryPage<T>(
  params: QueryParams,
  startKey?: Record<string, unknown>,
): Promise<Page<T>> {
  const out = await getDocClient().send(
    new QueryCommand({
      ...params,
      TableName: getTableName(),
      ExclusiveStartKey: startKey,
    }),
  );
  return { items: (out.Items ?? []) as T[], nextKey: out.LastEvaluatedKey };
}

/** Follows LastEvaluatedKey until the partition range is exhausted. */
export async function queryAll<T>(params: QueryParams, maxPages?: number): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  let pageCount = 0;
  do {
    const page = await queryPage<T>(params, startKey);
    items.push(...page.items);
    startKey = page.nextKey;
    pageCount++;
    if (maxPages !== undefined && pageCount >= maxPages && startKey) {
      throw new Error(`queryAll exceeded maximum page limit of ${maxPages}`);
    }
  } while (startKey);
  return items;
}

/** One page of a Scan. The caller decides whether to fetch more. */
export async function scanPage<T>(
  params: ScanParams,
  startKey?: Record<string, unknown>,
): Promise<Page<T>> {
  const out = await getDocClient().send(
    new ScanCommand({
      ...params,
      TableName: getTableName(),
      ExclusiveStartKey: startKey,
    }),
  );
  return { items: (out.Items ?? []) as T[], nextKey: out.LastEvaluatedKey };
}
