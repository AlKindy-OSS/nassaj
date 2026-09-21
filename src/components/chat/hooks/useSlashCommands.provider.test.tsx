/**
 * B-614 — قائمة أوامر المؤلف تتبع هارنس الجلسة، والأمر ذو المعالج الخادمي
 * يُنفَّذ محلياً ولا يتحول إلى prompt خام للمحرّك.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let builtIns: Array<Record<string, unknown>> = [];
let providerSkills: Array<Record<string, unknown>> = [];

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    if (url === '/api/commands/list') {
      return {
        ok: true,
        json: async () => ({ builtIn: builtIns, custom: [] }),
      };
    }
    return {
      ok: true,
      json: async () => ({ success: true, data: { skills: providerSkills } }),
    };
  },
}));

import {
  isProviderHandledBuiltInCommand,
  isPassthroughBuiltInCommand,
  filterSlashCommands,
  resolveProviderCommandFallback,
  useSlashCommands,
  type SlashCommand,
} from './useSlashCommands';

const PROJECT = {
  projectId: 'project-1',
  name: 'Nassaj',
  path: '/workspace/nassaj',
  fullPath: '/workspace/nassaj',
} as any;

const COMPACT: SlashCommand = {
  name: '/compact',
  description: 'Compact Codex context',
  namespace: 'builtin',
  type: 'built-in',
  metadata: { type: 'builtin', hasHandler: true },
};

afterEach(cleanup);

beforeEach(() => {
  fetchCalls.length = 0;
  builtIns = [COMPACT];
  providerSkills = [];
  localStorage.clear();
});

function renderCommands(provider: 'claude' | 'codex', onExecuteCommand = vi.fn()) {
  return renderHook(
    ({ activeProvider }) => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1', __provider: activeProvider } as any,
      provider: activeProvider,
      input: '',
      setInput: vi.fn(),
      textareaRef: { current: null },
      onExecuteCommand,
    }),
    { initialProps: { activeProvider: provider } },
  );
}

describe('provider-aware slash commands', () => {
  it('يبحث بالمرادف العربي مع إبقاء الاسم التنفيذي canonical', () => {
    const command: SlashCommand = {
      ...COMPACT,
      view: {
        canonicalName: '/compact',
        title: 'ضغط',
        description: 'اضغط سياق Codex الحالي.',
        aliases: ['/ضغط'],
        searchTerms: ['/compact', '/ضغط', 'ضغط (compact)', 'اضغط سياق codex الحالي.', 'compact codex context'],
      },
    };
    expect(filterSlashCommands([command], 'ضغط')).toEqual([command]);
    expect(filterSlashCommands([command], 'context')).toEqual([command]);
    expect(command.name).toBe('/compact');
  });

  it('preserves the manual-only catalog flag without hiding the skill', async () => {
    providerSkills = [{ name: 'to-spec', command: '/to-spec', scope: 'user', disableModelInvocation: true }];
    const view = renderCommands('claude');
    await waitFor(() => expect(view.result.current.slashCommands.some(command => command.name === '/to-spec')).toBe(true));
    expect(view.result.current.slashCommands.find(command => command.name === '/to-spec')?.metadata).toMatchObject({ disableModelInvocation: true });
  });
  it('يبقي أوامر Codex الثابتة معالَجة محلياً عند تعطل تحميل القائمة', () => {
    const declaredCommands = [
      '/help', '/models', '/model', '/cost', '/status', '/compact', '/usage',
      '/mcp', '/skills', '/hooks', '/apps', '/rename', '/goal',
    ];
    for (const name of declaredCommands) {
      const fallback = resolveProviderCommandFallback('codex', name);
      expect(fallback).toMatchObject({
        name,
        namespace: 'builtin',
        metadata: { hasHandler: true },
      });
      expect(isPassthroughBuiltInCommand(fallback as SlashCommand)).toBe(false);
    }

    // Commands outside this server-declared batch remain unavailable until
    // discovery returns them; the client must not invent a registry.
    expect(resolveProviderCommandFallback('codex', '/review')).toBeUndefined();
    expect(resolveProviderCommandFallback('claude', '/compact')).toBeUndefined();
  });

  it('يرسل مزوّد الجلسة الفعلي إلى سجل الأوامر عند التبديل', async () => {
    const view = renderCommands('claude');

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
    expect(view.result.current.slashCommands.map((command) => command.name)).toEqual([
      '/btw',
      '/compact',
    ]);
    const firstListRequest = fetchCalls.find((call) => call.url === '/api/commands/list');
    expect(JSON.parse(String(firstListRequest?.init?.body))).toMatchObject({ provider: 'claude' });

    builtIns = [{ ...COMPACT, description: 'Codex compact' }];
    view.rerender({ activeProvider: 'codex' });

    // The old harness registry is cleared synchronously while the client-only
    // Codex side-channel aliases remain available.
    expect(view.result.current.slashCommands.map((command) => command.name)).toEqual([
      '/side',
    ]);
    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
    expect(view.result.current.slashCommands.map((command) => command.name)).toEqual([
      '/side',
      '/compact',
    ]);

    const listRequests = fetchCalls.filter((call) => call.url === '/api/commands/list');
    expect(JSON.parse(String(listRequests.at(-1)?.init?.body))).toMatchObject({ provider: 'codex' });
    expect(fetchCalls.some((call) => call.url.startsWith('/api/providers/codex/skills'))).toBe(true);
  });

  it('ينفّذ Codex /compact عبر معالج الخادم ولا يدرجه كنص', async () => {
    const onExecuteCommand = vi.fn();
    const view = renderCommands('codex', onExecuteCommand);

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
    expect(view.result.current.slashCommands.map((command) => command.name)).toEqual([
      '/side',
      '/compact',
    ]);
    expect(isPassthroughBuiltInCommand(COMPACT)).toBe(false);

    await act(async () => {
      view.result.current.handleCommandSelect(
        view.result.current.slashCommands[1],
        1,
        false,
      );
    });

    expect(onExecuteCommand).toHaveBeenCalledOnce();
    expect(onExecuteCommand).toHaveBeenCalledWith(expect.objectContaining({ name: '/compact' }));
  });

  it('يعامل كل builtin معلن من خادم Codex كفعل واجهة حتى مع metadata قديمة', async () => {
    builtIns = [{
      name: '/review',
      description: 'Review changes',
      namespace: 'builtin',
      metadata: { type: 'builtin', hasHandler: false },
    }];
    const onExecuteCommand = vi.fn();
    const view = renderCommands('codex', onExecuteCommand);

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
    const review = view.result.current.slashCommands[1];
    expect(isPassthroughBuiltInCommand(review)).toBe(true);
    expect(isProviderHandledBuiltInCommand('codex', review)).toBe(true);
    expect(isProviderHandledBuiltInCommand('claude', review)).toBe(false);

    await act(async () => {
      view.result.current.handleCommandSelect(review, 0, false);
    });

    expect(onExecuteCommand).toHaveBeenCalledWith(expect.objectContaining({ name: '/review' }));
  });

  it('يدرِج أمر Codex ذي argumentHint في الحقل كي يكتب المستخدم وسيطاته', async () => {
    builtIns = [
      { name: '/rename', argumentHint: '<name>' },
      { name: '/goal', argumentHint: '[clear|objective]' },
    ].map(({ name, argumentHint }) => ({
      name,
      namespace: 'builtin',
      metadata: { type: 'builtin', hasHandler: true, argumentHint },
    }));
    const onExecuteCommand = vi.fn();
    const setInput = vi.fn();
    const textarea = document.createElement('textarea');
    const focus = vi.spyOn(textarea, 'focus');
    const view = renderHook(() => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1', __provider: 'codex' } as any,
      provider: 'codex',
      input: '',
      setInput,
      textareaRef: { current: textarea },
      onExecuteCommand,
    }));

    // Codex sessions expose `/side` only; `/btw` is Claude's side-command surface.
    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(3));
    const rename = view.result.current.slashCommands.find((command) => command.name === '/rename')!;
    const goal = view.result.current.slashCommands.find((command) => command.name === '/goal')!;
    act(() => {
      view.result.current.handleCommandSelect(rename, 2, false);
      view.result.current.handleCommandSelect(goal, 3, false);
    });

    expect(setInput).toHaveBeenNthCalledWith(1, '/rename ');
    expect(setInput).toHaveBeenNthCalledWith(2, '/goal ');
    expect(onExecuteCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(focus).toHaveBeenCalled());
  });

  it('يبقي أوامر insert قابلة للإدراج أثناء تنفيذ أمر ولا يطلق fetch جديداً', async () => {
    builtIns = [
      COMPACT,
      {
        name: '/rename',
        namespace: 'builtin',
        metadata: { type: 'builtin', hasHandler: true, argumentHint: '<name>' },
      },
    ];
    providerSkills = [{
      name: 'summarize',
      description: 'Summarize selection',
      command: '/summarize',
      scope: 'project',
    }];
    const onExecuteCommand = vi.fn();
    const setInput = vi.fn();
    const view = renderHook(() => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1', __provider: 'codex' } as any,
      provider: 'codex',
      input: '',
      setInput,
      textareaRef: { current: null },
      onExecuteCommand,
      isExecutableCommandRunning: true,
    }));

    // `/side` plus /compact, /rename and the provider skill.
    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(4));
    const compact = view.result.current.slashCommands.find((command) => command.name === '/compact')!;
    const rename = view.result.current.slashCommands.find((command) => command.name === '/rename')!;
    const skill = view.result.current.slashCommands.find((command) => command.name === '/summarize')!;
    const fetchCountBeforeSelection = fetchCalls.length;

    expect(view.result.current.isCommandExecutionDisabled(compact)).toBe(true);
    expect(view.result.current.isCommandExecutionDisabled(rename)).toBe(false);
    expect(view.result.current.isCommandExecutionDisabled(skill)).toBe(false);

    act(() => {
      view.result.current.handleCommandSelect(compact, 0, false);
      view.result.current.handleCommandSelect(rename, 1, false);
      view.result.current.handleCommandSelect(skill, 2, false);
    });

    expect(onExecuteCommand).not.toHaveBeenCalled();
    expect(setInput).toHaveBeenNthCalledWith(1, '/rename ');
    expect(setInput).toHaveBeenNthCalledWith(2, '/summarize ');
    expect(fetchCalls).toHaveLength(fetchCountBeforeSelection);
  });

  it('T-1704: اختيار Claude /compact من القائمة يُرسله فوراً بدل إدراجه نصّاً', async () => {
    builtIns = [{ ...COMPACT, metadata: { type: 'builtin', hasHandler: false } }];
    const onExecuteCommand = vi.fn();
    const onDispatchPassthroughCommand = vi.fn();
    const setInput = vi.fn();
    const view = renderHook(() => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1', __provider: 'claude' } as any,
      provider: 'claude',
      input: '',
      setInput,
      textareaRef: { current: null },
      onExecuteCommand,
      onDispatchPassthroughCommand,
    }));

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
    const compact = view.result.current.slashCommands.find((command) => command.name === '/compact')!;

    act(() => {
      view.result.current.handleCommandSelect(compact, 1, false);
    });

    expect(onDispatchPassthroughCommand).toHaveBeenCalledWith(expect.objectContaining({ name: '/compact' }), '');
    expect(onExecuteCommand).not.toHaveBeenCalled();
    expect(setInput).not.toHaveBeenCalled();
    expect(fetchCalls.some((call) => call.url === '/api/commands/execute')).toBe(false);
  });

  it('T-1704: الإرسال الفوري يُبقي النصّ المكتوب سلفاً ويمرّره للاستعادة', async () => {
    builtIns = [{ ...COMPACT, metadata: { type: 'builtin', hasHandler: false } }];
    const onDispatchPassthroughCommand = vi.fn();
    const view = renderHook(() => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1', __provider: 'claude' } as any,
      provider: 'claude',
      input: 'مسودة لم تُرسل بعد ',
      setInput: vi.fn(),
      textareaRef: { current: null },
      onExecuteCommand: vi.fn(),
      onDispatchPassthroughCommand,
    }));

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
    const compact = view.result.current.slashCommands.find((command) => command.name === '/compact')!;
    act(() => {
      view.result.current.handleCommandSelect(compact, 1, false);
    });
    expect(onDispatchPassthroughCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: '/compact' }),
      'مسودة لم تُرسل بعد ',
    );
  });

  it('T-1704: بلا onDispatchPassthroughCommand يبقى Claude /compact إدراجاً نصّياً', async () => {
    builtIns = [{ ...COMPACT, metadata: { type: 'builtin', hasHandler: false } }];
    const setInput = vi.fn();
    const view = renderHook(() => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1', __provider: 'claude' } as any,
      provider: 'claude',
      input: '',
      setInput,
      textareaRef: { current: null },
      onExecuteCommand: vi.fn(),
    }));

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
    const compact = view.result.current.slashCommands.find((command) => command.name === '/compact')!;
    act(() => {
      view.result.current.handleCommandSelect(compact, 1, false);
    });
    expect(setInput).toHaveBeenCalledWith('/compact ');
  });

  it('يخفي أوامر Codex المعتمدة على thread قبل إنشاء الجلسة', async () => {
    builtIns = [
      '/help', '/models', '/model', '/cost', '/status', '/compact', '/usage',
      '/mcp', '/skills', '/hooks', '/apps', '/rename', '/goal',
    ].map((name) => ({
      name,
      namespace: 'builtin',
      metadata: {
        type: 'builtin',
        hasHandler: true,
        ...(['/rename', '/goal'].includes(name) ? { argumentHint: '<value>' } : {}),
      },
    }));
    const view = renderHook(() => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: null,
      provider: 'codex',
      input: '',
      setInput: vi.fn(),
      textareaRef: { current: null },
      onExecuteCommand: vi.fn(),
    }));

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(5));
    expect(view.result.current.slashCommands.map((command) => command.name)).toEqual([
      '/help', '/models', '/model', '/cost', '/status',
    ]);

    // Hidden from discovery does not weaken typed-command fail-closed routing.
    expect(resolveProviderCommandFallback('codex', '/goal')).toMatchObject({
      name: '/goal',
      metadata: { hasHandler: true },
    });
  });

  it('يعرض /side مرة واحدة لجلسة Codex ويدرجه مع مسافة للسؤال', async () => {
    builtIns = [];
    const setInput = vi.fn();
    const view = renderHook(() => useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'codex-thread', __provider: 'codex' } as any,
      provider: 'codex',
      input: '',
      setInput,
      textareaRef: { current: null },
      onExecuteCommand: vi.fn(),
    }));

    await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(1));
    expect(view.result.current.slashCommands.map((command) => command.name)).toEqual([
      '/side',
    ]);
    expect(view.result.current.slashCommands).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'nassaj', type: 'btw' }),
    ]));

    act(() => {
      view.result.current.handleCommandSelect(view.result.current.slashCommands[0], 0, false);
    });

    expect(setInput).toHaveBeenCalledWith('/side ');
  });
});
