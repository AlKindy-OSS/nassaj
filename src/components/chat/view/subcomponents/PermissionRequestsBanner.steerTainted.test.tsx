/**
 * T-1903 (ADR-190) / T-1904 e2e (bug 6) — a permission request that follows a
 * colleague's mid-turn steer (`steerTainted:true`) must never offer the
 * persist/"allow and remember" option: a saved rule under taint would
 * silently pre-approve unrelated future runs too. Only once/deny remain.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key),
  }),
}));

import type { PendingPermissionRequest } from '../../types/types';

import PermissionRequestsBanner from './PermissionRequestsBanner';

afterEach(cleanup);

function request(overrides: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest {
  return {
    requestId: 'r1',
    toolName: 'Write',
    input: { file_path: 'steer.txt' },
    ...overrides,
  };
}

describe('PermissionRequestsBanner — steerTainted', () => {
  it('shows all three actions for an ordinary (non-tainted) request', () => {
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[request()]}
        handlePermissionDecision={vi.fn()}
        handleGrantToolPermission={vi.fn()}
      />,
    );
    expect(screen.getByText('permissions.allowOnce')).not.toBeNull();
    expect(screen.getByText('permissions.allowAndRemember')).not.toBeNull();
    expect(screen.getByText('permissions.deny')).not.toBeNull();
  });

  it('hides the persist/"allow and remember" option for a steer-tainted request', () => {
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[request({ steerTainted: true })]}
        handlePermissionDecision={vi.fn()}
        handleGrantToolPermission={vi.fn()}
      />,
    );
    expect(screen.getByText('permissions.allowOnce')).not.toBeNull();
    expect(screen.getByText('permissions.deny')).not.toBeNull();
    expect(screen.queryByText('permissions.allowAndRemember')).toBeNull();
    expect(screen.queryByText('permissions.allowSaved')).toBeNull();
  });
});
