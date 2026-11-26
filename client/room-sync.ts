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

/** Storage abstraction for persisting each room's last processed sequence across restarts. */
export interface SequenceStore {
  getLastSequence(roomId: string): number | undefined;
  setLastSequence(roomId: string, sequence: number): void;
}

/** Simple in-memory SequenceStore for tests or non-persistent sessions. */
export class InMemorySequenceStore implements SequenceStore {
  private readonly sequences = new Map<string, number>();

  getLastSequence(roomId: string): number | undefined {
    return this.sequences.get(roomId);
  }

  setLastSequence(roomId: string, sequence: number): void {
    this.sequences.set(roomId, sequence);
  }
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Browser-compatible persistent SequenceStore backed by `localStorage` (or any
 * `Storage`-compatible key-value store). Preserves `lastProcessedSequence` across
 * page refreshes and app restarts.
 */
export class LocalStorageSequenceStore implements SequenceStore {
  private readonly storage: KeyValueStorage;
  private readonly keyPrefix: string;

  constructor(
    storage: KeyValueStorage | undefined = typeof globalThis !== 'undefined'
      ? (globalThis as { localStorage?: KeyValueStorage }).localStorage
      : undefined,
    keyPrefix = 'rtc:lastSeq:',
  ) {
    if (!storage) {
      throw new Error('LocalStorageSequenceStore requires a localStorage-compatible storage');
    }
    this.storage = storage;
    this.keyPrefix = keyPrefix;
  }

  getLastSequence(roomId: string): number | undefined {
    const raw = this.storage.getItem(`${this.keyPrefix}${roomId}`);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return undefined;
    }
    return parsed;
  }

  setLastSequence(roomId: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RangeError(`Invalid sequence number: ${sequence}`);
    }
    this.storage.setItem(`${this.keyPrefix}${roomId}`, String(sequence));
  }
}

/**
 * Client-side per-room ordering, gap detection, duplicate suppression, and
 * reconnect state tracker. Optionally persists `lastProcessedSequence` via `SequenceStore`.
 */
export class RoomSequenceTracker<T extends SequencedMessage> {
  private lastProcessedSequence: number;
  private readonly pendingBuffer = new Map<number, T>();
  private readonly persistence?: { roomId: string; store: SequenceStore };

  constructor(initialLastSequence = 0, persistence?: { roomId: string; store: SequenceStore }) {
    const persisted = persistence?.store.getLastSequence(persistence.roomId);
    const startingSeq = persisted !== undefined ? persisted : initialLastSequence;
    if (!Number.isSafeInteger(startingSeq) || startingSeq < 0) {
      throw new RangeError('initialLastSequence must be a non-negative safe integer');
    }
    this.lastProcessedSequence = startingSeq;
    this.persistence = persistence;
  }

  private persistSequence(): void {
    if (this.persistence) {
      this.persistence.store.setLastSequence(this.persistence.roomId, this.lastProcessedSequence);
    }
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

    this.persistSequence();

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
