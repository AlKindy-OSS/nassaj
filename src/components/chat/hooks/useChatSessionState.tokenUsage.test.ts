import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readUsageFailure } from './useChatSessionState';

/**
 * B-823: the initial token-usage fetch used to blank state to `null` on any
 * non-2xx, so a server-side transcript miss rendered as "No token usage yet" —
 * indistinguishable from a session that had simply never run. The failure now
 * carries a marker the indicator can render as a failure.
 */
describe('initial token-usage failure handling', () => {
  it('carries the server reason and status', async () => {
    const response = new Response(
      JSON.stringify({ error: 'Session file not found', reason: 'transcript_unavailable' }),
      { status: 404 },
    );

    expect(await readUsageFailure(response)).toEqual({
      unavailable: true,
      reason: 'transcript_unavailable',
      status: 404,
    });
  });

  it('falls back to a generic reason for an unlabeled failure', async () => {
    const response = new Response('<html>gateway</html>', { status: 502 });

    expect(await readUsageFailure(response)).toEqual({
      unavailable: true,
      reason: 'lookup_failed',
      status: 502,
    });
  });

  it('no longer blanks the budget to null when the request fails', () => {
    const source = readFileSync(
      path.resolve(__dirname, 'useChatSessionState.ts'),
      'utf8',
    );
    const start = source.indexOf('const fetchInitialTokenUsage');
    expect(start).toBeGreaterThan(-1);
    const effect = source.slice(start, source.indexOf('fetchInitialTokenUsage();', start));

    expect(effect).toContain('readUsageFailure');
    expect(effect).not.toContain('setTokenBudget(null)');
  });
});
