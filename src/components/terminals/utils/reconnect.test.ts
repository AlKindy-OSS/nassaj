/**
 * Unit tests for the standalone-terminal close-code classifier and the shared
 * backoff re-export. Imports the REAL production functions so a regression in
 * the final-vs-reconnect routing is caught here.
 *
 * Runs under `npm run test:client` (vitest).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_RECONNECT_ATTEMPTS,
  classifyTerminalClose,
  computeBackoffDelay,
  shouldRetryReconnect,
} from './reconnect';

describe('classifyTerminalClose', () => {
  it('maps the policy codes to their final dispositions (no auto-loop)', () => {
    expect(classifyTerminalClose(4409)).toBe('superseded');
    expect(classifyTerminalClose(4404)).toBe('notFound');
    expect(classifyTerminalClose(4403)).toBe('forbidden');
    expect(classifyTerminalClose(1001)).toBe('serverRestart');
  });

  it('routes abnormal / unknown drops to reconnect', () => {
    // 1006 keepalive cull is the headline case.
    expect(classifyTerminalClose(1006)).toBe('reconnect');
    // Any other unexpected close also re-attaches rather than dying.
    expect(classifyTerminalClose(1011)).toBe('reconnect');
    expect(classifyTerminalClose(1005)).toBe('reconnect');
  });

  it('never classifies a final code as reconnect (loop safety)', () => {
    for (const finalCode of [4409, 4404, 4403, 1001]) {
      expect(classifyTerminalClose(finalCode)).not.toBe('reconnect');
    }
  });
});

describe('shared backoff re-export', () => {
  it('exposes the same capped exponential backoff as the shell util', () => {
    expect(computeBackoffDelay(0)).toBe(1000);
    expect(computeBackoffDelay(3)).toBe(8000);
    expect(computeBackoffDelay(10)).toBe(10000);
  });

  it('caps the number of auto re-attach attempts', () => {
    expect(shouldRetryReconnect(MAX_RECONNECT_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetryReconnect(MAX_RECONNECT_ATTEMPTS)).toBe(false);
  });
});
