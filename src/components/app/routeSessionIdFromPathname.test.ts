/**
 * B-1469 round 4, qa-critic round 1 fixes.
 *
 * `routeSessionIdFromPathname` replaced `useParams()` so that `/`,
 * `/session/:sessionId` and `/scheduled` could share one `<Route>` (see
 * `App.tsx`) without remounting `AppContent` between them. This covers the
 * two defects flagged in review: an unanchored match letting `/session/a/b`
 * resolve to `a`, and an uncaught `URIError` on malformed `%` escapes
 * crashing the whole render tree.
 *
 * RUNNER: vitest.
 */

import { describe, expect, it } from 'vitest';

import { routeSessionIdFromPathname } from './AppContent';

describe('routeSessionIdFromPathname', () => {
  it('reads a plain session id', () => {
    expect(routeSessionIdFromPathname('/session/abc123')).toBe('abc123');
  });

  it('accepts a single trailing slash', () => {
    expect(routeSessionIdFromPathname('/session/abc123/')).toBe('abc123');
  });

  it('decodes a percent-encoded id', () => {
    expect(routeSessionIdFromPathname('/session/%E2%9C%93')).toBe('✓');
  });

  it('falls back to the raw segment on malformed percent-encoding instead of throwing', () => {
    expect(() => routeSessionIdFromPathname('/session/%E0%A4%A')).not.toThrow();
    expect(routeSessionIdFromPathname('/session/%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('does not match an empty /session/ segment', () => {
    expect(routeSessionIdFromPathname('/session/')).toBeUndefined();
    expect(routeSessionIdFromPathname('/session')).toBeUndefined();
  });

  it('does not resolve a sub-path to its first segment (qa-critic round 1)', () => {
    expect(routeSessionIdFromPathname('/session/a/b')).toBeUndefined();
    expect(routeSessionIdFromPathname('/session/a/b/')).toBeUndefined();
  });

  it('does not match when query or hash text trails the id in the pathname itself', () => {
    // `location.pathname` never carries `?`/`#` (react-router splits those
    // into `.search`/`.hash`), but the parser must not silently mis-resolve
    // if it ever receives a raw unsplit string.
    expect(routeSessionIdFromPathname('/session/abc?x=1')).toBeUndefined();
    expect(routeSessionIdFromPathname('/session/abc#frag')).toBeUndefined();
  });

  it('returns undefined for unrelated paths', () => {
    expect(routeSessionIdFromPathname('/')).toBeUndefined();
    expect(routeSessionIdFromPathname('/scheduled')).toBeUndefined();
    expect(routeSessionIdFromPathname('/wiki')).toBeUndefined();
  });
});
