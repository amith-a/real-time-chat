import type { MembershipKeys, PrimaryKey } from './keys';

export type RoomType = 'DIRECT' | 'GROUP';
export type MemberRole = 'ADMIN' | 'MEMBER';
export type MessageType = 'TEXT' | 'IMAGE' | 'FILE';

/** Timestamps are ISO-8601 UTC strings, which sort and compare correctly as strings. */
export type IsoTimestamp = string;

export interface UserProfileItem extends PrimaryKey {
  userId: string;
  email?: string;
  name?: string;
  createdAt?: IsoTimestamp;
  [attribute: string]: unknown;
}

export interface ConnectionItem extends PrimaryKey {
  userId: string;
  connectionId: string;
  connectedAt: IsoTimestamp;
  lastHeartbeat: IsoTimestamp;
}

export interface ConnectionOwnerItem extends PrimaryKey {
  userId: string;
  connectedAt: IsoTimestamp;
}

export interface PresenceItem extends PrimaryKey {
  activeConnectionCount: number;
  lastSeenAt?: IsoTimestamp;
}

export interface RoomItem extends PrimaryKey {
  roomId: string;
  roomType: RoomType;
  createdAt: IsoTimestamp;
  createdBy: string;
  name?: string;
}

export interface MembershipItem extends MembershipKeys {
  userId: string;
  roomId: string;
  joinedAt: IsoTimestamp;
  role: MemberRole;
}

export interface CounterItem extends PrimaryKey {
  sequenceNumber: number;
  updatedAt: IsoTimestamp;
}

export interface MessageItem extends PrimaryKey {
  messageId: string;
  clientMessageId: string;
  roomId: string;
  senderId: string;
  content: string;
  sequenceNumber: number;
  createdAt: IsoTimestamp;
  messageType: MessageType;
}

export interface IdempotencyItem extends PrimaryKey {
  messageId: string;
  sequenceNumber: number;
  requestHash: string;
  createdAt: IsoTimestamp;
  /** Epoch seconds. Used only for eventual cleanup. */
  ttl: number;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `startKey` to fetch the next page. Undefined when there are no more pages. */
  nextKey?: Record<string, unknown>;
}
