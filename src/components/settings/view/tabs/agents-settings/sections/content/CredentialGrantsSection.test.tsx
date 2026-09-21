/**
 * CredentialGrantsSection — صدق العرض لمشاركة الاعتماد من عضو إلى عضو (T-1675).
 *
 *  • صفحة الوكيل تعرض أعضاء الفريق كخانات، والمعلَّم منهم هو من يعمل باعتمادي،
 *    وبجانبه جوابه (يستخدمه / عاد إلى اعتماده).
 *  • حين يشاركني عضو اعتماده يظهر مبدّل «اعتمادي / اعتماد فلان»، وتنبيه حين
 *    يكون اعتماد الغير قيد الاستخدام.
 *  • وكيل بلا اعتماد يُفوَّض (sakana) لا يعرض شيئاً.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import type { CredentialGrantsOverview } from '../../../../../hooks/useCredentialGrants';

const overview: CredentialGrantsOverview = {
  providers: ['claude', 'codex'],
  members: [
    { id: 2, username: 'Jazari' },
    { id: 3, username: 'jalal' },
  ],
  given: [
    { provider: 'codex', userId: 2, username: 'Jazari', declined: false, createdAt: 't' },
    { provider: 'codex', userId: 3, username: 'jalal', declined: true, createdAt: 't' },
  ],
  received: [
    { provider: 'claude', ownerUserId: 2, ownerUsername: 'Jazari', declined: false, createdAt: 't', inUse: true },
  ],
};

const setGrantees = vi.fn(async () => true);
const selectGrant = vi.fn(async () => true);

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.owner ? `${key}:${String(options.owner)}` : options?.member ? `${key}:${String(options.member)}` : key,
  }),
}));

vi.mock('../../../../../../auth', () => ({
  useAuth: () => ({ user: { id: 1, role: 'user', username: 'me' } }),
}));

vi.mock('../../../../../hooks/useCredentialGrants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useCredentialGrants: () => ({
      overview,
      loading: false,
      saving: false,
      error: null,
      refresh: vi.fn(),
      setGrantees,
      selectGrant,
    }),
  };
});

import CredentialGrantsSection from './CredentialGrantsSection';

afterEach(() => {
  cleanup();
  setGrantees.mockClear();
  selectGrant.mockClear();
});

describe('CredentialGrantsSection', () => {
  it('codex: الممنوحون شرائط بجواب كلٍّ منهم، والحقل يعرض غير الممنوحين فقط', () => {
    render(<CredentialGrantsSection agent="codex" />);

    assert.equal(screen.queryByText('credentialGrants.given.using'), null);
    assert.ok(screen.getByText('credentialGrants.given.declined'));
    assert.equal(screen.queryAllByRole('radio').length, 0);

    fireEvent.click(screen.getByRole('combobox'));
    // الاثنان ممنوحان ⇒ لا مرشّح.
    assert.ok(screen.getByText('credentialGrants.given.noMatch'));
  });

  it('زرّ الإزالة على الشريط يرسل المجموعة الجديدة بلا تأكيد', async () => {
    render(<CredentialGrantsSection agent="codex" />);

    fireEvent.click(screen.getByLabelText('credentialGrants.given.remove:Jazari'));
    await waitFor(() => assert.equal(setGrantees.mock.calls.length, 1));
    assert.deepEqual(setGrantees.mock.calls[0], ['codex', [3]]);
  });

  it('claude: الكتابة تُرشّح القائمة، والاختيار يرسل المجموعة مباشرة', async () => {
    render(<CredentialGrantsSection agent="claude" />);

    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: 'jal' } });
    const options = screen.getAllByRole('option');
    assert.equal(options.length, 1);
    assert.equal(options[0].textContent, 'jalal');

    fireEvent.mouseDown(options[0]);
    await waitFor(() => assert.equal(setGrantees.mock.calls.length, 1));
    assert.deepEqual(setGrantees.mock.calls[0], ['claude', [3]]);
  });

  it('claude: اعتماد Jazari قيد الاستخدام ⇒ التنبيه والمبدّل، والعودة لاعتمادي ترسل null', async () => {
    render(<CredentialGrantsSection agent="claude" />);

    assert.ok(screen.getByText('credentialGrants.received.inUse:Jazari'));
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    assert.equal(radios.length, 2);
    assert.equal(radios[1].checked, true);

    fireEvent.click(radios[0]);
    await waitFor(() => assert.equal(selectGrant.mock.calls.length, 1));
    assert.deepEqual(selectGrant.mock.calls[0], ['claude', null]);
  });

  it('antigravity يُخاطَب بوحدة gemini، وsakana لا يعرض شيئاً', () => {
    const { container } = render(<CredentialGrantsSection agent="sakana" />);
    assert.equal(container.textContent, '');
    cleanup();
    render(<CredentialGrantsSection agent="antigravity" />);
    assert.ok(screen.getByText('credentialGrants.given.pairedNote'));
  });
});
