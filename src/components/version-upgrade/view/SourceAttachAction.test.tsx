/**
 * ADR-216 §3.4 + test 15 — owner-only "repair release-branch link": visibility,
 * offered → running → succeeded with a queued restart, refusals (writers with
 * terminals, generic), failure, restart pending and the double-submit guard.
 * The API is mocked; i18n is real so the owner's wording is asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import arCommon from '../../../i18n/locales/ar/common.json';
import enCommon from '../../../i18n/locales/en/common.json';

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

let role: string | undefined = 'owner';
vi.mock('../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { role } }),
}));

const { SourceAttachAction } = await import('./SourceAttachAction');

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { ar: { common: arCommon }, en: { common: enCommon } },
  lng: 'ar', fallbackLng: 'en', ns: ['common'], defaultNS: 'common',
  interpolation: { escapeValue: false }, react: { useSuspense: false },
});

const SA = arCommon.versionUpdate.sourceAttach;
const HEAD = 'a'.repeat(40);
const OP = '11111111-2222-4333-8444-555555555555';
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
const eligible = (extra: Record<string, unknown> = {}) => reply(200, {
  eligible: true, reason: null, version: '2.3.2.1', tag: 'v2.3.2.1', headCommit: HEAD, restartPending: false,
  operation: null, ...extra,
});
const operation = (extra: Record<string, unknown>) => reply(200, {
  operationId: OP, state: 'running', code: null, step: 'inspect', restartActionId: null, restartCode: null,
  restartReused: null, openTerminals: null, startedAt: null, finishedAt: null, ...extra,
});

/** Route GET / POST / poll to queued replies; records every call. */
function route(replies: { get?: Response[]; post?: Response[]; poll?: Response[] }) {
  authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
    const queue = init?.method === 'POST' ? replies.post : url.includes('/operations/') ? replies.poll : replies.get;
    const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    return Promise.resolve(next ?? reply(500, {}));
  });
}

async function mount(props: { offered?: boolean; restartPending?: boolean } = {}) {
  await act(async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SourceAttachAction offered={props.offered ?? true} restartPending={props.restartPending ?? false} />
      </I18nextProvider>,
    );
  });
}

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const posts = () => authenticatedFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

describe('SourceAttachAction', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }); authenticatedFetch.mockReset(); role = 'owner'; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('runs offered → running → succeeded and names the command-board next step', async () => {
    route({
      get: [eligible()],
      post: [reply(202, { operationId: OP })],
      poll: [operation({ step: 'prove' }), operation({ state: 'succeeded', step: 'apply', restartActionId: 'act-1', restartReused: false })],
    });
    await mount();
    const button = screen.getByRole('button', { name: SA.button });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ expectedHead: HEAD });
    expect((screen.getByRole('button', { name: SA.button }) as HTMLButtonElement).disabled).toBe(true);
    await flush(2_000);
    expect(screen.getByText(SA.running.replace('{{step}}', SA.steps.prove))).toBeTruthy();
    await flush(2_000);
    expect(screen.getByText(SA.succeeded)).toBeTruthy();
    expect(screen.getByText(SA.restartQueued)).toBeTruthy();
    expect(screen.queryByRole('button', { name: SA.button })).toBeNull();
    const polls = authenticatedFetch.mock.calls.length;
    await flush(10_000);
    expect(authenticatedFetch.mock.calls.length).toBe(polls);
  });

  it('explains a succeeded attach whose restart could not be queued, with the code as a detail', async () => {
    route({
      get: [eligible()], post: [reply(202, { operationId: OP })],
      poll: [operation({ state: 'succeeded', restartCode: 'restart_row_job_bound' })],
    });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: SA.button }));
    await flush(2_000);
    expect(screen.getByText(SA.restartNotQueued.restart_row_job_bound)).toBeTruthy();
    expect(screen.getByText('restart_row_job_bound')).toBeTruthy();
  });

  it('lists the open terminals when writers are active', async () => {
    route({
      get: [eligible()], post: [reply(202, { operationId: OP })],
      poll: [operation({
        state: 'refused', code: 'source_attach_writers_active', step: 'quiescence',
        openTerminals: { count: 2, attached: 2, detached: 0, usernames: ['sara', 'ali'], detachedClosesAt: null, snapshot: null },
      })],
    });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: SA.button }));
    await flush(2_000);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(SA.writersActive.replace('{{count}}', '2'));
    expect(screen.getByText('sara')).toBeTruthy();
    expect(screen.getByText('ali')).toBeTruthy();
    expect(screen.getByRole('button', { name: SA.retry })).toBeTruthy();
  });

  it('maps a generic refusal and an unknown code to plain text, never the bare code alone', async () => {
    route({ get: [eligible()], post: [reply(202, { operationId: OP })], poll: [operation({ state: 'refused', code: 'release_unverified' })] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: SA.button }));
    await flush(2_000);
    expect(screen.getByText(SA.codes.release_unverified)).toBeTruthy();
    cleanup();
    route({ get: [eligible()], post: [reply(202, { operationId: OP })], poll: [operation({ state: 'refused', code: 'brand_new_code' })] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: SA.button }));
    await flush(2_000);
    expect(screen.getByText(SA.refusedGeneric)).toBeTruthy();
    expect(screen.getByText('brand_new_code')).toBeTruthy();
  });

  it('shows a failure as failed, with a retry that re-reads eligibility', async () => {
    route({ get: [eligible()], post: [reply(202, { operationId: OP })], poll: [operation({ state: 'failed', code: 'attach_verify_failed' })] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: SA.button }));
    await flush(2_000);
    expect(screen.getByText(SA.codes.attach_verify_failed)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: SA.retry }));
    await flush();
    expect(screen.getByRole('button', { name: SA.button })).toBeTruthy();
  });

  it('maps a POST refusal (409 source_changed) to its message', async () => {
    route({ get: [eligible()], post: [reply(409, { code: 'source_changed' })] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: SA.button }));
    await flush();
    expect(screen.getByText(SA.codes.source_changed)).toBeTruthy();
  });

  it('shows restart pending instead of the button', async () => {
    route({ get: [eligible({ eligible: false, reason: 'already_attached', restartPending: true })] });
    await mount({ offered: false, restartPending: true });
    expect(screen.getByText(SA.restartPending)).toBeTruthy();
    expect(screen.queryByRole('button', { name: SA.button })).toBeNull();
  });

  it('explains an ineligible tree without offering the button', async () => {
    route({ get: [eligible({ eligible: false, reason: 'dirty_worktree' })] });
    await mount();
    expect(screen.getByText(SA.codes.dirty_worktree)).toBeTruthy();
    expect(screen.queryByRole('button', { name: SA.button })).toBeNull();
  });

  it('resumes polling a running operation reported by GET', async () => {
    route({ get: [eligible({ operation: { operationId: OP, state: 'running', step: 'lease' } })], poll: [operation({ step: 'apply' })] });
    await mount();
    expect(screen.getByText(SA.running.replace('{{step}}', SA.steps.lease))).toBeTruthy();
    await flush(2_000);
    expect(screen.getByText(SA.running.replace('{{step}}', SA.steps.apply))).toBeTruthy();
  });

  it('renders nothing and calls nothing when not offered', async () => {
    route({ get: [eligible()] });
    await mount({ offered: false, restartPending: false });
    expect(screen.queryByTestId('source-attach')).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('renders nothing for a non-owner', async () => {
    role = 'member';
    route({ get: [eligible()] });
    await mount();
    expect(screen.queryByTestId('source-attach')).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('stops polling on unmount', async () => {
    route({ get: [eligible()], post: [reply(202, { operationId: OP })], poll: [operation({ step: 'prove' })] });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: SA.button }));
    await flush(2_000);
    cleanup();
    const calls = authenticatedFetch.mock.calls.length;
    await flush(10_000);
    expect(authenticatedFetch.mock.calls.length).toBe(calls);
  });
});
