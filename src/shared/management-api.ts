import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { getConnectionOwner, removeConnection } from '../repositories';
import { logger } from './logger';

let injectedClient: ApiGatewayManagementApiClient | undefined;
const clientCache = new Map<string, ApiGatewayManagementApiClient>();

/**
 * Returns a cached ApiGatewayManagementApiClient instance for the target endpoint,
 * falling back to process.env.API_GATEWAY_MANAGEMENT_ENDPOINT if no endpoint is supplied.
 *
 * If a custom client was injected via `setManagementApiClient()`, that client is returned instead.
 * Instances are cached by resolved endpoint so different endpoints do not share clients.
 */
export function getManagementApiClient(endpoint?: string): ApiGatewayManagementApiClient {
  if (injectedClient) {
    return injectedClient;
  }

  const targetEndpoint = endpoint || process.env.API_GATEWAY_MANAGEMENT_ENDPOINT;
  const cacheKey = targetEndpoint ?? '';

  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new ApiGatewayManagementApiClient({
      endpoint: targetEndpoint,
    });
    clientCache.set(cacheKey, client);
  }

  return client;
}

/**
 * Injects a custom or mock ApiGatewayManagementApiClient (e.g. for testing).
 * Passing `undefined` clears the override and restores normal client creation and caching.
 */
export function setManagementApiClient(client: ApiGatewayManagementApiClient | undefined): void {
  injectedClient = client;
}

/**
 * Clears the endpoint-keyed client cache and resets any injected client.
 * Primarily intended for test teardown.
 */
export function resetManagementApiClients(): void {
  injectedClient = undefined;
  clientCache.clear();
}

export interface PostToConnectionInput {
  connectionId: string;
  payload: unknown;
  endpoint?: string;
  userId?: string;
  autoPrune?: boolean;
  client?: ApiGatewayManagementApiClient;
}

/**
 * Sends a message payload to an active WebSocket connection.
 * If API Gateway returns 410 GoneException, the connection is considered dead
 * and is automatically pruned from DynamoDB to prevent future wasted calls.
 *
 * @returns true if delivered successfully, false if connection is gone (410).
 */
export async function postToConnection(input: PostToConnectionInput): Promise<boolean> {
  const { connectionId, payload, endpoint, userId, autoPrune = true, client: customClient } = input;
  const client = customClient || getManagementApiClient(endpoint);
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const binaryData = new TextEncoder().encode(data);

  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: binaryData,
      }),
    );
    return true;
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      statusCode?: number;
      $metadata?: { httpStatusCode?: number };
    };

    const isGone =
      err.name === 'GoneException' ||
      err.statusCode === 410 ||
      err.$metadata?.httpStatusCode === 410;

    if (isGone) {
      logger.warn('Connection gone (410), pruning stale connection', { connectionId, userId });

      if (autoPrune) {
        try {
          const resolvedUserId = userId ?? (await getConnectionOwner(connectionId));
          if (resolvedUserId) {
            await removeConnection({ userId: resolvedUserId, connectionId });
          }
        } catch (cleanupError) {
          logger.warn('Failed to prune stale connection', {
            connectionId,
            error: cleanupError,
          });
        }
      }
      return false;
    }

    logger.error(
      'Failed to post to WebSocket connection',
      error instanceof Error ? error : new Error(String(error)),
      { connectionId },
    );
    throw error;
  }
}
