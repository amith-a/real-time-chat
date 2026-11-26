/** API Gateway WebSocket maximum connection duration is 2 hours (7,200,000 ms). */
export const WEBSOCKET_MAX_CONNECTION_MS = 2 * 60 * 60_000;

/** Reconnect proactively at 1h 50m (6,600,000 ms) before API Gateway's 2-hour cutoff. */
export const PROACTIVE_RECONNECT_MS = 110 * 60_000;

export interface SequencedMessage {
  sequenceNumber: number;
}

export interface IngestResult<T extends SequencedMessage> {
  /** Messages ready to render in strict ascending sequence order. */
  delivered: T[];
  /** True if this message was already processed or buffered and was ignored. */
  duplicate: boolean;
  /** True if sequenceNumber > lastProcessedSequence + 1 (gap detected). */
  gapDetected: boolean;
  /** First missing sequence number when gapDetected is true. */
  missingAfterSequence?: number;
}

/**
 * Client-side per-room ordering, gap detection, duplicate suppression, and
 * reconnect state tracker.
 */
export class RoomSequenceTracker<T extends SequencedMessage> {
  private lastProcessedSequence: number;
  private readonly pendingBuffer = new Map<number, T>();

  constructor(initialLastSequence = 0) {
    if (!Number.isSafeInteger(initialLastSequence) || initialLastSequence < 0) {
      throw new RangeError('initialLastSequence must be a non-negative safe integer');
    }
    this.lastProcessedSequence = initialLastSequence;
  }

  getLastProcessedSequence(): number {
    return this.lastProcessedSequence;
  }

  getBufferedSequences(): number[] {
    return Array.from(this.pendingBuffer.keys()).sort((a, b) => a - b);
  }

  /**
   * Ingests a newly arrived message (from live WebSocket or recovery query).
   * - Drops duplicates (`seq <= lastProcessedSequence` or already buffered).
   * - Delivers in-order messages and drains contiguous buffered messages.
   * - Buffers out-of-order messages and reports `gapDetected` so caller can recover.
   */
  ingest(message: T): IngestResult<T> {
    const seq = message.sequenceNumber;
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new RangeError(`Invalid sequenceNumber: ${seq}`);
    }

    if (seq <= this.lastProcessedSequence || this.pendingBuffer.has(seq)) {
      return {
        delivered: [],
        duplicate: true,
        gapDetected: false,
      };
    }

    if (seq > this.lastProcessedSequence + 1) {
      this.pendingBuffer.set(seq, message);
      return {
        delivered: [],
        duplicate: false,
        gapDetected: true,
        missingAfterSequence: this.lastProcessedSequence,
      };
    }

    // seq === lastProcessedSequence + 1: deliver and drain any contiguous buffered items
    const delivered: T[] = [message];
    this.lastProcessedSequence = seq;

    while (this.pendingBuffer.has(this.lastProcessedSequence + 1)) {
      const nextSeq = this.lastProcessedSequence + 1;
      const buffered = this.pendingBuffer.get(nextSeq);
      if (buffered) {
        delivered.push(buffered);
        this.pendingBuffer.delete(nextSeq);
      }
      this.lastProcessedSequence = nextSeq;
    }

    const stillHasGap = this.pendingBuffer.size > 0;
    return {
      delivered,
      duplicate: false,
      gapDetected: stillHasGap,
      ...(stillHasGap && { missingAfterSequence: this.lastProcessedSequence }),
    };
  }

  /**
   * Applies a batch of recovered messages (sorted by sequenceNumber) to fill gaps
   * and advance `lastProcessedSequence`.
   */
  applyRecovery(messages: T[]): {
    delivered: T[];
    duplicateCount: number;
    hasRemainingGap: boolean;
  } {
    const sorted = [...messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const delivered: T[] = [];
    let duplicateCount = 0;

    for (const msg of sorted) {
      const res = this.ingest(msg);
      if (res.duplicate) {
        duplicateCount++;
      } else if (res.delivered.length > 0) {
        delivered.push(...res.delivered);
      }
    }

    return {
      delivered,
      duplicateCount,
      hasRemainingGap: this.pendingBuffer.size > 0,
    };
  }
}

/**
 * Computes whether a WebSocket connection should proactively reconnect
 * before hitting API Gateway's 2-hour maximum connection lifetime.
 */
export function shouldProactivelyReconnect(
  connectedAtMs: number,
  nowMs = Date.now(),
  thresholdMs = PROACTIVE_RECONNECT_MS,
): boolean {
  return nowMs - connectedAtMs >= thresholdMs;
}
