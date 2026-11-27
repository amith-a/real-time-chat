import type { ScheduledHandler } from 'aws-lambda';
import { getPresence, removeStaleConnection, scanStaleConnections } from '../../repositories';
import {
  broadcastPresenceChange,
  DEFAULT_DYNAMODB_CONCURRENCY,
  getStaleConnectionTimeoutMs,
  getStaleCutoffIso,
  logger,
  pMapSettled,
} from '../../shared';

export interface SweeperRunResult {
  cutoff: string;
  scannedPages: number;
  scannedCandidates: number;
  removedCount: number;
  offlineBroadcasts: number;
  scanDurationMs: number;
}

/**
 * Core sweeper routine exported for direct unit/integration testing.
 * Uses `lastHeartbeat` cutoff (`currentTime - staleTimeoutMs`) as the sole source
 * of presence truth; DynamoDB TTL is only used for garbage collection.
 *
 * Note on table growth: `scanStaleConnections` reads the full table. Set
 * `SWEEPER_MAX_PAGES` to bound per-invocation work; evaluate a sparse GSI2 under load testing.
 */
export async function runSweeper(nowMs = Date.now()): Promise<SweeperRunResult> {
  const timeoutMs = getStaleConnectionTimeoutMs();
  const cutoff = getStaleCutoffIso(nowMs, timeoutMs);
  const nowIso = new Date(nowMs).toISOString();
  const maxPagesRaw = process.env.SWEEPER_MAX_PAGES;
  const maxPages =
    maxPagesRaw && Number.isFinite(Number(maxPagesRaw)) && Number(maxPagesRaw) > 0
      ? Number(maxPagesRaw)
      : undefined;

  const scanStart = Date.now();
  let scannedPages = 0;
  let scannedCandidates = 0;
  let removedCount = 0;
  const affectedUserIds = new Set<string>();

  for await (const page of scanStaleConnections(cutoff, undefined, maxPages)) {
    scannedPages++;
    scannedCandidates += page.length;

    const results = await pMapSettled(
      page,
      (candidate) => removeStaleConnection(candidate, cutoff, nowIso),
      DEFAULT_DYNAMODB_CONCURRENCY,
    );

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled' && res.value === 'REMOVED') {
        removedCount++;
        affectedUserIds.add(page[i].userId);
      } else if (res.status === 'rejected') {
        logger.warn('Failed to remove stale connection candidate', {
          connectionId: page[i].connectionId,
          userId: page[i].userId,
          error: res.reason instanceof Error ? res.reason.message : String(res.reason),
        });
      }
    }
  }

  let offlineBroadcasts = 0;
  if (process.env.API_GATEWAY_MANAGEMENT_ENDPOINT && affectedUserIds.size > 0) {
    for (const userId of affectedUserIds) {
      try {
        const presence = await getPresence(userId, true);
        if (!presence.online) {
          await broadcastPresenceChange({
            userId,
            status: 'offline',
            lastSeenAt: presence.lastSeenAt ?? nowIso,
          });
          offlineBroadcasts++;
        }
      } catch (err) {
        logger.warn('Failed to broadcast offline presence from sweeper', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const scanDurationMs = Date.now() - scanStart;

  logger.info('Stale connection sweeper complete', {
    cutoff,
    timeoutMs,
    scannedPages,
    scannedCandidates,
    removedCount,
    affectedUsers: affectedUserIds.size,
    offlineBroadcasts,
    scanDurationMs,
  });

  return {
    cutoff,
    scannedPages,
    scannedCandidates,
    removedCount,
    offlineBroadcasts,
    scanDurationMs,
  };
}

export const handler: ScheduledHandler = async () => {
  await runSweeper();
};
