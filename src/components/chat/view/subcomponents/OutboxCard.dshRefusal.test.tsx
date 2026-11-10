/**
 * T-2086 (ADR-224) — a dsh turn refused before it starts stays visible as the
 * outbox card (draft kept) with plain localized copy per code; the server's
 * Arabic sentence is not appended. `dsh_tree_unverified` reads as "starting
 * up, try again", not as an error. RUNNER: vitest (jsdom).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import ar from '../../../../i18n/locales/ar/chat.json';
import en from '../../../../i18n/locales/en/chat.json';
import { DSH_REFUSAL_CODES } from '../../utils/dshRefusal';
import { resolveOutboxVerdict, type OutboxEntry } from '../../utils/messageOutbox';
import { SERVER_ERROR_CODE_KEYS } from '../../utils/serverErrorMessage';

import OutboxCard from './OutboxCard';

const lookup = (bundle: unknown, key: string): string | undefined => key.split('.')
  .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), bundle) as
  string | undefined;

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => lookup(en, key) ?? (opts?.defaultValue as string) ?? key,
    i18n: { language: 'en' },
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

const LISTED = [
  'dsh_permission_mode_unsupported', 'dsh_permission_rule_unsupported', 'dsh_claude_hooks_unsupported',
  'PERMISSION_EFFECTIVE_POLICY_REQUIRED', 'dsh_coordination_unsupported', 'dsh_shared_session_unsupported',
  'dsh_session_unknown', 'dsh_session_id_invalid', 'dsh_effort_unsupported', 'session_busy',
  'governance_missing', 'dsh_cwd_missing', 'dsh_tree_tampered', 'dsh_tree_unverified', 'dsh_tree_unmanaged',
  // T-2089/ADR-225: the Claude-parity engine.
  'dsh_claude_sandbox_unsupported', 'dsh_policy_violation', 'dsh_prompt_blocked',
  // T-2091: capability probes and guard incidents (dsh_cap_gate replaced dsh_policy_handshake_failed).
  'dsh_cap_channel', 'dsh_cap_tools_api', 'dsh_cap_gate', 'dsh_gate_bypassed', 'dsh_post_hook_skipped',
  'dsh_override_unverified',
];

const entry = (reasonCode: string): OutboxEntry => ({
  id: 'm1', projectId: 'p', sessionId: 's1', text: 'my draft', createdAt: Date.now(),
  status: 'failed', reasonCode, reasonDetail: null, imageNames: [], intent: { provider: 'dsh' },
});
const noop = vi.fn();
const reasonOf = (code: string) => lookup(en, SERVER_ERROR_CODE_KEYS[code]);

afterEach(cleanup);

describe('dsh refusal copy', () => {
  it.each(LISTED)('%s has plain ar and en copy', (code) => {
    expect(DSH_REFUSAL_CODES.has(code)).toBe(true);
    const key = SERVER_ERROR_CODE_KEYS[code];
    expect(key).toBeTruthy();
    expect(lookup(en, key)).toMatch(/\w/);
    expect(lookup(ar, key)).toMatch(/[؀-ۿ]/);
    expect(lookup(en, key)).not.toMatch(/[؀-ۿ]/);
  });

  it('the verdict keeps the code and drops the server sentence for a dsh refusal', () => {
    const verdict = resolveOutboxVerdict({
      kind: 'complete', clientMsgId: 'm1', success: false, notStarted: true, provider: 'dsh',
      code: 'dsh_permission_mode_unsupported', error: 'نص الخادم',
    } as never, { isActiveViewSession: true, readErrorCode: (m) => (m as { code: string }).code, readErrorDetail: () => null });
    expect(verdict).toMatchObject({ action: 'fail', code: 'dsh_permission_mode_unsupported', detail: null });
  });

  it('another provider keeps its server sentence', () => {
    const verdict = resolveOutboxVerdict({
      kind: 'complete', clientMsgId: 'm1', success: false, provider: 'claude', code: 'session_busy', error: 'busy',
    } as never, { isActiveViewSession: true, readErrorCode: (m) => (m as { code: string }).code, readErrorDetail: () => null });
    expect(verdict).toMatchObject({ detail: 'busy' });
  });
});

describe('retired code', () => {
  it('dsh_policy_handshake_failed is gone, replaced by dsh_cap_gate', () => {
    expect(DSH_REFUSAL_CODES.has('dsh_policy_handshake_failed')).toBe(false);
    expect(SERVER_ERROR_CODE_KEYS.dsh_policy_handshake_failed).toBeUndefined();
  });
});

describe('OutboxCard: dsh refusals', () => {
  it('permission mode refusal suggests switching the mode and keeps the draft', () => {
    render(<OutboxCard entry={entry('dsh_permission_mode_unsupported')} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    const card = screen.getByTestId('outbox-card');
    expect(card.textContent).toContain(reasonOf('dsh_permission_mode_unsupported'));
    expect(reasonOf('dsh_permission_mode_unsupported')).toMatch(/permission mode/i);
    expect(card.textContent).toContain('my draft');
    expect(screen.getByRole('button', { name: en.outbox.edit })).toBeTruthy();
  });

  it.each([
    ['dsh_permission_rule_unsupported', /rule/i],
    ['dsh_claude_hooks_unsupported', /hook|plugin/i],
    ['dsh_claude_sandbox_unsupported', /sandbox/i],
    ['dsh_cap_gate', /every tool/i],
    ['dsh_policy_violation', /without Nassaj's approval/i],
  ])('%s names its narrow cause and no longer claims every protection is missing', (code, cause) => {
    expect(reasonOf(code)).toMatch(cause);
    expect(reasonOf(code)).not.toMatch(/Claude protections/);
  });

  it('a blocked prompt shows the guard reason in an isolated block, not mixed into the sentence', () => {
    const verdict = resolveOutboxVerdict({
      kind: 'complete', clientMsgId: 'm1', success: false, notStarted: true, provider: 'dsh',
      code: 'dsh_prompt_blocked', error: 'Blocked: no secrets in prompts',
    } as never, { isActiveViewSession: true, readErrorCode: (m) => (m as { code: string }).code, readErrorDetail: () => null });
    expect(verdict).toMatchObject({ code: 'dsh_prompt_blocked', detail: 'Blocked: no secrets in prompts' });
    render(<OutboxCard entry={{ ...entry('dsh_prompt_blocked'), reasonDetail: 'Blocked: no secrets in prompts' }}
      onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    const card = screen.getByTestId('outbox-card');
    expect(card.textContent).toContain(reasonOf('dsh_prompt_blocked'));
    const guard = card.querySelector('bdi[data-testid="outbox-guard-reason"]');
    expect(guard?.textContent).toBe('Blocked: no secrets in prompts');
    expect(card.textContent).not.toContain('(Blocked');
  });

  it('tree unverified reads as starting up with a retry, not as a failure', () => {
    render(<OutboxCard entry={entry('dsh_tree_unverified')} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    const card = screen.getByTestId('outbox-card');
    expect(card.textContent).toContain(en.outbox.titleStarting);
    expect(card.textContent).not.toContain(en.outbox.titleFailed);
    expect(card.textContent).toMatch(/few seconds/i);
    expect(card.className).not.toMatch(/red/);
    expect(screen.getByRole('button', { name: en.outbox.tryAgain })).toBeTruthy();
  });
});
