import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { getConnectionOwner, removeConnection } from '../../repositories';
import {
  formatResponse,
  getAuthorizerUser,
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
        const authorizerUser = getAuthorizerUser(event);
        let userId = authorizerUser?.userId;

        if (!userId) {
          userId = await getConnectionOwner(connectionId);
        }

        if (userId) {
          await removeConnection({ userId, connectionId });
        } else {
          log.warn('Unable to resolve owner for disconnected connection', { connectionId });
        }
      } catch (dbError) {
        // If removeConnection exhausts its retries on TransactionConflict or transient errors,
        // log the error and leave cleanup to the sweeper, because API Gateway ignores $disconnect responses.
        log.warn('Failed to remove connection during $disconnect; leaving to sweeper', {
          connectionId,
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }
    }

    return formatResponse(200, 'Disconnected');
  } catch (error) {
    return handleError(error, log);
  }
};
