import { describe, expect, it } from 'vitest';
import {
  PROACTIVE_RECONNECT_MS,
  RoomSequenceTracker,
  shouldProactivelyReconnect,
  WEBSOCKET_MAX_CONNECTION_MS,
} from '../src/shared';

interface TestMsg {
  sequenceNumber: number;
  body: string;
}

describe('Phase 11 Client RoomSequenceTracker & Reconnection', () => {
  it('proactively reconnects before the 2-hour API Gateway connection lifetime', () => {
    expect(PROACTIVE_RECONNECT_MS).toBeLessThan(WEBSOCKET_MAX_CONNECTION_MS);
    const connectedAt = 1_000_000;
    expect(shouldProactivelyReconnect(connectedAt, connectedAt + 60_000)).toBe(false);
    expect(shouldProactivelyReconnect(connectedAt, connectedAt + PROACTIVE_RECONNECT_MS)).toBe(
      true,
    );
  });

  it('orders out-of-order messages and drains contiguous buffered items once gap closes', () => {
    const tracker = new RoomSequenceTracker<TestMsg>(100);

    // 101 arrives in order
    const r1 = tracker.ingest({ sequenceNumber: 101, body: 'm101' });
    expect(r1).toEqual({
      delivered: [{ sequenceNumber: 101, body: 'm101' }],
      duplicate: false,
      gapDetected: false,
    });
    expect(tracker.getLastProcessedSequence()).toBe(101);

    // 103 arrives before 102 -> gap detected
    const r2 = tracker.ingest({ sequenceNumber: 103, body: 'm103' });
    expect(r2).toEqual({
      delivered: [],
      duplicate: false,
      gapDetected: true,
      missingAfterSequence: 101,
    });
    expect(tracker.getLastProcessedSequence()).toBe(101);
    expect(tracker.getBufferedSequences()).toEqual([103]);

    // 102 arrives -> delivers 102 and drains buffered 103 in order
    const r3 = tracker.ingest({ sequenceNumber: 102, body: 'm102' });
    expect(r3).toEqual({
      delivered: [
        { sequenceNumber: 102, body: 'm102' },
        { sequenceNumber: 103, body: 'm103' },
      ],
      duplicate: false,
      gapDetected: false,
    });
    expect(tracker.getLastProcessedSequence()).toBe(103);
    expect(tracker.getBufferedSequences()).toEqual([]);
  });

  it('drops duplicate sequences whether already processed or currently buffered', () => {
    const tracker = new RoomSequenceTracker<TestMsg>(100);

    expect(tracker.ingest({ sequenceNumber: 101, body: 'm101' }).duplicate).toBe(false);
    expect(tracker.ingest({ sequenceNumber: 102, body: 'm102' }).duplicate).toBe(false);
    // Duplicate of processed 102
    const dup102 = tracker.ingest({ sequenceNumber: 102, body: 'm102-dup' });
    expect(dup102).toEqual({ delivered: [], duplicate: true, gapDetected: false });

    // Out-of-order 104 buffered, then duplicated
    expect(tracker.ingest({ sequenceNumber: 104, body: 'm104' }).gapDetected).toBe(true);
    expect(tracker.ingest({ sequenceNumber: 104, body: 'm104-dup' }).duplicate).toBe(true);
    expect(tracker.getLastProcessedSequence()).toBe(102);
  });

  it('recovers missed messages on reconnect and ignores overlapping duplicates', () => {
    const tracker = new RoomSequenceTracker<TestMsg>(184);

    // Live message 187 arrives right after reconnect while 185 & 186 were missed
    const live187 = tracker.ingest({ sequenceNumber: 187, body: 'm187' });
    expect(live187.gapDetected).toBe(true);
    expect(live187.missingAfterSequence).toBe(184);

    // Server resume returns 184 (overlap), 185, 186, 187 (overlap with buffer)
    const recovery = tracker.applyRecovery([
      { sequenceNumber: 184, body: 'm184' },
      { sequenceNumber: 185, body: 'm185' },
      { sequenceNumber: 186, body: 'm186' },
      { sequenceNumber: 187, body: 'm187' },
    ]);

    expect(recovery.delivered.map((m) => m.sequenceNumber)).toEqual([185, 186, 187]);
    expect(recovery.duplicateCount).toBe(2); // 184 and buffered 187
    expect(recovery.hasRemainingGap).toBe(false);
    expect(tracker.getLastProcessedSequence()).toBe(187);
  });
});
