import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyWebsocketHandlerV2,
  Context,
} from 'aws-lambda';
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
  DEFAULT_DYNAMODB_CONCURRENCY,
  DEFAULT_GATEWAY_CONCURRENCY,
  enqueueFanoutRetries,
  type FanoutRetryMessage,
  ForbiddenError,
  formatResponse,
  getAuthenticatedUser,
  getWebSocketContext,
  handleError,
  logger,
  type MessageAckPayload,
  type MessageDeliveryPayload,
  parseJsonBody,
  pMap,
  pMapSettled,
  postToConnection,
  type SendMessageInput,
  sendMessageSchema,
} from '../../shared';

const DEFAULT_TIMEOUT_BUFFER_MS = 2000;

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (
  event: APIGatewayProxyWebsocketEventV2,
  context?: Context,
): Promise<APIGatewayProxyResultV2> => {
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

    const startTime = Date.now();
    let membershipLookupDurationMs = 0;
    let connectionResolutionDurationMs = 0;
    let messagePersistDurationMs = 0;
    let deliveryDurationMs = 0;

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
      const resolutionStart = Date.now();
      const [recipientConnections, senderConnections] = await Promise.all([
        listUserConnections(recipientUserId),
        listUserConnections(senderId),
      ]);
      connectionResolutionDurationMs = Date.now() - resolutionStart;

      for (const conn of recipientConnections) {
        addDestination(conn.connectionId, recipientUserId);
      }
      for (const conn of senderConnections) {
        addDestination(conn.connectionId, senderId);
      }
    } else if (rawRoomId) {
      targetRoomId = rawRoomId;

      const memberLookupStart = Date.now();
      const isUserMember = await isMember(senderId, targetRoomId);
      if (!isUserMember) {
        throw new ForbiddenError('You are not a member of this room');
      }

      const members = await listRoomMembers(targetRoomId);
      membershipLookupDurationMs = Date.now() - memberLookupStart;

      // Query connections for all room members with bounded DynamoDB concurrency
      const resolutionStart = Date.now();
      const memberConnectionLists = await pMap(
        members,
        (member) => listUserConnections(member.userId),
        DEFAULT_DYNAMODB_CONCURRENCY,
      );
      connectionResolutionDurationMs = Date.now() - resolutionStart;

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
    const persistStart = Date.now();
    const result = await createMessage({
      roomId: targetRoomId,
      senderId,
      clientMessageId: messageId,
      content: body,
      messageType,
    });
    messagePersistDurationMs = Date.now() - persistStart;

    const endpoint =
      process.env.API_GATEWAY_MANAGEMENT_ENDPOINT || `https://${domainName}/${stage}`;

    let deliveredCount = 0;
    let failedCount = 0;
    let staleCount = 0;
    let errorCount = 0;
    let queuedRetryCount = 0;

    // If not a duplicate replay, fan out message to all destinations
    if (!result.duplicate && destinations.length > 0) {
      const deliveryStart = Date.now();
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

      const timeoutBufferMs = Number(
        process.env.FANOUT_TIMEOUT_BUFFER_MS ?? DEFAULT_TIMEOUT_BUFFER_MS,
      );
      const isNearTimeout =
        typeof context?.getRemainingTimeInMillis === 'function' &&
        context.getRemainingTimeInMillis() <= timeoutBufferMs;

      const failedDeliveries: FanoutRetryMessage[] = [];
      const toRetryItem = (
        dest: { connectionId: string; userId: string },
        reason: string,
      ): FanoutRetryMessage => ({
        connectionId: dest.connectionId,
        userId: dest.userId,
        endpoint,
        payload: deliveryPayload,
        roomId: targetRoomId,
        messageId,
        sequenceNumber: result.sequenceNumber,
        failedAt: new Date().toISOString(),
        reason,
      });

      if (isNearTimeout) {
        errorCount = destinations.length;
        failedCount = destinations.length;
        for (const dest of destinations) {
          failedDeliveries.push(toRetryItem(dest, 'LambdaTimeoutApproaching'));
        }
        log.warn('Lambda approaching timeout before fan-out; offloading destinations to SQS', {
          roomId: targetRoomId,
          messageId,
          remainingTimeMs: context.getRemainingTimeInMillis(),
          destinationCount: destinations.length,
        });
      } else {
        const deliveryResults = await pMapSettled(
          destinations,
          (dest) =>
            postToConnection({
              connectionId: dest.connectionId,
              userId: dest.userId,
              payload: deliveryPayload,
              endpoint,
            }),
          DEFAULT_GATEWAY_CONCURRENCY,
        );
        deliveryDurationMs = Date.now() - deliveryStart;

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
            // Unexpected delivery failure (e.g. network error, 5xx, 429)
            errorCount++;
            failedCount++;

            const reason = deliveryResult.reason;
            const reasonMessage = reason instanceof Error ? reason.message : String(reason);
            log.warn('Delivery failure to connection', {
              connectionId: dest.connectionId,
              targetUserId: dest.userId,
              errorName: reason instanceof Error ? reason.name : 'UnknownError',
              errorMessage: reasonMessage,
            });

            failedDeliveries.push(toRetryItem(dest, reasonMessage));
          }
        }
      }

      if (failedDeliveries.length > 0 && process.env.FANOUT_RETRY_QUEUE_URL) {
        try {
          const enqueueResult = await enqueueFanoutRetries(failedDeliveries);
          queuedRetryCount = enqueueResult.enqueued;
        } catch (sqsError) {
          log.error(
            'Failed to enqueue failed fan-out deliveries to SQS',
            sqsError instanceof Error ? sqsError : new Error(String(sqsError)),
            {
              roomId: targetRoomId,
              messageId,
              failedDeliveryCount: failedDeliveries.length,
            },
          );
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;

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
      queuedRetryCount,
      metrics: {
        membershipLookupDurationMs,
        connectionResolutionDurationMs,
        messagePersistDurationMs,
        deliveryDurationMs,
        totalDurationMs,
      },
    });

    return formatResponse(200, ackPayload);
  } catch (error) {
    return handleError(error, log);
  }
};
