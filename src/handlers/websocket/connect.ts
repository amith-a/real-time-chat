import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { registerConnection } from '../../repositories';
import {
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
    const { userId, email } = getAuthenticatedUser(event);

    if (process.env.TABLE_NAME) {
      const now = event.requestContext.connectedAt
        ? new Date(event.requestContext.connectedAt).toISOString()
        : undefined;

      const result = await registerConnection({
        userId,
        connectionId,
        now,
      });

      log.info('WebSocket client connected', {
        userId,
        email,
        duplicate: !result.registered,
      });
    } else {
      log.info('WebSocket client connected', { userId, email });
    }

    return formatResponse(200, 'Connected');
  } catch (error) {
    return handleError(error, log);
  }
};
