// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { placementPresentation, targetPresentation } from './connectorPlacementState';

describe('connector placement presentation', () => {
  it('claims next-session availability only from the explicit server truth', () => {
    expect(placementPresentation('healthy', true)).toEqual({ key: 'available', tone: 'success' });
    expect(placementPresentation('healthy', false)).toEqual({ key: 'degraded', tone: 'danger' });
    expect(placementPresentation('partial', true)).toEqual({ key: 'partial', tone: 'warning' });
  });

  it('keeps partial, blocked, pending and untracked visibly distinct', () => {
    expect(placementPresentation('partial', false).key).toBe('partial');
    expect(placementPresentation('blocked', false).key).toBe('blocked');
    expect(placementPresentation('pending', false).key).toBe('pending');
    expect(placementPresentation('untracked', false).key).toBe('untracked');
  });

  it('requires both target fields before an engine is green', () => {
    const base = {
      provider: 'claude' as const,
      desiredGeneration: 1,
      appliedGeneration: 1,
      attemptCount: 0,
      nextRetryAt: null,
      lastErrorCode: null,
    };
    expect(targetPresentation({ ...base, state: 'healthy', healthy: true }).tone).toBe('success');
    expect(targetPresentation({ ...base, state: 'healthy', healthy: false }).tone).not.toBe('success');
  });
});
