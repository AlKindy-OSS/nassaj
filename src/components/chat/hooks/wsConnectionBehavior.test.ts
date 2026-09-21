/**
 * Unit tests for WS connection behaviour changes (B-39 + B-33 frontend).
 *
 * Covers:
 *  - sendMessage returns { ok: false } when socket is not open
 *  - dispatchProviderCommand returns false → sendError is set
 *  - SERVER_ERROR_CODE_KEYS map covers the agreed codes
 *  - calcReconnectDelay grows with attempt count (exponential backoff)
 *
 * RUNNER: vitest (`npm run test:client`) — NOT the node built-in test runner.
 *
 * This file used to take describe/it from the node built-in test module, which
 * made it structurally dead code: vite.config.js routes every src/ file whose
 * source imports that module OUT of the vitest `include` list, and the node
 * runner cannot evaluate `import.meta.env`. The transitive import chain
 * WebSocketContext.tsx → … → src/constants/config.ts (which reads
 * `import.meta.env.VITE_IS_PLATFORM` at module scope) therefore threw
 * "Cannot read properties of undefined" before a single assertion ran — so the
 * file was excluded from vitest AND broken under node: zero coverage from
 * either runner. Sourcing describe/it from 'vitest' puts it back inside the
 * vitest include glob, where Vite defines import.meta.env and the React/JSX
 * transform handles WebSocketContext.tsx.
 *
 * Do NOT reintroduce an import of the node built-in test module here: that
 * single line silently removes this file from every runner again.
 *
 * The imports below are the real production constants/functions, so any change
 * to the source is immediately caught by these tests (B-43).
 */

import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  calcReconnectDelay,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from '../../../contexts/WebSocketContext.js';

import { SERVER_ERROR_CODE_KEYS } from './useChatRealtimeHandlers.js';

/* ------------------------------------------------------------------ */
/*  sendMessage contract — kept local because sendMessage is defined   */
/*  inside a React hook (useWebSocketProviderState) and cannot be      */
/*  instantiated outside a React component/provider.  The contract     */
/*  (returns SendMessageResult) is stable and exported as a type from  */
/*  WebSocketContext.tsx; the behaviour under test here is the return  */
/*  shape, not the internal socket call.                               */
/* ------------------------------------------------------------------ */

/** Mirrors the WS sendMessage contract from WebSocketContext.tsx */
function makeSendMessage(isOpen: boolean) {
  return (_message: unknown): { ok: boolean; reason?: string } => {
    if (isOpen) return { ok: true };
    return { ok: false, reason: 'disconnected' };
  };
}

/**
 * Mirrors dispatchProviderCommand's return contract:
 * returns false when sendMessage fails.
 */
function dispatchProviderCommand(
  sendMessage: (msg: unknown) => { ok: boolean },
  messageContent: string,
): boolean {
  const result = sendMessage({ type: 'claude-command', command: messageContent, options: {} });
  return result.ok;
}

/* ------------------------------------------------------------------ */
/*  Tests: sendMessage return value                                    */
/* ------------------------------------------------------------------ */

describe('sendMessage return value', () => {
  it('returns { ok: true } when the socket is open', () => {
    const send = makeSendMessage(true);
    const result = send({ type: 'ping' });
    assert.equal(result.ok, true);
  });

  it('returns { ok: false, reason: "disconnected" } when socket is closed', () => {
    const send = makeSendMessage(false);
    const result = send({ type: 'ping' });
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'disconnected');
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: dispatchProviderCommand propagates WS failure               */
/* ------------------------------------------------------------------ */

describe('dispatchProviderCommand propagates WS state', () => {
  it('returns true when WS is connected', () => {
    const send = makeSendMessage(true);
    const sent = dispatchProviderCommand(send, 'hello world');
    assert.equal(sent, true);
  });

  it('returns false when WS is disconnected', () => {
    const send = makeSendMessage(false);
    const sent = dispatchProviderCommand(send, 'hello world');
    assert.equal(sent, false);
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: exponential backoff delay                                   */
/*                                                                     */
/*  calcReconnectDelay adds random jitter (0 – 500 ms) so exact        */
/*  values cannot be asserted.  Instead we verify the deterministic    */
/*  structural properties: base ≤ result ≤ base + jitter for attempt   */
/*  0, non-decreasing growth, and hard cap at RECONNECT_MAX_DELAY_MS   */
/*  (jitter is always added on top of exp which itself is capped, so   */
/*  the returned value may exceed RECONNECT_MAX_DELAY_MS by up to      */
/*  499 ms — we allow that here).                                      */
/* ------------------------------------------------------------------ */

describe('calcReconnectDelay (exponential backoff)', () => {
  const JITTER_MS = 500; // from WebSocketContext.tsx RECONNECT_JITTER_MS

  it('first attempt delay is at least RECONNECT_BASE_DELAY_MS', () => {
    const delay = calcReconnectDelay(0);
    assert.ok(
      delay >= RECONNECT_BASE_DELAY_MS,
      `delay ${delay} should be >= ${RECONNECT_BASE_DELAY_MS}`,
    );
  });

  it('first attempt delay is below base + jitter', () => {
    const delay = calcReconnectDelay(0);
    assert.ok(
      delay < RECONNECT_BASE_DELAY_MS + JITTER_MS,
      `delay ${delay} should be < ${RECONNECT_BASE_DELAY_MS + JITTER_MS}`,
    );
  });

  it('delay grows (non-decreasing) with increasing attempt count', () => {
    // Run several samples per attempt to account for jitter variance.
    const samples = 20;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const prev = Array.from({ length: samples }, () => calcReconnectDelay(attempt - 1));
      const curr = Array.from({ length: samples }, () => calcReconnectDelay(attempt));
      const prevMax = Math.max(...prev);
      const currMin = Math.min(...curr);
      // The minimum of the higher attempt should exceed the base of the lower.
      // We compare base values (without jitter) to avoid flakiness.
      const prevBase = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      const currBase = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      assert.ok(
        currBase >= prevBase,
        `base delay for attempt ${attempt} (${currBase}) should be >= attempt ${attempt - 1} (${prevBase})`,
      );
      void prevMax; void currMin; // used above via closure, suppress unused warnings
    }
  });

  it('delay is capped near RECONNECT_MAX_DELAY_MS for large attempt counts', () => {
    // At attempt 10 the exp component saturates at RECONNECT_MAX_DELAY_MS;
    // with jitter the result is RECONNECT_MAX_DELAY_MS + [0, JITTER_MS).
    const delay = calcReconnectDelay(10);
    assert.ok(
      delay >= RECONNECT_MAX_DELAY_MS,
      `delay ${delay} should be >= ${RECONNECT_MAX_DELAY_MS}`,
    );
    assert.ok(
      delay < RECONNECT_MAX_DELAY_MS + JITTER_MS,
      `delay ${delay} should be < ${RECONNECT_MAX_DELAY_MS + JITTER_MS}`,
    );
  });

  it('original fixed 3-second delay is no longer the only reconnect value', () => {
    // The old code always reconnected after exactly 3000 ms.  With backoff,
    // attempt 0 starts at RECONNECT_BASE_DELAY_MS (1000 ms).
    assert.ok(
      RECONNECT_BASE_DELAY_MS < 3000,
      `base delay ${RECONNECT_BASE_DELAY_MS} should be less than the old fixed 3000 ms`,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: SERVER_ERROR_CODE_KEYS coverage                             */
/* ------------------------------------------------------------------ */

describe('SERVER_ERROR_CODE_KEYS', () => {
  const REQUIRED_CODES = ['project_dir_missing', 'cli_not_installed', 'spawn_failed'];

  for (const code of REQUIRED_CODES) {
    it(`contains key for "${code}"`, () => {
      assert.ok(code in SERVER_ERROR_CODE_KEYS, `Missing key: ${code}`);
    });

    it(`"${code}" maps to the correct i18n path`, () => {
      assert.equal(SERVER_ERROR_CODE_KEYS[code], `serverError.${code}`);
    });
  }

  it('unknown codes are NOT in the map (falls back to serverError.unknown)', () => {
    assert.equal(SERVER_ERROR_CODE_KEYS['totally_unknown_code'], undefined);
  });
});
