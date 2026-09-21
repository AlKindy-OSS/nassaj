import { describe, expect, it } from 'vitest';

import { getShellVisualViewportGeometry } from './visualViewportGeometry';

describe('getShellVisualViewportGeometry', () => {
  it('keeps a valid mobile visual viewport', () => {
    expect(getShellVisualViewportGeometry({ height: 712, offsetTop: 48, scale: 1 }))
      .toEqual({ height: 712, top: 48 });
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an unusable initial height (%s) so CSS retains its full-height fallback',
    (height) => {
      expect(getShellVisualViewportGeometry({ height, offsetTop: 0, scale: 1 })).toBeNull();
    },
  );

  it('rejects pinch-zoom geometry', () => {
    expect(getShellVisualViewportGeometry({ height: 360, offsetTop: 120, scale: 2 })).toBeNull();
  });

  it('rejects invalid offsets and scale values', () => {
    expect(getShellVisualViewportGeometry({ height: 712, offsetTop: -1, scale: 1 })).toBeNull();
    expect(getShellVisualViewportGeometry({ height: 712, offsetTop: 0, scale: 0 })).toBeNull();
  });
});
