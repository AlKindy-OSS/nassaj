/**
 * T-2086 S5 (ADR-224) — the DeepSeek Harness body in the client.
 *
 * Acceptance in the owner's terms:
 *  1. choosing DeepSeek Harness shows a short disclosure (preview build, no
 *     security audit, content goes to DeepSeek, fixed anonymous install id,
 *     tools run under the server's shared account) — and only for dsh;
 *  2. a message sent on dsh goes out as `dsh-command` with Claude's
 *     restriction inputs (permissionMode + claude-settings toolsSettings);
 *  3. a turn refused for a missing key leads to the DeepSeek key slot;
 *  4. a dsh `permission_request` renders in the shared banner and is answered
 *     on the shared `claude-permission-response` frame;
 *  5. capabilities hide what dsh does not support.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = String(options?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
  Trans: ({ defaults }: { defaults?: string }) => (defaults ? defaults.replace(/<\/?\w+>/g, '') : null),
}));
vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner' } }),
}));
vi.mock('react-dropzone', () => ({
  useDropzone: () => ({ getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false, open: () => {} }),
}));
vi.mock('../../hooks/useFileMentions', () => ({
  useFileMentions: () => ({
    showFileDropdown: false, filteredFiles: [], selectedFileIndex: 0, renderInputWithMentions: () => null,
    selectFile: () => {}, setCursorPosition: () => {}, handleFileMentionsKeyDown: () => false,
  }),
}));
vi.mock('../../hooks/useSlashCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useSlashCommands')>()),
  useSlashCommands: () => ({
    slashCommands: [], slashCommandsCount: 0, filteredCommands: [], frequentCommands: [], commandQuery: '',
    showCommandMenu: false, selectedCommandIndex: -1, resetCommandMenuState: () => {}, handleCommandSelect: () => {},
    handleToggleCommandMenu: () => {}, handleCommandInputChange: () => {}, handleCommandMenuKeyDown: () => false,
  }),
}));
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
}));
vi.mock('../../utils/messageOutbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/messageOutbox')>();
  return {
    ...actual,
    recordOutboxEntryDurably: vi.fn(async (input: Parameters<typeof actual.recordOutboxEntry>[0]) => (
      actual.recordOutboxEntry(input)
    )),
    markOutboxPendingDurably: vi.fn(async (id: string) => (
      actual.markOutboxPending(id) ? actual.getOutboxSnapshot().find((entry) => entry.id === id) ?? null : null
    )),
  };
});
vi.mock('../../../provider-auth/hooks/useVendorKeyStatuses', () => ({
  useVendorKeyStatuses: () => ({ statuses: { deepseek: true }, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../../../hooks/useFavoriteModels', () => ({
  useFavoriteModels: () => ({ favorites: [], handleToggleFavorite: vi.fn(), isLoading: false }),
}));
vi.mock('../../hooks/useAntigravityActiveModel', () => ({
  useAntigravityActiveModel: () => ({ label: null, loading: false, error: null }),
}));
vi.mock('../../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openSettings: vi.fn() }),
}));
vi.mock('../../../llm-logo-provider/SessionProviderLogo', () => ({ default: () => null }));

import type { LLMProvider, ProjectSession } from '../../../../types/app';
import type { ProviderAuthStatusMap } from '../../../provider-auth/types';
import { createInitialProviderAuthStatusMap } from '../../../provider-auth/types';
import {
  readCredentialNotLinked,
  resolveCredentialDestinations,
} from '../../../credential-link/credentialNotLinked';
import { getProviderCapabilities } from '../../constants/providerCapabilities';
import { useChatComposerState } from '../../hooks/useChatComposerState';
import { useChatProviderState } from '../../hooks/useChatProviderState';
import { clearOutbox, setOutboxBlobStore, setOutboxUser } from '../../utils/messageOutbox';
import { DSH_FALLBACK_MODELS } from '../../../../constants/providerModelFallbacks';

import PermissionRequestsBanner from './PermissionRequestsBanner';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';

const noop = () => {};

function renderPicker(provider: LLMProvider) {
  const auth = createInitialProviderAuthStatusMap(false) as ProviderAuthStatusMap;
  for (const key of Object.keys(auth) as (keyof ProviderAuthStatusMap)[]) {
    auth[key] = { ...auth[key], authenticated: true, installed: true, loading: false };
  }
  return render(
    <ProviderSelectionEmptyState
      selectedSession={null as ProjectSession | null}
      currentSessionId={null}
      provider={provider}
      setProvider={noop}
      engineProvider={null}
      setEngineProvider={noop}
      onSelectClaudeEngineProvider={noop}
      textareaRef={{ current: null } as React.RefObject<HTMLTextAreaElement>}
      claudeModel="opus" setClaudeModel={noop}
      codexModel="" setCodexModel={noop}
      antigravityModel="" setAntigravityModel={noop}
      opencodeModel="" setOpenCodeModel={noop}
      kimiModel="" setKimiModel={noop}
      deepseekModel="" setDeepSeekModel={noop}
      glmModel="" setGlmModel={noop}
      dshModel="deepseek-v4-flash" setDshModel={noop}
      providerModelCatalog={{ dsh: DSH_FALLBACK_MODELS, claude: { OPTIONS: [{ value: 'opus', label: 'Opus' }], DEFAULT: 'opus' } }}
      providerModelsLoading={false}
      providerModelsRefreshing={false}
      providerAuthStatus={auth}
      onRefreshProviderModels={vi.fn().mockResolvedValue(undefined)}
      onHardRefreshProviderModels={noop}
      onRefreshAuthStatus={vi.fn().mockResolvedValue(undefined)}
      setInput={noop as unknown as React.Dispatch<React.SetStateAction<string>>}
    />,
  );
}

type Session = { id: string; __provider: string } | null;

function renderComposer(session: Session) {
  const sent: any[] = [];
  const hook = renderHook(() => {
    const ps = useChatProviderState({ selectedSession: session as any, selectedProject: null });
    const composer = useChatComposerState({
      selectedProject: { projectId: 'p1', name: 'p', path: '/p', fullPath: '/p' },
      selectedSession: session,
      currentSessionId: session?.id ?? null,
      provider: 'dsh',
      displayProvider: 'dsh',
      engineProvider: null,
      permissionMode: ps.permissionMode,
      cyclePermissionMode: ps.cyclePermissionMode,
      claudeModel: 'claude', codexModel: 'gpt-5', antigravityModel: 'ag', opencodeModel: 'oc',
      kimiModel: 'kimi', deepseekModel: 'deepseek', glmModel: 'glm', dshModel: ps.dshModel,
      isLoading: false, canAbortSession: false, tokenBudget: null,
      sendMessage: (m: unknown) => { sent.push(m); return { ok: true }; },
      pendingViewSessionRef: { current: null },
      scrollToBottom: noop, addMessage: noop, setIsLoading: noop,
      setCanAbortSession: noop, setClaudeStatus: noop, setIsUserScrolledUp: noop,
      setPendingPermissionRequests: noop, onBtwQuery: noop,
    } as any);
    return { ps, composer };
  });
  return { hook, sent };
}

beforeEach(() => {
  localStorage.clear();
  clearOutbox();
  const blobs = new Map<string, File>();
  setOutboxBlobStore({
    put: async (key, file) => { blobs.set(key, file); },
    getMany: async (keys) => keys.flatMap((key) => (blobs.get(key) ? [blobs.get(key)!] : [])),
    deleteMany: async (keys) => { keys.forEach((key) => blobs.delete(key)); },
    clearAll: async () => { blobs.clear(); },
  });
  setOutboxUser(1);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DeepSeek Harness selection disclosure', () => {
  it('shows the five facts when DeepSeek Harness is the chosen body', () => {
    renderPicker('dsh');
    const note = screen.getByRole('note', { name: /DeepSeek Harness/ });
    const text = note.textContent ?? '';
    expect(text).toMatch(/preview/i);
    expect(text).toMatch(/SAFETY\.md/);
    expect(text).toMatch(/security audit/i);
    expect(text).toMatch(/sent to DeepSeek/i);
    expect(text).toMatch(/anonymous/i);
    expect(text).toMatch(/same system account/i);
  });

  it('is absent for every other body', () => {
    renderPicker('claude');
    expect(screen.queryByRole('note', { name: /DeepSeek Harness/ })).toBeNull();
  });

  it('lists DeepSeek Harness with its three models in the picker', async () => {
    renderPicker('dsh');
    fireEvent.click(screen.getByRole('button', { name: /change model/i }));
    await screen.findByPlaceholderText('Search models...');
    const header = screen.getAllByRole('button', { name: /DeepSeek Harness/ })
      .find((button) => button.hasAttribute('aria-expanded'));
    expect(header).toBeTruthy();
    if (header!.getAttribute('aria-expanded') === 'false') fireEvent.click(header!);
    const list = screen.getByRole('listbox');
    for (const label of ['DeepSeek V4 Flash', 'DeepSeek V4.1 Flash', 'DeepSeek V4 Pro']) {
      expect(within(list).getByText(label)).toBeTruthy();
    }
  });
});

describe('DeepSeek Harness send path', () => {
  it('sends dsh-command with the model and Claude restriction inputs', async () => {
    localStorage.setItem('selected-provider', 'dsh');
    const view = renderComposer({ id: 's1', __provider: 'dsh' });
    act(() => view.hook.result.current.composer.setInput('hello'));
    await act(async () => view.hook.result.current.composer.handleSubmit({ preventDefault: noop } as any));
    expect(view.sent).toHaveLength(1);
    const [payload] = view.sent;
    expect(payload.type).toBe('dsh-command');
    expect(payload.command).toBe('hello');
    expect(payload.options).toMatchObject({
      sessionId: 's1',
      resume: true,
      model: DSH_FALLBACK_MODELS.DEFAULT,
      permissionMode: 'default',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    });
    expect(payload.options).not.toHaveProperty('reasoningEffort');
    expect(payload.options).not.toHaveProperty('images');
  });

  it.each([['high', 'high'], ['max', 'max'], ['xhigh', undefined], ['medium', undefined]])(
    'effort %s is sent only when dsh offers it', async (mode, sent) => {
      const view = renderComposer({ id: 's1', __provider: 'dsh' });
      act(() => view.hook.result.current.composer.setThinkingMode(mode));
      act(() => view.hook.result.current.composer.setInput('hi'));
      await act(async () => view.hook.result.current.composer.handleSubmit({ preventDefault: noop } as any));
      expect(view.sent[0].options.reasoningEffort).toBe(sent);
    },
  );

  it.each([[1, 'auto'], [3, 'bypassPermissions'], [4, 'plan']])(
    'after %i mode cycle(s) the turn carries %s, as on Claude', async (steps, mode) => {
      const view = renderComposer({ id: 's2', __provider: 'dsh' });
      for (let i = 0; i < steps; i += 1) act(() => view.hook.result.current.ps.cyclePermissionMode());
      act(() => view.hook.result.current.composer.setInput('go'));
      await act(async () => view.hook.result.current.composer.handleSubmit({ preventDefault: noop } as any));
      expect(view.sent[0].options.permissionMode).toBe(mode);
    },
  );

  it('a stored model dsh does not offer falls back to the default', () => {
    localStorage.setItem('dsh-model', 'gpt-5');
    const view = renderComposer(null);
    expect(view.hook.result.current.ps.dshModel).toBe('deepseek-v4-flash');
  });
});

describe('DeepSeek Harness without a key', () => {
  it('the server refusal leads to the DeepSeek key slot', () => {
    const frame = {
      kind: 'complete', provider: 'dsh', code: 'CREDENTIAL_NOT_LINKED', exitCode: 1,
      credential: { provider: 'deepseek', reason: 'not_linked', settingsAnchor: 'agents/deepseek' },
    };
    const info = readCredentialNotLinked(frame);
    expect(info).toMatchObject({ provider: 'deepseek', settingsAgent: 'deepseek' });
    expect(resolveCredentialDestinations(info!).linkOwn).toEqual({ tab: 'vendors' });
  });
});

describe('DeepSeek Harness permission requests', () => {
  it('renders in the shared banner and answers on claude-permission-response', () => {
    const view = renderComposer({ id: 's1', __provider: 'dsh' });
    const decide = view.hook.result.current.composer.handlePermissionDecision;
    render(
      <PermissionRequestsBanner
        pendingPermissionRequests={[{ requestId: 'dsh-perm-1', toolName: 'Read', input: { path: '/etc/hosts' } }]}
        handlePermissionDecision={decide}
        handleGrantToolPermission={vi.fn()}
      />,
    );
    expect(screen.getByText('permissions.required')).toBeTruthy();
    expect(screen.getAllByText('Read').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('permissions.allowOnce'));
    expect(view.sent).toContainEqual(expect.objectContaining({
      type: 'claude-permission-response', requestId: 'dsh-perm-1', allow: true,
    }));
  });
});

describe('DeepSeek Harness capabilities', () => {
  it("hides what dsh does not support and offers exactly Claude's modes", () => {
    const caps = getProviderCapabilities('dsh');
    expect(caps.displayName).toBe('DeepSeek Harness');
    expect(caps.effort).toEqual({ supported: true, modes: ['none', 'low', 'high', 'max'] });
    expect(caps.command.supportsImages).toBe(false);
    expect(caps.tokenCounter.supported).toBe(false);
    expect(caps.sideChannel.supported).toBe(false);
    expect(caps.messageFork?.supported ?? false).toBe(false);
    expect(caps.agentMode.supported).toBe(false);
    expect(caps.quota.surface).toBe('none');
    expect(caps.modelSwitch.supported).toBe(false);
    expect(caps.progress).toEqual({ plan: 'none', subagents: 'none' });
    expect(caps.permissions.modes).toEqual(getProviderCapabilities('claude').permissions.modes);
  });
});
