import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import {
  getConnectionOwner,
  isMember,
  listRoomMembers,
  listUserConnections,
} from '../../repositories';
import {
  BadRequestError,
  checkConnectionRateLimit,
  DEFAULT_DYNAMODB_CONCURRENCY,
  DEFAULT_GATEWAY_CONCURRENCY,
  ForbiddenError,
  formatResponse,
  getWebSocketContext,
  handleError,
  logger,
  parseJsonBody,
  pMap,
  pMapSettled,
  postToConnection,
  type TypingAckPayload,
  type TypingBroadcastPayload,
  typingSchema,
  UnauthorizedError,
} from '../../shared';

/**
 * Ephemeral typing indicator handler.
 * Never persists typing state to DynamoDB; fans out directly to active room members.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext?.connectionId,
    routeKey: event.requestContext?.routeKey || 'typing',
  });

  try {
    const { connectionId, domainName, stage } = getWebSocketContext(event);

    const maxTypingPerWindow = Number(process.env.TYPING_RATE_LIMIT_MAX ?? 20);
    const rateWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000);
    checkConnectionRateLimit({
      connectionId,
      routeKey: 'typing',
      maxRequests: Number.isFinite(maxTypingPerWindow) ? maxTypingPerWindow : 20,
      windowMs: Number.isFinite(rateWindowMs) ? rateWindowMs : 10_000,
    });

    const rawBody = parseJsonBody<unknown>(event);
    const parseResult = typingSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => i.message).join('; ');
      throw new BadRequestError(`Validation failed: ${issues}`);
    }

    const userId = await getConnectionOwner(connectionId);
    if (!userId) {
      throw new UnauthorizedError('Connection owner could not be resolved; please reconnect');
    }

    const { roomId, isTyping } = parseResult.data;

    const member = await isMember(userId, roomId);
    if (!member) {
      throw new ForbiddenError('You are not a member of this room');
    }

    const members = await listRoomMembers(roomId);
    const memberConnectionLists = await pMap(
      members,
      (m) => listUserConnections(m.userId),
      DEFAULT_DYNAMODB_CONCURRENCY,
    );

    const seenConnections = new Set<string>();
    const destinations: Array<{ connectionId: string; userId: string }> = [];

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      for (const conn of memberConnectionLists[i]) {
        if (conn.connectionId === connectionId) continue;
        if (!seenConnections.has(conn.connectionId)) {
          seenConnections.add(conn.connectionId);
          destinations.push({ connectionId: conn.connectionId, userId: m.userId });
        }
      }
    }

    if (destinations.length > 0) {
      const endpoint =
        process.env.API_GATEWAY_MANAGEMENT_ENDPOINT || `https://${domainName}/${stage}`;
      const payload: TypingBroadcastPayload = {
        action: 'typing',
        roomId,
        userId,
        isTyping,
        timestamp: new Date().toISOString(),
      };

      const deliveryResults = await pMapSettled(
        destinations,
        (dest) =>
          postToConnection({
            connectionId: dest.connectionId,
            userId: dest.userId,
            payload,
            endpoint,
          }),
        DEFAULT_GATEWAY_CONCURRENCY,
      );

      let deliveredCount = 0;
      let staleCount = 0;
      let errorCount = 0;

      for (let i = 0; i < deliveryResults.length; i++) {
        const res = deliveryResults[i];
        if (res.status === 'fulfilled') {
          if (res.value === true) {
            deliveredCount++;
          } else {
            staleCount++;
          }
        } else {
          errorCount++;
          log.warn('Failed to deliver typing indicator to connection', {
            roomId,
            connectionId: destinations[i].connectionId,
            targetUserId: destinations[i].userId,
            error: res.reason instanceof Error ? res.reason.message : String(res.reason),
          });
        }
      }

      log.info('Typing indicator broadcast complete', {
        roomId,
        userId,
        isTyping,
        recipientCount: destinations.length,
        deliveredCount,
        staleCount,
        errorCount,
      });
    }

    const ack: TypingAckPayload = {
      action: 'typingAck',
      roomId,
      isTyping,
    };

    return formatResponse(200, ack);
  } catch (error) {
    return handleError(error, log);
  }
};
