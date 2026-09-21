import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch } from '../../../utils/api';

import QwenConnectTerminal from './QwenConnectTerminal';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Qwen managed connection terminal', () => {
  it('keeps the secret in a password field and posts Token Plan metadata', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue({ ok: true } as Response);
    const onComplete = vi.fn();
    render(<QwenConnectTerminal onClose={vi.fn()} onComplete={onComplete} />);

    fireEvent.click(screen.getByLabelText('Token Plan'));
    const keyField = screen.getByLabelText('Access key');
    expect(keyField.getAttribute('type')).toBe('password');
    fireEvent.change(keyField, { target: { value: 'token-plan-secret-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledOnce());
    const [, init] = vi.mocked(authenticatedFetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      apiKey: 'token-plan-secret-123',
      plan: 'token_plan',
      region: 'international',
    });
    expect(onComplete).toHaveBeenCalledWith(0);
    expect(screen.getByText('Qwen is connected')).toBeTruthy();
    expect(document.body.textContent).not.toContain('token-plan-secret-123');
  });

  it('never renders a reflected server error containing the submitted secret', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Rejected token-plan-secret-456' } }),
    } as Response);
    render(<QwenConnectTerminal onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Token Plan'));
    fireEvent.change(screen.getByLabelText('Access key'), {
      target: { value: 'token-plan-secret-456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save and connect' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(document.body.textContent).not.toContain('token-plan-secret-456');
  });
});
