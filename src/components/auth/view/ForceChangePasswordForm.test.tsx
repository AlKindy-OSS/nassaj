import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const changePassword = vi.hoisted(() => vi.fn());
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ changePassword }) }));
vi.mock('./AuthScreenLayout', () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

import ForceChangePasswordForm from './ForceChangePasswordForm';

afterEach(() => { cleanup(); changePassword.mockReset(); });

function submit(current: string) {
  render(<ForceChangePasswordForm />);
  fireEvent.change(document.getElementById('current-password')!, { target: { value: current } });
  fireEvent.change(document.getElementById('new-password')!, { target: { value: 'permanent-password' } });
  fireEvent.change(document.getElementById('confirm-password')!, { target: { value: 'permanent-password' } });
  fireEvent.submit(document.querySelector('form')!);
}

it('B-1533: shows the translated wrong-temporary-password message for the coded 401', async () => {
  changePassword.mockResolvedValue({
    success: false, error: 'Current password is incorrect', code: 'current_password_incorrect',
  });
  submit('wrong-temp');
  expect(await screen.findByText('forceChangePassword.errors.incorrectCurrent')).toBeTruthy();
  expect(changePassword).toHaveBeenCalledWith('wrong-temp', 'permanent-password');
});

it('keeps the server message for any other failure', async () => {
  changePassword.mockResolvedValue({ success: false, error: 'Network error. Please try again.' });
  submit('temp');
  expect(await screen.findByText('Network error. Please try again.')).toBeTruthy();
});
