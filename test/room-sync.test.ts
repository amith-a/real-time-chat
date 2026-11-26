import { describe, expect, it } from 'vitest';
import {
  InMemorySequenceStore,
  type KeyValueStorage,
  LocalStorageSequenceStore,
  PROACTIVE_RECONNECT_MS,
  RoomSequenceTracker,
  shouldProactivelyReconnect,
  WEBSOCKET_MAX_CONNECTION_MS,
} from '../client/room-sync';

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

  it('persists and restores lastProcessedSequence across tracker restarts via SequenceStore', () => {
    const store = new InMemorySequenceStore();
    const t1 = new RoomSequenceTracker<TestMsg>(0, { roomId: 'room-persist', store });
    t1.ingest({ sequenceNumber: 1, body: 'm1' });
    t1.ingest({ sequenceNumber: 2, body: 'm2' });
    expect(store.getLastSequence('room-persist')).toBe(2);

    // Simulated restart: new tracker restores 2 from store
    const t2 = new RoomSequenceTracker<TestMsg>(0, { roomId: 'room-persist', store });
    expect(t2.getLastProcessedSequence()).toBe(2);
    expect(t2.ingest({ sequenceNumber: 2, body: 'm2-dup' }).duplicate).toBe(true);
    expect(t2.ingest({ sequenceNumber: 3, body: 'm3' }).delivered).toHaveLength(1);
    expect(store.getLastSequence('room-persist')).toBe(3);
  });

  it('persists and restores lastProcessedSequence across page refreshes via LocalStorageSequenceStore', () => {
    const backing = new Map<string, string>();
    const mockLocalStorage: KeyValueStorage = {
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, val) => {
        backing.set(key, val);
      },
    };

    // Session 1: processes seq 1 and 2
    const store1 = new LocalStorageSequenceStore(mockLocalStorage);
    const tracker1 = new RoomSequenceTracker<TestMsg>(0, {
      roomId: 'room-browser',
      store: store1,
    });
    tracker1.ingest({ sequenceNumber: 1, body: 'hello' });
    tracker1.ingest({ sequenceNumber: 2, body: 'world' });
    expect(backing.get('rtc:lastSeq:room-browser')).toBe('2');

    // Page refresh: new store + tracker instance restores seq 2 from localStorage
    const store2 = new LocalStorageSequenceStore(mockLocalStorage);
    const tracker2 = new RoomSequenceTracker<TestMsg>(0, {
      roomId: 'room-browser',
      store: store2,
    });
    expect(tracker2.getLastProcessedSequence()).toBe(2);

    // Reconnect recovery applies 3 and 4, ignoring duplicate 2
    const recovery = tracker2.applyRecovery([
      { sequenceNumber: 2, body: 'world' },
      { sequenceNumber: 3, body: 'after-refresh' },
      { sequenceNumber: 4, body: 'latest' },
    ]);
    expect(recovery.delivered.map((m) => m.sequenceNumber)).toEqual([3, 4]);
    expect(recovery.duplicateCount).toBe(1);
    expect(tracker2.getLastProcessedSequence()).toBe(4);
    expect(backing.get('rtc:lastSeq:room-browser')).toBe('4');
  });
});
