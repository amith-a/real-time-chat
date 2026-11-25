import 'dotenv/config';

// ---------------------------------------------------------------------------
// Configuration & Shared Types
// ---------------------------------------------------------------------------
export const REGION = process.env.AWS_REGION || 'ap-south-1';
export const WS_URL = process.env.WS_URL; // e.g. wss://xxxx.execute-api.ap-south-1.amazonaws.com/dev
export const AUTH_TOKENS_RAW = process.env.AUTH_TOKENS; // Optional comma-separated Cognito ID tokens
export const USER_POOL_ID = process.env.USER_POOL_ID;
export const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
export const BENCH_PASSWORD = process.env.BENCH_PASSWORD || 'Bench_Pass@2026!';

export const BENCHMARK_ROOM_PREFIX = 'benchmark-room-';
export const BENCHMARK_USER_PREFIX = 'bench-user-';
export const BENCHMARK_USER_DOMAIN = 'example.com';
export const BENCHMARK_MARKER_PREFIX = 'fanout-benchmark-';

export const MEMBER_COUNT = Number(process.env.MEMBER_COUNT || 50);
export const WARMUP_ROUNDS = Number(process.env.WARMUP_ROUNDS || 5);
export const TEST_ROUNDS = Number(process.env.TEST_ROUNDS || 100);
export const CONNECT_BATCH_SIZE = 5;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const FRAME_TIMEOUT_MS = 15_000;
export const CLOSE_TIMEOUT_MS = 3_000;

export interface AuthenticatedUser {
  userId: string;
  email: string;
  idToken: string;
}

export interface JwtClaims {
  sub?: string;
  exp?: number;
  token_use?: string;
  aud?: string;
}

export interface FanoutRoundResult {
  ackLatencyMs: number;
  fanoutDeliveryLatencyMs: number;
  receivedCount: number;
  duplicateFrames: number;
  senderSelfBroadcasts: number;
}
