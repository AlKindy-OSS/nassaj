/**
 * HarnessFilesSection (ADR-203, T-2003 C4): member choice blocked when the
 * workspace switch is off, owner switch confirm shows the saved-member count
 * before confirming, and server errors (409 refetch, 403) become plain text.
 *
 * RUNNER: vitest (jsdom). `NODE_ENV=test` is required in this repo.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { t } = vi.hoisted(() => ({
  t: (key: string, options?: Record<string, unknown>) => (
    options && 'count' in options ? `${key}#${String(options.count)}` : key
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t, i18n: { language: 'en' } }),
}));

type Reply = { status: number; body: unknown };
type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
let replies: Record<string, Reply[]> = {};

vi.mock('../../../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const queue = replies[`${method} ${url}`] ?? [];
    const reply = queue.length > 1 ? queue.shift() as Reply : queue[0];
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  }),
}));

import { useHarnessFiles } from '../../../../../harness-files/useHarnessFiles';

import HarnessFilesSection from './HarnessFilesSection';

type ViewOverrides = { workspace?: Record<string, unknown>; me?: Record<string, unknown> };
const view = ({ workspace = {}, me = {} }: ViewOverrides = {}) => ({
  workspace: { allowMemberPrivate: false, ...workspace },
  me: {
    requested: 'shared',
    effective: 'shared',
    canChoose: true,
    canManageWorkspace: false,
    featureEnabled: true,
    harnesses: [
      { provider: 'claude', support: 'full' },
      { provider: 'kimi', support: 'shared-only', reason: 'no_managed_skills' },
    ],
    claude: { link: 'in-sync' },
    ...me,
  },
});

const error = (status: number, code: string): Reply => ({
  status, body: { success: false, error: { code, message: 'raw server text' } },
});

function Harness() {
  return <HarnessFilesSection state={useHarnessFiles()} />;
}

const GET = 'GET /api/harness-files';

describe('HarnessFilesSection', () => {
  beforeEach(() => {
    calls = [];
    replies = {};
  });
  afterEach(() => cleanup());

  it('blocks the private option for a member when the switch is off, with the reason', async () => {
    replies[GET] = [{ status: 200, body: view({ me: { canChoose: false } }) }];
    render(<Harness />);
    expect(await screen.findByTestId('harness-files-blocked')).toBeTruthy();
    const privateOption = screen.getByRole('radio', { name: 'harnessFiles.modePrivate' }) as HTMLButtonElement;
    expect(privateOption.disabled).toBe(true);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('explains why a saved private choice runs as shared after the owner switched it off', async () => {
    replies[GET] = [{ status: 200, body: view({ me: { requested: 'private', canChoose: false } }) }];
    render(<Harness />);
    expect((await screen.findByTestId('harness-files-effective')).textContent)
      .toBe('harnessFiles.effective.switchOff');
  });

  it('shows the saved-member count in the confirm dialog before turning the switch on', async () => {
    replies[GET] = [{ status: 200, body: view({
      workspace: { savedPrivateMembers: 3 }, me: { canManageWorkspace: true },
    }) }];
    replies['PUT /api/harness-files/workspace'] = [{ status: 200, body: {
      ...view({ workspace: { allowMemberPrivate: true }, me: { canManageWorkspace: true } }),
      affectedMembers: 3,
    } }];
    render(<Harness />);
    fireEvent.click(await screen.findByRole('switch'));
    expect(screen.getByTestId('harness-files-saved-count').textContent)
      .toBe('harnessFiles.workspace.savedMembers#3');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'harnessFiles.workspace.confirmOn' }));
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ allowMemberPrivate: true });
    expect(screen.getByText('harnessFiles.workspace.affected#3')).toBeTruthy();
  });

  it('turning the switch off confirms that members revert and their files are kept', async () => {
    replies[GET] = [{ status: 200, body: view({
      workspace: { allowMemberPrivate: true }, me: { canManageWorkspace: true },
    }) }];
    render(<Harness />);
    fireEvent.click(await screen.findByRole('switch'));
    expect(screen.getByText('harnessFiles.workspace.confirmOffBody')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'harnessFiles.cancel' }));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('on 409 MODE_CHANGED reloads the view and says so in plain words', async () => {
    replies[GET] = [
      { status: 200, body: view() },
      { status: 200, body: view({ me: { requested: 'private', effective: 'private' } }) },
    ];
    replies['PUT /api/harness-files/me'] = [error(409, 'HARNESS_FILES_MODE_CHANGED')];
    render(<Harness />);
    fireEvent.click(await screen.findByRole('radio', { name: 'harnessFiles.modePrivate' }));
    expect((await screen.findByRole('alert')).textContent).toBe('harnessFiles.errors.HARNESS_FILES_MODE_CHANGED');
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    await waitFor(() => expect(
      screen.getByRole('radio', { name: 'harnessFiles.modePrivate' }).getAttribute('aria-checked'),
    ).toBe('true'));
  });

  it('on 403 PRIVATE_DISABLED shows the translated reason, never the raw server text', async () => {
    replies[GET] = [{ status: 200, body: view() }];
    replies['PUT /api/harness-files/me'] = [error(403, 'HARNESS_FILES_PRIVATE_DISABLED')];
    render(<Harness />);
    fireEvent.click(await screen.findByRole('radio', { name: 'harnessFiles.modePrivate' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('harnessFiles.errors.HARNESS_FILES_PRIVATE_DISABLED');
    expect(screen.queryByText('raw server text')).toBeNull();
  });

  it('maps an unknown error code to the generic message', async () => {
    replies[GET] = [{ status: 200, body: view() }];
    replies['PUT /api/harness-files/me'] = [error(500, 'SOMETHING_NEW')];
    render(<Harness />);
    fireEvent.click(await screen.findByRole('radio', { name: 'harnessFiles.modePrivate' }));
    expect((await screen.findByRole('alert')).textContent).toBe('harnessFiles.errors.UNKNOWN');
  });

  it('shows a read-only state when the feature is off on the server', async () => {
    replies[GET] = [{ status: 200, body: view({ me: { featureEnabled: false } }) }];
    render(<Harness />);
    expect(await screen.findByTestId('harness-files-feature-off')).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('notes a pending Claude switch with the background-terminal hint', async () => {
    replies[GET] = [{ status: 200, body: view({ me: { claude: { link: 'pending' } } }) }];
    render(<Harness />);
    expect(await screen.findByText('harnessFiles.claudePending')).toBeTruthy();
    expect(screen.getByText('harnessFiles.claudePendingHint')).toBeTruthy();
  });

  it('tells an owner on private files that the shared library needs shared mode', async () => {
    replies[GET] = [{ status: 200, body: view({
      me: { canManageWorkspace: true, requested: 'private', effective: 'private' },
    }) }];
    render(<Harness />);
    expect(await screen.findByTestId('harness-files-manager-private')).toBeTruthy();
  });

  it('offers a retry when the first load fails', async () => {
    replies[GET] = [error(500, 'INTERNAL_ERROR'), { status: 200, body: view() }];
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'harnessFiles.retry' }));
    expect(await screen.findByRole('radiogroup')).toBeTruthy();
  });
});
