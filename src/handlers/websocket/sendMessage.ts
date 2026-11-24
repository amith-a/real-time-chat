import type { APIGatewayProxyWebsocketHandlerV2 } from 'aws-lambda';
import {
  createDirectRoom,
  createMessage,
  directRoomId,
  getUserProfile,
  isMember,
  listRoomMembers,
  listUserConnections,
} from '../../repositories';
import {
  BadRequestError,
  ForbiddenError,
  formatResponse,
  getAuthenticatedUser,
  getWebSocketContext,
  handleError,
  logger,
  type MessageAckPayload,
  type MessageDeliveryPayload,
  parseJsonBody,
  postToConnection,
  type SendMessageInput,
  sendMessageSchema,
} from '../../shared';

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const log = logger.withContext({
    connectionId: event.requestContext?.connectionId,
    routeKey: event.requestContext?.routeKey || 'sendMessage',
  });

  try {
    const { connectionId, domainName, stage } = getWebSocketContext(event);
    const { userId: senderId } = getAuthenticatedUser(event);

    const rawBody = parseJsonBody<unknown>(event);
    const parseResult = sendMessageSchema.safeParse(rawBody);

    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => i.message).join('; ');
      throw new BadRequestError(`Validation failed: ${issues}`);
    }

    const {
      messageId,
      recipientUserId,
      roomId: rawRoomId,
      body,
      messageType,
    }: SendMessageInput = parseResult.data;

    let targetRoomId: string;
    const destinations: Array<{ connectionId: string; userId: string }> = [];
    const seenConnectionIds = new Set<string>();

    const addDestination = (targetConnectionId: string, targetUserId: string) => {
      if (targetConnectionId === connectionId) {
        return; // Exclude the active sending connection (receives synchronous ACK)
      }
      if (!seenConnectionIds.has(targetConnectionId)) {
        seenConnectionIds.add(targetConnectionId);
        destinations.push({ connectionId: targetConnectionId, userId: targetUserId });
      }
    };

    if (recipientUserId) {
      if (recipientUserId === senderId) {
        throw new BadRequestError('Cannot send a direct message to yourself');
      }

      const recipient = await getUserProfile(recipientUserId, true);
      if (!recipient) {
        throw new BadRequestError(`Recipient user ${recipientUserId} does not exist`);
      }

      targetRoomId = directRoomId(senderId, recipientUserId);
      await createDirectRoom({ userA: senderId, userB: recipientUserId });

      // Gather recipient connections and sender's other connections concurrently
      const [recipientConnections, senderConnections] = await Promise.all([
        listUserConnections(recipientUserId),
        listUserConnections(senderId),
      ]);

      for (const conn of recipientConnections) {
        addDestination(conn.connectionId, recipientUserId);
      }
      for (const conn of senderConnections) {
        addDestination(conn.connectionId, senderId);
      }
    } else if (rawRoomId) {
      targetRoomId = rawRoomId;

      const isUserMember = await isMember(senderId, targetRoomId);
      if (!isUserMember) {
        throw new ForbiddenError('You are not a member of this room');
      }

      const members = await listRoomMembers(targetRoomId);

      // Concurrently query connections for all room members
      const memberConnectionLists = await Promise.all(
        members.map((member) => listUserConnections(member.userId)),
      );

      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        const connections = memberConnectionLists[i];
        for (const conn of connections) {
          addDestination(conn.connectionId, member.userId);
        }
      }
    } else {
      throw new BadRequestError('Either recipientUserId or roomId must be provided');
    }

    // Persist message and allocate sequence number idempotently
    const result = await createMessage({
      roomId: targetRoomId,
      senderId,
      clientMessageId: messageId,
      content: body,
      messageType,
    });

    const endpoint =
      process.env.API_GATEWAY_MANAGEMENT_ENDPOINT || `https://${domainName}/${stage}`;

    let deliveredCount = 0;
    let failedCount = 0;
    let staleCount = 0;
    let errorCount = 0;

    // If not a duplicate replay, fan out message to all destinations
    if (!result.duplicate && destinations.length > 0) {
      const deliveryPayload: MessageDeliveryPayload = {
        action: 'message',
        roomId: targetRoomId,
        sequenceNumber: result.sequenceNumber,
        messageId,
        senderId,
        body,
        messageType: result.message?.messageType ?? messageType,
        createdAt: result.createdAt,
      };

      const deliveryResults = await Promise.allSettled(
        destinations.map((dest) =>
          postToConnection({
            connectionId: dest.connectionId,
            userId: dest.userId,
            payload: deliveryPayload,
            endpoint,
          }),
        ),
      );

      for (let i = 0; i < deliveryResults.length; i++) {
        const deliveryResult = deliveryResults[i];
        const dest = destinations[i];

        if (deliveryResult.status === 'fulfilled') {
          if (deliveryResult.value === true) {
            deliveredCount++;
          } else {
            // postToConnection caught 410 GoneException and pruned the connection
            staleCount++;
            failedCount++;
          }
        } else {
          // Unexpected delivery failure (e.g. network error, 5xx)
          errorCount++;
          failedCount++;

          const reason = deliveryResult.reason;
          log.warn('Delivery failure to connection', {
            connectionId: dest.connectionId,
            targetUserId: dest.userId,
            errorName: reason instanceof Error ? reason.name : 'UnknownError',
            errorMessage: reason instanceof Error ? reason.message : String(reason),
          });
        }
      }
    }

    const ackPayload: MessageAckPayload = {
      action: 'ack',
      messageId,
      roomId: targetRoomId,
      sequenceNumber: result.sequenceNumber,
      createdAt: result.createdAt,
      isDuplicate: result.duplicate,
    };

    log.info('Message processed successfully', {
      senderId,
      roomId: targetRoomId,
      sequenceNumber: result.sequenceNumber,
      isDuplicate: result.duplicate,
      recipientCount: destinations.length,
      deliveredCount,
      failedCount,
      staleCount,
      errorCount,
    });

    return formatResponse(200, ackPayload);
  } catch (error) {
    return handleError(error, log);
  }
};
