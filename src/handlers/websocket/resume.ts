import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import { getConnectionOwner, isMember, listMessagesAfter } from '../../repositories';
import {
  BadRequestError,
  DEFAULT_DYNAMODB_CONCURRENCY,
  ForbiddenError,
  formatResponse,
  getWebSocketContext,
  handleError,
  logger,
  parseJsonBody,
  pMap,
  type ResumeAckPayload,
  type ResumedRoomMessages,
  resumeSchema,
  UnauthorizedError,
} from '../../shared';

/**
 * WebSocket reconnect catch-up handler (`resume` action).
 * Queries missed messages after `lastSequence` for each requested room using
 * bounded `SK BETWEEN MSG#<N+1> AND MSG#9999999999` range queries.
 */
export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext?.connectionId,
    routeKey: event.requestContext?.routeKey || 'resume',
  });

  try {
    const { connectionId } = getWebSocketContext(event);

    const rawBody = parseJsonBody<unknown>(event);
    const parseResult = resumeSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => i.message).join('; ');
      throw new BadRequestError(`Validation failed: ${issues}`);
    }

    const userId = await getConnectionOwner(connectionId);
    if (!userId) {
      throw new UnauthorizedError('Connection owner could not be resolved; please reconnect');
    }

    const { rooms, limitPerRoom } = parseResult.data;

    // Deduplicate rooms in case a client sends the same roomId twice
    const uniqueRooms = Array.from(new Map(rooms.map((r) => [r.roomId, r])).values());

    // Verify membership for all requested rooms
    const membershipChecks = await pMap(
      uniqueRooms,
      async (r) => ({ roomId: r.roomId, ok: await isMember(userId, r.roomId) }),
      DEFAULT_DYNAMODB_CONCURRENCY,
    );

    const unauthorizedRoom = membershipChecks.find((c) => !c.ok);
    if (unauthorizedRoom) {
      throw new ForbiddenError(`You are not a member of room ${unauthorizedRoom.roomId}`);
    }

    // Fetch missed messages after lastSequence for each room in bounded parallel batches
    const resumedRooms: ResumedRoomMessages[] = await pMap(
      uniqueRooms,
      async ({ roomId, lastSequence }) => {
        const page = await listMessagesAfter(roomId, lastSequence, { limit: limitPerRoom });
        const messages = page.items.map((m) => ({
          messageId: m.clientMessageId,
          roomId: m.roomId,
          sequenceNumber: m.sequenceNumber,
          senderId: m.senderId,
          body: m.content,
          messageType: m.messageType,
          createdAt: m.createdAt,
        }));

        const lastReturnedSeq =
          messages.length > 0 ? messages[messages.length - 1].sequenceNumber : lastSequence;

        return {
          roomId,
          messages,
          hasMore: page.nextKey !== undefined,
          nextAfterSequence: lastReturnedSeq,
        };
      },
      DEFAULT_DYNAMODB_CONCURRENCY,
    );

    const ack: ResumeAckPayload = {
      action: 'resumeAck',
      rooms: resumedRooms,
    };

    log.info('WebSocket resume catch-up complete', {
      userId,
      roomCount: resumedRooms.length,
      totalMessagesReturned: resumedRooms.reduce((sum, r) => sum + r.messages.length, 0),
    });

    return formatResponse(200, ack);
  } catch (error) {
    return handleError(error, log);
  }
};
