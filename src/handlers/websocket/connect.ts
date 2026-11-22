import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { formatResponse, getWebSocketContext, handleError, logger } from '../../shared';

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext.connectionId,
    routeKey: '$connect',
  });

  try {
    getWebSocketContext(event);

    log.info('WebSocket client connected');

    return formatResponse(200, 'Connected');
  } catch (error) {
    return handleError(error, log);
  }
};
