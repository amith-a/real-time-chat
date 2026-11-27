import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { getConnectionOwner, getPresence, removeConnection } from '../../repositories';
import {
  broadcastPresenceChange,
  formatResponse,
  getWebSocketContext,
  handleError,
  logger,
} from '../../shared';

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext.connectionId,
    routeKey: '$disconnect',
  });

  try {
    const { connectionId } = getWebSocketContext(event);

    log.info('WebSocket client disconnected');

    // Only attempt database cleanup if TABLE_NAME is configured
    if (process.env.TABLE_NAME) {
      try {
        const userId = await getConnectionOwner(connectionId);

        if (userId) {
          const removeResult = await removeConnection({ userId, connectionId });

          if (removeResult === 'REMOVED' && process.env.API_GATEWAY_MANAGEMENT_ENDPOINT) {
            try {
              const presence = await getPresence(userId, true);
              if (!presence.online) {
                await broadcastPresenceChange({
                  userId,
                  status: 'offline',
                  lastSeenAt: presence.lastSeenAt ?? new Date().toISOString(),
                });
              }
            } catch (presenceError) {
              log.warn('Failed to broadcast offline presence on $disconnect', {
                userId,
                error:
                  presenceError instanceof Error ? presenceError.message : String(presenceError),
              });
            }
          }
        } else {
          log.warn('Unable to resolve owner for disconnected connection', { connectionId });
        }
      } catch (dbError) {
        // If removeConnection exhausts its retries on TransactionConflict or transient errors,
        // log the error and leave cleanup to the sweeper, because API Gateway ignores $disconnect responses.
        log.error(
          'Failed to remove connection during $disconnect; leaving to sweeper',
          dbError instanceof Error ? dbError : new Error(String(dbError)),
          { connectionId },
        );
      }
    }

    return formatResponse(200, 'Disconnected');
  } catch (error) {
    return handleError(error, log);
  }
};
