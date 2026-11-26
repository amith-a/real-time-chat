import { listRoomMembers, listRoomsForUser, listUserConnections } from '../repositories';
import {
  DEFAULT_DYNAMODB_CONCURRENCY,
  DEFAULT_GATEWAY_CONCURRENCY,
  pMap,
  pMapSettled,
} from './concurrency';
import { logger } from './logger';
import { postToConnection } from './management-api';
import type { PresenceBroadcastPayload } from './schemas';

/** API Gateway WebSocket idle timeout is 10 minutes (600,000 ms). */
export const WEBSOCKET_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Client heartbeat interval (60s), configured well below the 10-minute idle timeout. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Default threshold (3 minutes / 3 missed heartbeats) before a connection is considered stale. */
export const STALE_CONNECTION_TIMEOUT_MS = 3 * 60_000;

/**
 * Returns the configured stale-connection timeout in milliseconds,
 * falling back to STALE_CONNECTION_TIMEOUT_MS (3 minutes).
 */
export function getStaleConnectionTimeoutMs(): number {
  const raw = process.env.STALE_CONNECTION_TIMEOUT_MS;
  if (!raw) return STALE_CONNECTION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : STALE_CONNECTION_TIMEOUT_MS;
}

/**
 * Computes the ISO-8601 cutoff timestamp for stale connection detection
 * based on `currentTime - timeoutMs`. TTL is never used as presence truth.
 */
export function getStaleCutoffIso(
  nowMs = Date.now(),
  timeoutMs = getStaleConnectionTimeoutMs(),
): string {
  return new Date(nowMs - timeoutMs).toISOString();
}

/**
 * Determines whether a connection is stale using `currentTime - lastHeartbeat > timeoutMs`.
 * Never uses DynamoDB TTL for presence truth.
 */
export function isConnectionStale(
  lastHeartbeat: string,
  nowMs = Date.now(),
  timeoutMs = getStaleConnectionTimeoutMs(),
): boolean {
  const heartbeatMs = Date.parse(lastHeartbeat);
  if (Number.isNaN(heartbeatMs)) {
    return true;
  }
  return nowMs - heartbeatMs > timeoutMs;
}

export interface BroadcastPresenceInput {
  userId: string;
  status: 'online' | 'offline';
  lastSeenAt: string;
  endpoint?: string;
  excludeConnectionId?: string;
}

export interface BroadcastPresenceResult {
  recipientCount: number;
  deliveredCount: number;
}

/**
 * Broadcasts a user's presence transition (`online` / `offline`) to active connections
 * of peers sharing at least one room with the user.
 */
export async function broadcastPresenceChange(
  input: BroadcastPresenceInput,
): Promise<BroadcastPresenceResult> {
  const endpoint = input.endpoint || process.env.API_GATEWAY_MANAGEMENT_ENDPOINT;
  if (!endpoint) {
    return { recipientCount: 0, deliveredCount: 0 };
  }

  const memberships = await listRoomsForUser(input.userId);
  if (memberships.length === 0) {
    return { recipientCount: 0, deliveredCount: 0 };
  }

  const roomMemberLists = await pMap(
    memberships,
    (m) => listRoomMembers(m.roomId),
    DEFAULT_DYNAMODB_CONCURRENCY,
  );

  const peerUserIds = new Set<string>();
  for (const members of roomMemberLists) {
    for (const member of members) {
      if (member.userId !== input.userId) {
        peerUserIds.add(member.userId);
      }
    }
  }

  if (peerUserIds.size === 0) {
    return { recipientCount: 0, deliveredCount: 0 };
  }

  const peerIds = Array.from(peerUserIds);
  const peerConnectionLists = await pMap(
    peerIds,
    (peerId) => listUserConnections(peerId),
    DEFAULT_DYNAMODB_CONCURRENCY,
  );

  const seenConnections = new Set<string>();
  const destinations: Array<{ connectionId: string; userId: string }> = [];

  for (let i = 0; i < peerIds.length; i++) {
    const peerId = peerIds[i];
    for (const conn of peerConnectionLists[i]) {
      if (conn.connectionId === input.excludeConnectionId) continue;
      if (!seenConnections.has(conn.connectionId)) {
        seenConnections.add(conn.connectionId);
        destinations.push({ connectionId: conn.connectionId, userId: peerId });
      }
    }
  }

  if (destinations.length === 0) {
    return { recipientCount: 0, deliveredCount: 0 };
  }

  const payload: PresenceBroadcastPayload = {
    action: 'presence',
    userId: input.userId,
    status: input.status,
    lastSeenAt: input.lastSeenAt,
  };

  const results = await pMapSettled(
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
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value === true) {
      deliveredCount++;
    }
  }

  logger.info('Presence update broadcast complete', {
    userId: input.userId,
    status: input.status,
    recipientCount: destinations.length,
    deliveredCount,
  });

  return { recipientCount: destinations.length, deliveredCount };
}
