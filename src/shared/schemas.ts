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
