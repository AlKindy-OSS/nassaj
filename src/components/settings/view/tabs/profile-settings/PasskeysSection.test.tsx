/**
 * T-1939 slice 6A (B-1407): adding a passkey asks for the current password
 * (or an eligible passkey) first, a refused step-up shows a precise message,
 * and passkeys enrolled before the check carry a "re-register" badge.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../../i18n/locales/en/settings.json';

function lookup(tree: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof value === 'string' ? value : undefined;
}

// A stable translator, like react-i18next's: the section's loaders depend on `t`.
const translation = { t: (key: string) => lookup(enSettings, key) ?? key, i18n: { language: 'en' } };
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

const mocks = vi.hoisted(() => ({
  listCredentials: vi.fn<() => Promise<Response>>(),
  registerPasskey: vi.fn(),
}));
vi.mock('../../../../../utils/api', () => ({
  api: { auth: { webauthn: { listCredentials: mocks.listCredentials } } },
}));
vi.mock('../../../../auth/hooks/useWebAuthn', () => ({
  useWebAuthn: () => ({ isSupported: true, registerPasskey: mocks.registerPasskey }),
}));

import PasskeysSection from './PasskeysSection';

const passkeys = enSettings.profile.passkeys;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const credential = (id: string, eligible: number) => ({
  id, user_id: 1, counter: 0, transports: null, device_type: 'singleDevice', backed_up: 0,
  aaguid: null, name: id, created_at: '2026-09-01 10:00:00', last_used_at: null, step_up_eligible: eligible,
});

beforeEach(() => {
  mocks.listCredentials.mockReset();
  mocks.registerPasskey.mockReset();
});
afterEach(() => cleanup());

async function openAddForm() {
  fireEvent.click(await screen.findByRole('button', { name: passkeys.add }));
  return screen.getByLabelText(passkeys.stepUp.passwordLabel);
}

describe('PasskeysSection step-up', () => {
  it('asks for the current password and sends it as step-up evidence', async () => {
    mocks.listCredentials.mockResolvedValue(json(200, { credentials: [] }));
    mocks.registerPasskey.mockResolvedValue({ success: true, credential: credential('new', 1) });
    render(<PasskeysSection />);

    const password = await openAddForm();
    const create = screen.getByRole('button', { name: passkeys.create });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: passkeys.stepUp.usePasskey })).toBeNull();

    fireEvent.change(password, { target: { value: 'hunter22' } });
    fireEvent.click(create);

    await waitFor(() => expect(screen.getByText(passkeys.success.added)).toBeTruthy());
    expect(mocks.registerPasskey).toHaveBeenCalledWith('', { method: 'password', password: 'hunter22' });
  });

  it('maps a refused step-up to its message and clears the password', async () => {
    mocks.listCredentials.mockResolvedValue(json(200, { credentials: [] }));
    mocks.registerPasskey.mockResolvedValue({
      success: false, kind: 'stepUp', code: 'step_up_failed', error: 'Verification failed',
    });
    render(<PasskeysSection />);

    const password = await openAddForm();
    fireEvent.change(password, { target: { value: 'wrong-one' } });
    fireEvent.click(screen.getByRole('button', { name: passkeys.create }));

    await waitFor(() => expect(screen.getByText(passkeys.errors.stepUpFailed)).toBeTruthy());
    expect((password as HTMLInputElement).value).toBe('');
  });

  it('offers an existing eligible passkey as the step-up and badges legacy passkeys', async () => {
    mocks.listCredentials.mockResolvedValue(json(200, {
      credentials: [credential('eligible-key', 1), credential('legacy-key', 0)],
    }));
    mocks.registerPasskey.mockResolvedValue({ success: false, kind: 'cancelled' });
    render(<PasskeysSection />);

    await screen.findByText('legacy-key');
    expect(screen.getAllByText(passkeys.badges.reRegister)).toHaveLength(1);
    expect(screen.getAllByText(passkeys.reRegisterHint)).toHaveLength(1);

    await openAddForm();
    fireEvent.click(screen.getByRole('button', { name: passkeys.stepUp.usePasskey }));
    await waitFor(() => expect(mocks.registerPasskey).toHaveBeenCalledWith('', { method: 'passkey' }));
  });

  it('ships every new string in Arabic too', () => {
    const keys = [
      'stepUp.intro', 'stepUp.passwordLabel', 'stepUp.usePasskey', 'badges.reRegister', 'reRegisterHint',
      'errors.stepUpFailed', 'errors.stepUpRateLimited', 'errors.ssoStepUp', 'errors.passwordChange',
      'errors.noEligiblePasskey',
    ];
    for (const key of keys) {
      expect(lookup(arSettings, `profile.passkeys.${key}`), key).toBeTruthy();
      expect(lookup(enSettings, `profile.passkeys.${key}`), key).toBeTruthy();
    }
    expect(arSettings.profile.passkeys.badges.reRegister).toBe('أعد تسجيله للعمليات الحساسة');
    expect(enSettings.profile.passkeys.badges.reRegister).toBe('Re-register for sensitive actions');
  });
});
