/**
 * T-2083 — the outbox card of a turn refused with CREDENTIAL_NOT_LINKED shows
 * the not-linked notice with its two actions instead of a bare error code.
 * RUNNER: vitest (jsdom).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { OutboxEntry } from '../../utils/messageOutbox';

import OutboxCard from './OutboxCard';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (
      opts && 'provider' in opts ? `${key}:${String(opts.provider)}` : (opts?.defaultValue as string) || key
    ),
    i18n: { language: 'ar' },
  }),
}));
vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { role: 'user' } }),
}));
vi.mock('../../../../contexts/PaletteOpsContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePaletteOps: () => ({ openFile: vi.fn(), openSettings: vi.fn(), refreshProjects: vi.fn() }),
}));
vi.mock('../../utils/messageOutbox', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readOutboxImages: async () => [],
}));

const entry: OutboxEntry = {
  id: 'm1', projectId: 'p', sessionId: null, text: 'hello', createdAt: Date.now(),
  status: 'failed', reasonCode: 'CREDENTIAL_NOT_LINKED', reasonDetail: null, imageNames: [], intent: {},
  credential: { provider: 'claude', reason: 'not_linked', grantorUsername: null, settingsAgent: 'claude' },
};
const noop = vi.fn();

afterEach(cleanup);

describe('OutboxCard: CREDENTIAL_NOT_LINKED', () => {
  it('renders the notice with both actions, and keeps delete', () => {
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    const notice = screen.getByTestId('credential-not-linked');
    expect(notice.textContent).toContain('credential.notLinked.title:');
    expect(notice.textContent).toContain('Claude');
    expect(screen.getByRole('button', { name: /credential\.actions\.linkOwn/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /credential\.actions\.requestShare/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /outbox\.delete/ })).toBeTruthy();
    expect(screen.queryByText(/CREDENTIAL_NOT_LINKED/)).toBeNull();
  });

  it('an entry stored without the payload (code only) still shows the notice', () => {
    render(<OutboxCard entry={{ ...entry, credential: undefined }} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.getByTestId('credential-not-linked').textContent).toContain('credential.notLinked.titleGeneric');
  });
});
