import type { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as repositories from '../src/repositories';
import { postToConnection } from '../src/shared/management-api';

describe('Management API (postToConnection retry behaviour)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries when AWS returns 429 TooManyRequestsException and succeeds on second attempt', async () => {
    const throttleError = new Error('Rate exceeded');
    throttleError.name = 'TooManyRequestsException';
    (throttleError as { statusCode?: number }).statusCode = 429;

    const mockSend = vi.fn().mockRejectedValueOnce(throttleError).mockResolvedValueOnce({});

    const mockClient = {
      send: mockSend,
    } as unknown as ApiGatewayManagementApiClient;

    const result = await postToConnection({
      connectionId: 'conn-retry-test',
      payload: { action: 'message', text: 'hello' },
      client: mockClient,
      maxRetries: 2,
    });

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('throws error when retries are exhausted on persistent 429 throttling', async () => {
    const throttleError = new Error('Rate exceeded');
    throttleError.name = 'TooManyRequestsException';
    (throttleError as { statusCode?: number }).statusCode = 429;

    const mockSend = vi.fn().mockRejectedValue(throttleError);

    const mockClient = {
      send: mockSend,
    } as unknown as ApiGatewayManagementApiClient;

    await expect(
      postToConnection({
        connectionId: 'conn-retry-fail',
        payload: { action: 'message' },
        client: mockClient,
        maxRetries: 2,
      }),
    ).rejects.toThrow('Rate exceeded');

    // 1 initial attempt + 2 retries = 3 calls
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('handles 410 GoneException by removing the connection and returning false', async () => {
    const removeConnectionSpy = vi
      .spyOn(repositories, 'removeConnection')
      .mockResolvedValue('REMOVED');

    const goneError = new Error('Gone');
    goneError.name = 'GoneException';
    (goneError as { statusCode?: number }).statusCode = 410;

    const mockClient = {
      send: vi.fn().mockRejectedValue(goneError),
    } as unknown as ApiGatewayManagementApiClient;

    const result = await postToConnection({
      connectionId: 'conn-dead',
      userId: 'user-alice',
      payload: { action: 'message' },
      client: mockClient,
    });

    expect(result).toBe(false);
    expect(removeConnectionSpy).toHaveBeenCalledWith({
      userId: 'user-alice',
      connectionId: 'conn-dead',
    });
  });
});
