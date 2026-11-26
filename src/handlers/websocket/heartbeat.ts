import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { getConnectionOwner, updateHeartbeat } from '../../repositories';
import {
  BadRequestError,
  formatResponse,
  getWebSocketContext,
  HEARTBEAT_INTERVAL_MS,
  type HeartbeatAckPayload,
  handleError,
  heartbeatSchema,
  logger,
  parseJsonBody,
} from '../../shared';

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext?.connectionId,
    routeKey: event.requestContext?.routeKey || 'heartbeat',
  });

  try {
    const { connectionId } = getWebSocketContext(event);

    const rawBody = parseJsonBody<unknown>(event);
    const parseResult = heartbeatSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => i.message).join('; ');
      throw new BadRequestError(`Validation failed: ${issues}`);
    }

    const now = new Date().toISOString();
    const userId = await getConnectionOwner(connectionId);
    const updated = userId ? await updateHeartbeat(userId, connectionId, now) : false;

    const ack: HeartbeatAckPayload = {
      action: 'heartbeatAck',
      status: updated ? 'ok' : 'reconnect',
      timestamp: now,
      nextHeartbeatMs: HEARTBEAT_INTERVAL_MS,
    };

    if (!updated) {
      log.warn('Heartbeat received for untracked or swept connection', { userId });
    } else {
      log.debug('Heartbeat recorded', { userId });
    }

    return formatResponse(200, ack);
  } catch (error) {
    return handleError(error, log);
  }
};
