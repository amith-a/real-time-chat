import { z } from 'zod';

export const sendMessageSchema = z
  .object({
    action: z.literal('sendMessage'),
    messageId: z
      .string()
      .trim()
      .min(1, 'messageId is required')
      .max(128, 'messageId must not exceed 128 characters'),
    recipientUserId: z.string().trim().min(1).optional(),
    roomId: z.string().trim().min(1).optional(),
    body: z
      .string()
      .trim()
      .min(1, 'body cannot be empty')
      .max(4096, 'body must not exceed 4096 characters'),
    messageType: z.enum(['TEXT', 'IMAGE', 'FILE']).default('TEXT'),
  })
  .refine((data) => Boolean(data.recipientUserId || data.roomId), {
    message: 'Either recipientUserId or roomId must be provided',
    path: ['recipientUserId'],
  })
  .refine((data) => !(data.recipientUserId && data.roomId), {
    message: 'Cannot provide both recipientUserId and roomId in the same request',
    path: ['recipientUserId'],
  });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export interface MessageDeliveryPayload {
  action: 'message';
  roomId: string;
  sequenceNumber: number;
  messageId: string;
  senderId: string;
  body: string;
  messageType: 'TEXT' | 'IMAGE' | 'FILE';
  createdAt: string;
}

export interface MessageAckPayload {
  action: 'ack';
  messageId: string;
  roomId: string;
  sequenceNumber: number;
  createdAt: string;
  isDuplicate: boolean;
}

export const heartbeatSchema = z.object({
  action: z.literal('heartbeat'),
});

export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

export interface HeartbeatAckPayload {
  action: 'heartbeatAck';
  status: 'ok' | 'reconnect';
  timestamp: string;
  nextHeartbeatMs: number;
}

export const typingSchema = z.object({
  action: z.literal('typing'),
  roomId: z.string().trim().min(1, 'roomId is required'),
  isTyping: z.boolean().default(true),
});

export type TypingInput = z.infer<typeof typingSchema>;

export interface TypingBroadcastPayload {
  action: 'typing';
  roomId: string;
  userId: string;
  isTyping: boolean;
  timestamp: string;
}

export interface TypingAckPayload {
  action: 'typingAck';
  roomId: string;
  isTyping: boolean;
}

export interface PresenceBroadcastPayload {
  action: 'presence';
  userId: string;
  status: 'online' | 'offline';
  lastSeenAt: string;
}

export const resumeSchema = z.object({
  action: z.literal('resume'),
  rooms: z
    .array(
      z.object({
        roomId: z.string().trim().min(1, 'roomId is required'),
        lastSequence: z.number().int().min(0, 'lastSequence must be >= 0'),
      }),
    )
    .min(1, 'At least one room is required')
    .max(50, 'Cannot resume more than 50 rooms at once'),
  limitPerRoom: z.number().int().min(1).max(100).default(50),
});

export type ResumeInput = z.infer<typeof resumeSchema>;

export interface ResumedRoomMessages {
  roomId: string;
  messages: Array<{
    messageId: string;
    roomId: string;
    sequenceNumber: number;
    senderId: string;
    content: string;
    messageType: 'TEXT' | 'IMAGE' | 'FILE';
    createdAt: string;
  }>;
  hasMore: boolean;
  nextAfterSequence: number;
}

export interface ResumeAckPayload {
  action: 'resumeAck';
  rooms: ResumedRoomMessages[];
}
