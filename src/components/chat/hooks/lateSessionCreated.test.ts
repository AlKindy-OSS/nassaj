/**
 * B-1297 — Late session_created after message_dispatch_unconfirmed.
 * B-1298 — Provider error codes (provider_auth_failed, provider_context_overflow,
 *           LOCAL_MODELS_AUTH_FAILED) and providerErrorCode on dispatch frames.
 *
 * qa-critic correction (commit 169dc8bfd review): the first version of this file
 * re-implemented the B-1297 guard condition INSIDE the test and only exercised
 * outbox helpers — nothing called the real handler, so it could not catch a
 * regression in the handler itself. The B-1297 suite below now drives real
 * `session_created` control-event frames through `useChatRealtimeHandlers` via
 * `renderHook`, covering: new+matching, new+non-matching, late (outbox), forked,
 * and stale-resume — the guard must apply ONLY to the brand-new-conversation path
 * and must never reject a healthy fork or stale-resume.
 *
 * B-1298 tests call the real `resolveServerErrorMessage` directly (pure function);
 * these were not flagged and are unchanged.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: () => Promise.resolve() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./sessionActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionActivity')>();
  return {
    ...actual,
    runSessionActivityProbe: async () => 'idle' as const,
  };
});

import type { ControlEventLog } from '../../../contexts/WebSocketContext';

import { resetSessionActivityEpochs } from './sessionActivity';
import {
  resolveServerErrorMessage,
  SERVER_ERROR_CODE_KEYS,
  useChatRealtimeHandlers,
} from './useChatRealtimeHandlers';
import {
  clearOutbox,
  getOutboxSnapshot,
  markOutboxDispatchUnconfirmed,
  recordOutboxEntry,
  setOutboxUser,
} from '../utils/messageOutbox';

import ar from '../../../i18n/locales/ar/chat.json';
import en from '../../../i18n/locales/en/chat.json';

// ---------------------------------------------------------------------------
// Translation helper (mirrors serverErrorMessage.test.ts)
// ---------------------------------------------------------------------------
const translate =
  (locale: typeof en | typeof ar) =>
  (key: string, opts?: Record<string, unknown>) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object'
            ? (node as Record<string, unknown>)[part]
            : undefined,
        locale,
      );
    return typeof value === 'string' ? value : String(opts?.defaultValue ?? key);
  };

// ---------------------------------------------------------------------------
// B-1297 — real-handler harness
// ---------------------------------------------------------------------------

type Delivered = {
  currentSessionId?: string | null;
  selectedSession?: { id: string } | null;
  controlEvents?: ControlEventLog;
  pendingViewSessionRef?: { current: { sessionId: string | null; clientMsgId?: string | null } | null };
};

type Calls = {
  setCurrentSessionId: (string | null)[];
  navigated: { id: string; replace?: boolean }[];
  branched: { from: string; to: string; clientMsgId?: string }[];
  replaced: { from: string; to: string }[];
};

function log(...frames: any[]): ControlEventLog {
  return {
    events: frames.map((frame, index) => ({ seq: index + 1, frame })),
    droppedBeforeSeq: 0,
  };
}

function harness(initial?: Delivered) {
  const calls: Calls = { setCurrentSessionId: [], navigated: [], branched: [], replaced: [] };

  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: () => {},
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    withdrawOptimisticUserRow: () => null,
    replaceSessionId: (from: string, to: string) => calls.replaced.push({ from, to }),
    branchSessionId: (from: string, to: string, clientMsgId?: string) =>
      calls.branched.push({ from, to, clientMsgId }),
  } as any;

  const pendingViewSessionRef = initial?.pendingViewSessionRef ?? { current: null };

  const props = {
    latestMessage: null as any,
    controlFrames: new Map(),
    controlEvents: { events: [], droppedBeforeSeq: 0 } as ControlEventLog,
    provider: 'claude' as const,
    selectedSession: (initial?.selectedSession ?? null) as any,
    currentSessionId: initial?.currentSessionId ?? null,
    setCurrentSessionId: (id: string | null) => calls.setCurrentSessionId.push(id),
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map() } as any,
    onNavigateToSession: (id: string, options?: { replace?: boolean }) =>
      calls.navigated.push({ id, replace: options?.replace }),
    onServerError: () => {},
    sessionStore,
  };

  const { rerender, unmount } = renderHook(
    (delivered: Delivered) => useChatRealtimeHandlers({ ...props, ...delivered } as any),
    { initialProps: (initial ?? {}) as Delivered },
  );

  return { calls, rerender, unmount, pendingViewSessionRef };
}

beforeEach(() => {
  resetSessionActivityEpochs();
  setOutboxUser('test-user-1297');
});
afterEach(() => {
  clearOutbox();
});

describe('B-1297 — real handler: new-conversation clientMsgId guard', () => {
  it('new conversation, matching clientMsgId → navigates', () => {
    const pendingViewSessionRef = { current: { sessionId: null, clientMsgId: 'cmid_match' } };
    const h = harness({ currentSessionId: null, pendingViewSessionRef });

    h.rerender({
      currentSessionId: null,
      pendingViewSessionRef,
      controlEvents: log({ kind: 'session_created', newSessionId: 'sess-new', clientMsgId: 'cmid_match' }),
    });

    expect(h.calls.setCurrentSessionId).toEqual(['sess-new']);
    expect(h.calls.navigated).toEqual([{ id: 'sess-new', replace: undefined }]);
  });

  it('new conversation, non-matching clientMsgId (other live send) → no navigation', () => {
    const pendingViewSessionRef = { current: { sessionId: null, clientMsgId: 'cmid_ours' } };
    const h = harness({ currentSessionId: null, pendingViewSessionRef });

    h.rerender({
      currentSessionId: null,
      pendingViewSessionRef,
      controlEvents: log({ kind: 'session_created', newSessionId: 'sess-other', clientMsgId: 'cmid_theirs' }),
    });

    expect(h.calls.setCurrentSessionId).toEqual([]);
    expect(h.calls.navigated).toEqual([]);
  });

  it('late session_created (pendingViewSessionRef cleared) + matching unconfirmed outbox → navigates + confirms', () => {
    recordOutboxEntry({
      id: 'cmid_late', projectId: 'proj-1', sessionId: null, text: 'رسالة متأخرة', status: 'pending',
    });
    markOutboxDispatchUnconfirmed('cmid_late');

    const pendingViewSessionRef = { current: null };
    const h = harness({ currentSessionId: null, pendingViewSessionRef });

    h.rerender({
      currentSessionId: null,
      pendingViewSessionRef,
      controlEvents: log({ kind: 'session_created', newSessionId: 'sess-late', clientMsgId: 'cmid_late' }),
    });

    expect(h.calls.setCurrentSessionId).toEqual(['sess-late']);
    expect(h.calls.navigated).toEqual([{ id: 'sess-late', replace: undefined }]);
    expect(getOutboxSnapshot().find((e) => e.id === 'cmid_late')?.status).toBe('delivered');
  });

  it('late session_created with NO matching unconfirmed outbox entry → no navigation', () => {
    const pendingViewSessionRef = { current: null };
    const h = harness({ currentSessionId: null, pendingViewSessionRef });

    h.rerender({
      currentSessionId: null,
      pendingViewSessionRef,
      controlEvents: log({ kind: 'session_created', newSessionId: 'sess-orphan', clientMsgId: 'cmid_unknown' }),
    });

    expect(h.calls.setCurrentSessionId).toEqual([]);
    expect(h.calls.navigated).toEqual([]);
  });
});

describe('B-1297 — real handler: guard must not apply to forked / stale-resume', () => {
  it(
    'forked send inside an EXISTING session (currentSessionId set, no pendingViewSessionRef ' +
    'clientMsgId) → navigates even though clientMsgId matches nothing pending',
    () => {
      const pendingViewSessionRef = { current: null };
      const h = harness({ currentSessionId: 'sess-parent', pendingViewSessionRef });

      h.rerender({
        currentSessionId: 'sess-parent',
        pendingViewSessionRef,
        controlEvents: log({
          kind: 'session_created',
          newSessionId: 'sess-fork',
          forked: true,
          parentSessionId: 'sess-parent',
          clientMsgId: 'cmid_fork_unrelated',
        }),
      });

      expect(h.calls.branched).toEqual([{ from: 'sess-parent', to: 'sess-fork', clientMsgId: 'cmid_fork_unrelated' }]);
      expect(h.calls.setCurrentSessionId).toEqual(['sess-fork']);
      expect(h.calls.navigated).toEqual([{ id: 'sess-fork', replace: true }]);
    },
  );

  it(
    'stale-resume mint (currentSessionId set, parentSessionId === currentSessionId, ' +
    'not forked) → migrates even though clientMsgId matches nothing pending',
    () => {
      const pendingViewSessionRef = { current: null };
      const h = harness({ currentSessionId: 'sess-old', pendingViewSessionRef });

      h.rerender({
        currentSessionId: 'sess-old',
        pendingViewSessionRef,
        controlEvents: log({
          kind: 'session_created',
          newSessionId: 'sess-resumed',
          parentSessionId: 'sess-old',
          clientMsgId: 'cmid_resume_unrelated',
        }),
      });

      expect(h.calls.replaced).toEqual([{ from: 'sess-old', to: 'sess-resumed' }]);
      expect(h.calls.setCurrentSessionId).toEqual(['sess-resumed']);
      expect(h.calls.navigated).toEqual([{ id: 'sess-resumed', replace: true }]);
    },
  );
});

// ---------------------------------------------------------------------------
// B-1298 — new error codes in SERVER_ERROR_CODE_KEYS
// ---------------------------------------------------------------------------

describe('B-1298 — new provider error codes registered', () => {
  it.each([
    'provider_auth_failed',
    'provider_context_overflow',
    'LOCAL_MODELS_AUTH_FAILED',
  ])('يُسجَّل الرمز %s في SERVER_ERROR_CODE_KEYS', (code) => {
    expect(Object.prototype.hasOwnProperty.call(SERVER_ERROR_CODE_KEYS, code)).toBe(true);
  });

  it.each([['ar', ar], ['en', en]] as const)(
    'provider_auth_failed → نصّ محدَّد في %s',
    (_name, locale) => {
      const message = resolveServerErrorMessage(
        { error: { code: 'provider_auth_failed' } },
        translate(locale),
      );
      expect(message).toContain(locale.serverError.provider_auth_failed);
      expect(message).toContain('provider_auth_failed');
    },
  );

  it.each([['ar', ar], ['en', en]] as const)(
    'provider_context_overflow → نصّ محدَّد في %s',
    (_name, locale) => {
      const message = resolveServerErrorMessage(
        { code: 'provider_context_overflow' },
        translate(locale),
      );
      expect(message).toContain(locale.serverError.provider_context_overflow);
    },
  );

  it.each([['ar', ar], ['en', en]] as const)(
    'LOCAL_MODELS_AUTH_FAILED → نصّ محدَّد في %s',
    (_name, locale) => {
      const message = resolveServerErrorMessage(
        { code: 'LOCAL_MODELS_AUTH_FAILED' },
        translate(locale),
      );
      expect(message).toContain(locale.serverError.local_models_auth_failed);
    },
  );
});

// ---------------------------------------------------------------------------
// B-1298 — providerErrorCode on message_dispatch_unconfirmed frames
// ---------------------------------------------------------------------------

describe('B-1298 — providerErrorCode on dispatch-failure frames', () => {
  it.each([['ar', ar], ['en', en]] as const)(
    'message_dispatch_unconfirmed + providerErrorCode:provider_auth_failed → نصّ provider_auth_failed في %s',
    (_name, locale) => {
      const message = resolveServerErrorMessage(
        {
          code: 'message_dispatch_unconfirmed',
          providerErrorCode: 'provider_auth_failed',
        },
        translate(locale),
      );
      expect(message).toContain(locale.serverError.provider_auth_failed);
      // The code label should reflect the provider code, not the dispatch code.
      expect(message).toContain('provider_auth_failed');
      expect(message).not.toContain('message_dispatch_unconfirmed');
    },
  );

  it.each([['ar', ar], ['en', en]] as const)(
    'message_dispatch_unconfirmed + providerErrorCode:provider_context_overflow → ' +
    'نصّ provider_context_overflow في %s',
    (_name, locale) => {
      const message = resolveServerErrorMessage(
        {
          code: 'message_dispatch_unconfirmed',
          providerErrorCode: 'provider_context_overflow',
        },
        translate(locale),
      );
      expect(message).toContain(locale.serverError.provider_context_overflow);
    },
  );

  it('message_dispatch_unconfirmed بلا providerErrorCode → النصّ الاحتياطي (unconfirmed)', () => {
    const message = resolveServerErrorMessage(
      { code: 'message_dispatch_unconfirmed' },
      translate(en),
    );
    // Falls back to the outbox.reason.unconfirmed key — the value from the en locale.
    expect(message).toContain('message_dispatch_unconfirmed');
  });

  it('providerErrorCode لا يُطبَّق على رموز غير unconfirmed', () => {
    // provider_auth_failed on a spawn_failed frame → spawn_failed wins.
    const message = resolveServerErrorMessage(
      { code: 'spawn_failed', providerErrorCode: 'provider_auth_failed' },
      translate(en),
    );
    expect(message).toContain(en.serverError.spawn_failed);
    expect(message).toContain('spawn_failed');
    // providerErrorCode must not override a non-unconfirmed primary code.
    expect(message).not.toContain(en.serverError.provider_auth_failed);
  });

  it('providerErrorCode غير قانوني (سلسلة طويلة) → يُتجاهَل', () => {
    const message = resolveServerErrorMessage(
      {
        code: 'message_dispatch_unconfirmed',
        providerErrorCode: 'x'.repeat(65),
      },
      translate(en),
    );
    // Falls back to the unconfirmed path, not the invalid code.
    expect(message).toContain('message_dispatch_unconfirmed');
  });
});
