// ADR-H20 N2: the owner step-up prompt opens on owner_step_up_required, starts
// the passkey round trip, reports a failed start, and can be dismissed.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import enAuth from '../../../i18n/locales/en/auth.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), enAuth,
    ) as string,
  }),
}));
const start = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock('../ssoLinkedSession', () => ({ startOwnerStepUp: () => start() }));

import { dispatchOwnerStepUp } from '../../../utils/api';

import OwnerStepUpPrompt from './OwnerStepUpPrompt';

afterEach(() => {
  cleanup();
  start.mockReset();
});

describe('OwnerStepUpPrompt', () => {
  it('is hidden until a privileged action is refused, then offers the passkey step-up', async () => {
    render(<OwnerStepUpPrompt />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => { dispatchOwnerStepUp(); });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText(enAuth.sso.ownerStepUp.title)).toBeTruthy();
    start.mockResolvedValue(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: enAuth.sso.ownerStepUp.button })); });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reports a step-up that could not start, and can be dismissed', async () => {
    render(<OwnerStepUpPrompt />);
    await act(async () => { dispatchOwnerStepUp(); });
    start.mockResolvedValue(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: enAuth.sso.ownerStepUp.button })); });
    expect(screen.getByRole('alert').textContent).toBe(enAuth.sso.ownerStepUp.failed);
    fireEvent.click(screen.getByRole('button', { name: enAuth.sso.ownerStepUp.dismiss }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
