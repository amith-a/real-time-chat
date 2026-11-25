import {
  type AuthenticatedUser,
  CLOSE_TIMEOUT_MS,
  CONNECT_BATCH_SIZE,
  type FanoutRoundResult,
  FRAME_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
} from './config';

/**
 * Failure-safe WebSocket connection handshake.
 * Cleans up listeners and closes dangling sockets on timeout, error, or premature close.
 */
export async function connectSocket(url: string, label: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      } catch {
        // ignore close errors during failed handshake
      }
      reject(err);
    };

    const timer = setTimeout(() => {
      fail(new Error(`WebSocket handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms (${label})`));
    }, HANDSHAKE_TIMEOUT_MS);

    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = () => {
      fail(new Error(`WebSocket handshake error for ${label}`));
    };

    const onClose = (event: CloseEvent) => {
      fail(
        new Error(
          `WebSocket closed before open for ${label} (code=${event.code}, reason=${event.reason || 'none'})`,
        ),
      );
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
  return ws;
}

/**
 * Failure-safe batch connection handling.
 * Uses Promise.allSettled so any sockets that DID open in a partially failed batch
 * are still tracked in `allSockets` and cleaned up properly on teardown.
 */
export async function connectRecipientsInBatches(
  recipientUsers: AuthenticatedUser[],
  wsUrl: string,
  allSockets: WebSocket[],
): Promise<WebSocket[]> {
  const recipientSockets: WebSocket[] = [];

  for (let i = 0; i < recipientUsers.length; i += CONNECT_BATCH_SIZE) {
    const batch = recipientUsers.slice(i, i + CONNECT_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((u) => connectSocket(`${wsUrl}?token=${u.idToken}`, u.email)),
    );

    const errors: string[] = [];
    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'fulfilled') {
        recipientSockets.push(outcome.value);
        allSockets.push(outcome.value);
      } else {
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        errors.push(`${batch[j].email}: ${reason}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Failed to connect ${errors.length}/${batch.length} recipient sockets in batch:\n  - ${errors.join('\n  - ')}`,
      );
    }

    process.stdout.write(`  Connected ${allSockets.length}/${recipientUsers.length + 1} sockets\r`);
  }

  return recipientSockets;
}

/**
 * Gracefully closes all WebSocket connections and waits (bounded by CLOSE_TIMEOUT_MS)
 * for their close events so API Gateway invokes $disconnect before verification.
 */
export async function closeSocketsSafely(sockets: WebSocket[]): Promise<void> {
  if (sockets.length === 0) return;

  await Promise.allSettled(
    sockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }

          const timer = setTimeout(() => {
            ws.removeEventListener('close', onClose);
            resolve();
          }, CLOSE_TIMEOUT_MS);

          const onClose = () => {
            clearTimeout(timer);
            ws.removeEventListener('close', onClose);
            resolve();
          };

          ws.addEventListener('close', onClose);
          try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1000, 'benchmark complete');
            }
          } catch {
            clearTimeout(timer);
            ws.removeEventListener('close', onClose);
            resolve();
          }
        }),
    ),
  );
}

/**
 * Sends one message and awaits both:
 * 1. The sender's ACK frame.
 * 2. The broadcast 'message' frame on every open recipient WebSocket.
 *
 * Detects duplicate frames, unexpected self-broadcasts, and synchronous send errors.
 */
export async function sendAndVerifyFanout(
  senderWs: WebSocket,
  recipientSockets: WebSocket[],
  roomId: string,
  messageId: string,
  body: string,
): Promise<FanoutRoundResult> {
  if (senderWs.readyState !== WebSocket.OPEN) {
    throw new Error(`Sender WebSocket is not open (state=${senderWs.readyState})`);
  }
  for (let i = 0; i < recipientSockets.length; i++) {
    if (recipientSockets[i].readyState !== WebSocket.OPEN) {
      throw new Error(
        `Recipient WebSocket #${i + 1} is not open (state=${recipientSockets[i].readyState})`,
      );
    }
  }

  const payload = JSON.stringify({
    action: 'sendMessage',
    roomId,
    messageId,
    body,
  });

  const start = performance.now();
  let ackLatencyMs = 0;
  let lastDeliveryMs = 0;
  let receivedCount = 0;
  let duplicateFrames = 0;
  let senderSelfBroadcasts = 0;

  await new Promise<void>((resolve, reject) => {
    let ackCount = 0;
    let settled = false;
    const cleanups: Array<() => void> = [];

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const fn of cleanups) fn();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const finishIfDone = () => {
      if (ackCount >= 1 && receivedCount === recipientSockets.length) {
        setTimeout(() => {
          if (duplicateFrames > 0) {
            finish(
              new Error(`Detected ${duplicateFrames} duplicate delivery frame(s) for ${messageId}`),
            );
          } else if (senderSelfBroadcasts > 0) {
            finish(
              new Error(`Sender socket unexpectedly received its own broadcast for ${messageId}`),
            );
          } else {
            finish();
          }
        }, 25);
      }
    };

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Timeout for ${messageId}: acks=${ackCount}, recipients=${receivedCount}/${recipientSockets.length}, duplicates=${duplicateFrames}`,
        ),
      );
    }, FRAME_TIMEOUT_MS);

    const attachDropGuard = (ws: WebSocket, label: string) => {
      const onDrop = () => {
        finish(new Error(`${label} dropped connection during ${messageId}`));
      };
      ws.addEventListener('close', onDrop);
      ws.addEventListener('error', onDrop);
      cleanups.push(() => {
        ws.removeEventListener('close', onDrop);
        ws.removeEventListener('error', onDrop);
      });
    };

    attachDropGuard(senderWs, 'Sender socket');

    // 1. Register sender ACK & self-broadcast detector BEFORE sending
    const onSenderMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(
          typeof event.data === 'string' ? event.data : event.data.toString(),
        );
        if (data.action === 'ack' && data.messageId === messageId) {
          ackCount++;
          if (ackCount === 1) {
            ackLatencyMs = performance.now() - start;
            finishIfDone();
          } else {
            duplicateFrames++;
          }
        } else if (data.action === 'message' && data.messageId === messageId) {
          senderSelfBroadcasts++;
        }
      } catch {
        // ignore non-json frames
      }
    };
    senderWs.addEventListener('message', onSenderMessage);
    cleanups.push(() => senderWs.removeEventListener('message', onSenderMessage));

    // 2. Register recipient delivery & duplicate frame listeners BEFORE sending
    recipientSockets.forEach((rWs, idx) => {
      attachDropGuard(rWs, `Recipient socket #${idx + 1}`);
      let socketDeliveryCount = 0;
      const onRecipientMessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(
            typeof event.data === 'string' ? event.data : event.data.toString(),
          );
          if (data.action === 'message' && data.messageId === messageId) {
            socketDeliveryCount++;
            if (socketDeliveryCount === 1) {
              receivedCount++;
              lastDeliveryMs = Math.max(lastDeliveryMs, performance.now() - start);
              finishIfDone();
            } else {
              duplicateFrames++;
            }
          }
        } catch {
          // ignore non-json frames
        }
      };
      rWs.addEventListener('message', onRecipientMessage);
      cleanups.push(() => rWs.removeEventListener('message', onRecipientMessage));
    });

    // 3. Guard synchronous WebSocket send errors so listeners/timers are always cleaned up
    try {
      senderWs.send(payload);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    ackLatencyMs,
    fanoutDeliveryLatencyMs: lastDeliveryMs,
    receivedCount,
    duplicateFrames,
    senderSelfBroadcasts,
  };
}
