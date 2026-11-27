import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { ensureUserProfile, registerConnection } from '../../repositories';
import {
  broadcastPresenceChange,
  formatResponse,
  getAuthenticatedUser,
  getWebSocketContext,
  handleError,
  logger,
} from '../../shared';

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext?.connectionId,
    routeKey: '$connect',
  });

  try {
    const { connectionId } = getWebSocketContext(event);
    const { userId, email, username } = getAuthenticatedUser(event);

    const now = event.requestContext.connectedAt
      ? new Date(event.requestContext.connectedAt).toISOString()
      : undefined;

    await ensureUserProfile({
      userId,
      email,
      username,
      now,
    });

    const result = await registerConnection({
      userId,
      connectionId,
      now,
    });

    if (result.becameOnline && process.env.API_GATEWAY_MANAGEMENT_ENDPOINT) {
      try {
        await broadcastPresenceChange({
          userId,
          status: 'online',
          lastSeenAt: now ?? new Date().toISOString(),
          excludeConnectionId: connectionId,
        });
      } catch (presenceError) {
        log.warn('Failed to broadcast online presence on $connect', {
          userId,
          error: presenceError instanceof Error ? presenceError.message : String(presenceError),
        });
      }
    }

    log.info('WebSocket client connected', {
      userId,
      duplicate: !result.registered,
    });

    return formatResponse(200, 'Connected');
  } catch (error) {
    return handleError(error, log);
  }
};
