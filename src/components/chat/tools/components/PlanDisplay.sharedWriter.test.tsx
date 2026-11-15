/**
 * ADR-173 M-c — a plan approval seen by a member who did not start the turn is
 * read-only: no Build / Revise, only "waiting for the starter".
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import PermissionContext, { type PermissionContextValue } from '../../../../contexts/PermissionContext';

import { PlanDisplay } from './PlanDisplay';

afterEach(cleanup);

function renderAs(role: 'starter' | 'non_starter' | 'read_only' | undefined) {
  const value: PermissionContextValue = {
    pendingPermissionRequests: [{ requestId: 'p1', toolName: 'ExitPlanMode', input: {} }],
    handlePermissionDecision: vi.fn(),
    ...(role ? { answerRole: () => role } : {}),
  };
  render(
    <PermissionContext.Provider value={value}>
      <PlanDisplay title="Plan" content="do it" toolName="ExitPlanMode" />
    </PermissionContext.Provider>,
  );
}

describe('PlanDisplay plan approval', () => {
  it('offers Build and Revise to the starter (and when roles are unknown)', () => {
    renderAs('starter');
    expect(screen.queryByText('plan.build')).not.toBeNull();
    cleanup();
    renderAs(undefined);
    expect(screen.queryByText('plan.revise')).not.toBeNull();
  });

  it('is read-only for a member who did not start the turn', () => {
    renderAs('non_starter');
    expect(screen.queryByText('plan.build')).toBeNull();
    expect(screen.queryByText('plan.revise')).toBeNull();
    expect(screen.getByText('plan.waitingStarter')).not.toBeNull();
  });
});
