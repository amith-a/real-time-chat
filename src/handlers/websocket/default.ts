import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import {
  formatResponse,
  getRouteKey,
  getWebSocketContext,
  handleError,
  logger,
} from '../../shared';

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext.connectionId,
    routeKey: getRouteKey(event),
  });

  try {
    getWebSocketContext(event);

    log.warn('Unhandled WebSocket route invocation');

    return formatResponse(200, {
      message: 'Unknown action',
    });
  } catch (error) {
    return handleError(error, log);
  }
};
