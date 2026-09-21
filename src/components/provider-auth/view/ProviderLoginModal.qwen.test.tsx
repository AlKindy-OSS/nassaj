import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProviderLoginModal from './ProviderLoginModal';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; provider?: string }) =>
      options?.defaultValue?.replace('{{provider}}', options.provider ?? '') ?? _key,
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

afterEach(cleanup);

describe('ProviderLoginModal — Qwen', () => {
  it('renders the managed credential terminal rather than a shell command', () => {
    render(<ProviderLoginModal isOpen provider="qwen" onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Connect Qwen' })).toBeTruthy();
    expect(screen.getByLabelText('Access key').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('Coding Plan')).toBeTruthy();
    expect(screen.getByLabelText('Token Plan')).toBeTruthy();
    expect(screen.queryByText(/No login command configured/)).toBeNull();
  });
});
