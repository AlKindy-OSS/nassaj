/**
 * CredentialNotLinkedNotice — the AT1 message (ADR-152 A1 §6): a clear Arabic
 * message that the member has not linked an account, with "link my account"
 * and "ask a member to share" actions. Rendered against the real Arabic and
 * English locale files so a missing key fails here, not on screen.
 * RUNNER: vitest (jsdom).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arCommon from '../../i18n/locales/ar/common.json';
import enCommon from '../../i18n/locales/en/common.json';

let locale: Record<string, unknown> = arCommon;
function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    locale,
  );
  return typeof value === 'string' ? value : undefined;
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (lookup(key) ?? `MISSING:${key}`)
      .replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name] ?? '')),
  }),
}));

const openSettings = vi.fn();
vi.mock('../../contexts/PaletteOpsContext', () => ({ usePaletteOps: () => ({ openSettings }) }));

import CredentialNotLinkedNotice from './CredentialNotLinkedNotice';
import type { CredentialNotLinkedInfo } from './credentialNotLinked';

const strip = (text: string | null | undefined) => (text ?? '').replace(/[⁦-⁩]/g, '');
const claude: CredentialNotLinkedInfo = {
  provider: 'claude', reason: 'not_linked', grantorUsername: null, settingsAgent: 'claude',
};

beforeEach(() => { locale = arCommon; openSettings.mockReset(); });
afterEach(cleanup);

describe('CredentialNotLinkedNotice', () => {
  it('says, in Arabic, that Claude is not linked and what to do', () => {
    render(<CredentialNotLinkedNotice info={claude} />);
    const region = screen.getByRole('alert');
    expect(strip(region.textContent)).toContain('Claude غير مربوط بحسابك');
    expect(strip(region.textContent)).toContain('اربط حسابك أو اطلب من صاحب الحساب مشاركته معك.');
    expect(region.textContent).not.toContain('MISSING');
  });

  it('link my account opens the agent account; ask a member opens the grants section', () => {
    const onNavigate = vi.fn();
    render(<CredentialNotLinkedNotice info={claude} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'اربط حسابي' }));
    expect(openSettings).toHaveBeenLastCalledWith('agents', { tab: 'agents', agent: 'claude', category: 'account' });
    fireEvent.click(screen.getByRole('button', { name: 'اطلب من عضو مشاركته' }));
    expect(openSettings).toHaveBeenLastCalledWith('agents', {
      tab: 'agents', agent: 'claude', category: 'account', section: 'credential-grants',
    });
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it('names the grantor when their shared credential is no longer linked', () => {
    render(<CredentialNotLinkedNotice info={{ ...claude, reason: 'grantor_not_linked', grantorUsername: 'ibrahim' }} />);
    const text = strip(screen.getByRole('alert').textContent);
    expect(text).toContain('شاركه معك ibrahim');
  });

  it('code-only: a generic title and both actions still work', () => {
    render(<CredentialNotLinkedNotice info={{ provider: null, reason: 'not_linked', grantorUsername: null, settingsAgent: null }} />);
    expect(screen.getByRole('alert').textContent).toContain('هذا الوكيل غير مربوط بحسابك');
    fireEvent.click(screen.getByRole('button', { name: 'اربط حسابي' }));
    expect(openSettings).toHaveBeenLastCalledWith('agents', { tab: 'agents', category: 'account' });
  });

  it('a provider without an agent page offers only the link action', () => {
    render(<CredentialNotLinkedNotice info={{ ...claude, provider: 'glm', settingsAgent: 'glm' }} />);
    expect(strip(screen.getByRole('alert').textContent)).toContain('GLM غير مربوط بحسابك');
    expect(screen.queryByRole('button', { name: 'اطلب من عضو مشاركته' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اربط حسابي' }));
    expect(openSettings).toHaveBeenLastCalledWith('vendors', { tab: 'vendors' });
  });

  it('English locale has every string', () => {
    locale = enCommon;
    render(<CredentialNotLinkedNotice info={{ ...claude, reason: 'grantor_not_linked', grantorUsername: 'ibrahim' }} />);
    const text = strip(screen.getByRole('alert').textContent);
    expect(text).toContain('Claude is not linked to your account');
    expect(text).toContain('ibrahim shared this with you');
    expect(screen.getByRole('button', { name: 'Link my account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask a member to share' })).toBeTruthy();
  });
});
