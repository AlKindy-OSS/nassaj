/**
 * T-1295 — المُؤلِّف: ما يُحفَظ قبل الإرسال، وما يُعاد عند الإعادة.
 *
 * ما يحرسه هذا الملف:
 *  ١. فشلُ النقل (`sendMessage` أعاد `ok:false`) ⇒ إدخالٌ محفوظ بالنصّ والصور،
 *     والمُؤلِّف يُفرَّغ، **ولا يبقى صفّ يبدو مُرسَلاً** (تُسحب الفقاعة المتفائلة).
 *  ٢. الإرسال الناجح يُلحق `clientMsgId` بالحمولة — بدونه لا رابط بين الحكم
 *     والإدخال أصلاً.
 *  ٣. إعادة الإرسال تقرأ `toolsSettings` **حيّة**: أطفأ المستخدم
 *     `skipPermissions` بعد الفشل ⇒ الإعادة لا تُعيد رفعه (انحدار صلاحيات).
 *  ٤. إعادة الإرسال تُعيد **نيّة صاحب الرسالة** (النموذج ومستوى التفكير) لا
 *     اختيار المُؤلِّف الحالي.
 *  ٥. إعادة الإرسال تستأنف الجلسة التي وُلدت بين المحاولتين لا تفتح ثانية.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom، ويلزم `NODE_ENV=test`.
 */

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: any) => opts?.defaultValue ?? key }),
}));
vi.mock('../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'owner' } }),
}));
vi.mock('./useSlashCommands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useSlashCommands')>();
  return {
    ...actual,
    useSlashCommands: () => ({
      slashCommands: [],
      slashCommandsCount: 0,
      filteredCommands: [],
      frequentCommands: [],
      commandQuery: '',
      showCommandMenu: false,
      selectedCommandIndex: 0,
      resetCommandMenuState: () => {},
      handleCommandSelect: () => {},
      handleToggleCommandMenu: () => {},
      handleCommandInputChange: () => {},
      handleCommandMenuKeyDown: () => false,
    }),
  };
});
vi.mock('./useFileMentions', () => ({
  useFileMentions: () => ({
    showFileDropdown: false,
    filteredFiles: [],
    selectedFileIndex: 0,
    renderInputWithMentions: () => null,
    selectFile: () => {},
    setCursorPosition: () => {},
    handleFileMentionsKeyDown: () => false,
  }),
}));

/* jsdom has neither IndexedDB nor the origin-wide Web Lock required by the
 * production admission boundary.  This adapter keeps composer orchestration
 * honest: it uses the real legacy entry/image writer supplied by each test,
 * waits for its image readback, and rolls the entry back on failure.  Real
 * IndexedDB/lock atomicity is covered separately in the browser harness. */
vi.mock('../utils/messageOutbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageOutbox')>();
  return {
    ...actual,
    recordOutboxEntryDurably: vi.fn(async (input: Parameters<typeof actual.recordOutboxEntry>[0]) => {
      const entry = actual.recordOutboxEntry(input);
      if (!entry) return null;
      if (await actual.verifyOutboxImagePersistence(entry, input.images ?? [])) return entry;
      await actual.removeOutboxEntryExplicit(entry.id);
      return null;
    }),
    markOutboxPendingDurably: vi.fn(async (id: string) => {
      if (!actual.markOutboxPending(id)) return null;
      return actual.getOutboxSnapshot().find(entry => entry.id === id) ?? null;
    }),
  };
});

const uploadCalls: string[] = [];
let uploadGate: Promise<void> | null = null;
let uploadShouldFail = false;
let uploadedImageResult: unknown = [];
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async (url: string) => {
    uploadCalls.push(url);
    if (uploadGate) await uploadGate;
    return {
      ok: !uploadShouldFail,
      json: async () => ({ images: uploadedImageResult, files: [] }),
    };
  },
}));

import {
  clearOutbox,
  confirmOutboxEntry,
  MAX_OUTBOX_ENTRIES,
  getOutboxSnapshot,
  markOutboxFailed,
  markOutboxPending,
  outboxRetryMode,
  recordOutboxEntry,
  resolveOutboxVerdict,
  consumeOutboxIngressVerdict,
  setOutboxBlobStore,
  setOutboxUser,
  type OutboxBlobStore,
} from '../utils/messageOutbox';
import { CODEX_IMAGE_INPUT_MAX_BYTES, CODEX_IMAGE_INPUT_MAX_COUNT } from '../../../../shared/codex-image-input';
import OutboxCard from '../view/subcomponents/OutboxCard';
import {
  beginSessionProcessConnectionEpoch,
  resetSessionProcessStates,
  setSessionProcessState,
} from '../../../stores/sessionProcessStateStore';

import { useChatComposerState } from './useChatComposerState';
import { readServerErrorCode, readServerErrorDetail } from './useChatRealtimeHandlers';


const PROJECT = { projectId: 'proj-1', name: 'p', path: '/p', fullPath: '/p' } as any;
const SESSION_ID = 'sess-1';

function memoryBlobStore() {
  const map = new Map<string, File>();
  const store: OutboxBlobStore = {
    put: async (key, file) => { map.set(key, file); },
    getMany: async (keys) => keys.map((k) => map.get(k)).filter((f): f is File => Boolean(f)),
    deleteMany: async (keys) => { keys.forEach((k) => map.delete(k)); },
    clearAll: async () => { map.clear(); },
  };
  return { store, map };
}

type Harness = {
  sent: any[];
  withdrawn: (string | null)[];
  withdrawnIds: (string | undefined)[];
  added: any[];
};

function harness(
  options: {
    wsOpen?: boolean;
    provider?: 'claude' | 'codex' | 'opencode';
    sessionId?: string | null;
    delivered?: boolean;
    verify?: () => Promise<boolean | 'accepted' | 'unknown'>;
    history?: any[];
    authoritative?: boolean;
    processState?: 'running' | 'frozen' | 'idle';
  } = {},
) {
  const state: Harness = { sent: [], withdrawn: [], withdrawnIds: [], added: [] };
  const wsOpen = options.wsOpen ?? true;
  if (options.sessionId && options.authoritative !== false) {
    setSessionProcessState(options.sessionId, options.processState ?? 'idle', {
      epoch: testProcessEpoch,
      authoritative: true,
    });
  }

  const props = {
    selectedProject: PROJECT,
    selectedSession: options.sessionId ? ({ id: options.sessionId } as any) : null,
    currentSessionId: options.sessionId ?? null,
    provider: options.provider ?? 'claude',
    displayProvider: options.provider ?? 'claude',
    engineProvider: null,
    permissionMode: 'default',
    cyclePermissionMode: () => {},
    cursorModel: 'cur', claudeModel: 'sonnet-live', codexModel: 'cx', geminiModel: 'gm',
    antigravityModel: 'ag', opencodeModel: 'oc', hermesModel: 'hm', kimiModel: 'km',
    deepseekModel: 'ds', glmModel: 'glm',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message: unknown) => {
      if (!wsOpen) return { ok: false, reason: 'disconnected' };
      state.sent.push(message);
      return { ok: true };
    },
    pendingViewSessionRef: { current: null } as any,
    scrollToBottom: () => {},
    addMessage: (msg: any) => state.added.push(msg),
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
    withdrawOptimisticUserMessage: (sessionId: string | null, clientMsgId?: string) => {
      state.withdrawn.push(sessionId);
      state.withdrawnIds.push(clientMsgId);
    },
    outboxHistory: options.history,
    verifyMessageDelivered: options.verify ?? (async () => options.delivered ?? false),
  };

  const rendered = renderHook(() => useChatComposerState(props as any));
  return { state, ...rendered, updateHistory: (rows: any[]) => { props.outboxHistory = rows; rendered.rerender(); } };
}

const fakeEvent = { preventDefault: () => {} } as any;

let blobs: ReturnType<typeof memoryBlobStore>;
let testProcessEpoch = 0;

beforeEach(() => {
  localStorage.clear();
  uploadCalls.length = 0;
  uploadGate = null;
  uploadShouldFail = false;
  uploadedImageResult = [{ name: 'shot.png', data: 'data:image/png;base64,eA==' }];
  blobs = memoryBlobStore();
  setOutboxBlobStore(blobs.store);
  clearOutbox();
  setOutboxUser(2);
  resetSessionProcessStates();
  testProcessEpoch = beginSessionProcessConnectionEpoch();
  localStorage.setItem(
    'claude-settings',
    JSON.stringify({ allowedTools: [], disallowedTools: [], skipPermissions: true }),
  );
});

describe('فشل النقل', () => {
  it('يحفظ إدخالاً بالنصّ ويُفرّغ المُؤلِّف ويسحب الفقاعة المتفائلة', async () => {
    const { result, state } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput('رسالتي التي يجب ألا تضيع'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });

    const entries = getOutboxSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('رسالتي التي يجب ألا تضيع');
    expect(entries[0].status).toBe('failed');
    expect(entries[0].reasonCode).toBe('transport');
    expect(entries[0].sessionId).toBe(SESSION_ID);

    // المُؤلِّف أُفرغ ولا مسوّدة متبقّية — النسخة الوحيدة هي الإدخال.
    expect(result.current.input).toBe('');
    expect(localStorage.getItem(`draft_input_${PROJECT.projectId}`)).toBeNull();
    // ولا يبقى صفّ يبدو مُرسَلاً.
    expect(state.withdrawn).toEqual([SESSION_ID]);
    // B-1078: the rollback names the exact bubble it added (its cmid_ id), not "the last row".
    const bubble = state.added.find(message => message.type === 'user');
    expect(bubble.id).toMatch(/^cmid_/);
    expect(state.withdrawnIds).toEqual([bubble.id]);
    expect(entries[0].id).toBe(bubble.id);
  });

  it.each([
    ['hello  \n\n \t', 'hello'],
    ['  indented\n  code\n\n', '  indented\n  code'],
  ])('T-1769: يُسقط الفراغ الخلفي فقط من %j', async (typed, sent) => {
    const { result, state } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput(typed); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });

    expect(getOutboxSnapshot()[0].text).toBe(sent);
    expect(state.added.find(message => message.type === 'user').content).toBe(sent);
  });

  it('يحفظ الصور المرفقة ككائنات خارج localStorage', async () => {
    const { result } = harness({ wsOpen: false, sessionId: SESSION_ID });
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });

    act(() => {
      result.current.setInput('مع صورة');
      result.current.setAttachedImages([file]);
    });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });

    const [entry] = getOutboxSnapshot();
    expect(entry.imageNames).toEqual(['shot.png']);
    expect(blobs.map.size).toBe(1);
    expect(localStorage.getItem('nassaj_outbox_v1_u2')).not.toContain('data:image');
    expect(result.current.attachedImages).toHaveLength(0);
  });

  it('محادثة لم تُولد بعد: الفقاعة المعلَّقة تُسحب بـnull', async () => {
    const { result, state } = harness({ wsOpen: false, sessionId: null });

    act(() => { result.current.setInput('أول رسالة'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });

    expect(getOutboxSnapshot()[0].sessionId).toBeNull();
    expect(state.withdrawn).toEqual([null]);
  });
});

describe('قفل الإرسال أثناء رفع المرفقات', () => {
  it('يُقفل فور قبول submit قبل isLoading ويفكّه بعد اكتمال الرفع', async () => {
    let releaseUpload!: () => void;
    uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const { result } = harness({ sessionId: SESSION_ID });

    act(() => {
      result.current.setInput('رسالة بصورة');
      result.current.setAttachedImages([new File(['x'], 'shot.png', { type: 'image/png' })]);
    });
    let submission!: Promise<void>;
    act(() => { submission = result.current.handleSubmit(fakeEvent); });

    await waitFor(() => expect(result.current.isSubmitSealed).toBe(true));
    act(() => releaseUpload());
    await act(async () => { await submission; });
    expect(result.current.isSubmitSealed).toBe(false);
  });

  it('يفك القفل عند فشل رفع المرفق', async () => {
    uploadShouldFail = true;
    const { result } = harness({ sessionId: SESSION_ID });
    act(() => {
      result.current.setInput('رسالة بصورة تالفة');
      result.current.setAttachedImages([new File(['x'], 'bad.png', { type: 'image/png' })]);
    });

    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(result.current.isSubmitSealed).toBe(false);
  });
});

describe('إرسال صورة بلا نص', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('sends a picker-selected image without setting attachment state directly: %s', async provider => {
    const { result, state } = harness({ sessionId: SESSION_ID, provider });
    const picker = render(<input {...result.current.getInputProps()} />);
    const file = new File(['x'], 'mobile-photo.jpg', { type: 'image/jpeg' });
    fireEvent.change(picker.container.querySelector('input')!, { target: { files: [file] } });
    await waitFor(() => expect(result.current.attachedImages).toEqual([file]));
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].command).toBe('');
    expect(state.sent[0].options.images).toEqual(uploadedImageResult);
    expect(getOutboxSnapshot()[0].imageNames).toEqual(['mobile-photo.jpg']);
    picker.unmount();
  });

  it.each([
    ['claude', ''], ['claude', '   '], ['codex', ''], ['opencode', ''],
  ] as const)('يرسل الصور ويحفظ النص الأصلي دون تعليق مصطنع: %s %j', async (provider, input) => {
    const { result, state } = harness({ sessionId: SESSION_ID, provider });
    act(() => {
      result.current.setInput(input);
      result.current.setAttachedImages([new File(['x'], 'shot.png', { type: 'image/png' })]);
    });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });

    // T-1769: the trailing whitespace is dropped, so "   " is sent as "".
    const sentText = input.trimEnd();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].command).toBe(sentText);
    expect(state.sent[0].options.images).toEqual(uploadedImageResult);
    expect(state.added.find(message => message.type === 'user')?.content).toBe(sentText);
    expect(getOutboxSnapshot()[0].text).toBe(sentText);
    expect(getOutboxSnapshot()[0].imageNames).toEqual(['shot.png']);
    expect(result.current.attachedImages).toHaveLength(0);
  });

  it.each(['', '   '])('يمنع الرسالة الفارغة دون صور: %j', async (input) => {
    const { result, state } = harness({ sessionId: SESSION_ID });
    act(() => { result.current.setInput(input); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(state.sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
    expect(getOutboxSnapshot()).toHaveLength(0);
  });

  it('يحفظ الصورة ويعرض الخطأ ولا يرسل عند فشل الرفع', async () => {
    uploadShouldFail = true;
    const { result, state } = harness({ sessionId: SESSION_ID });
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    act(() => { result.current.setAttachedImages([file]); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(state.sent).toHaveLength(0);
    expect(getOutboxSnapshot()).toHaveLength(0);
    expect(result.current.attachedImages).toEqual([file]);
    expect(result.current.isSubmitSealed).toBe(false);
    expect(state.added.some(message => message.type === 'error')).toBe(true);
  });
});

describe('Codex image preflight', () => {
  it.each([
    ['SVG', [{ data: 'data:image/svg+xml;base64,eA==' }]],
    ['malformed base64', [{ data: 'data:image/png;base64,eB==' }]],
    ['incomplete upload', []],
  ])('keeps text and images before outbox/send for %s', async (_label, images) => {
    uploadedImageResult = images;
    const { result, state } = harness({ sessionId: SESSION_ID, provider: 'codex' });
    const image = new File(['x'], 'shot.png', { type: 'image/png' });
    act(() => { result.current.setInput('النص الأصلي'); result.current.setAttachedImages([image]); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(state.sent).toHaveLength(0);
    expect(state.added).toHaveLength(0);
    expect(getOutboxSnapshot()).toHaveLength(0);
    expect(result.current.input).toBe('النص الأصلي');
    expect(result.current.attachedImages).toEqual([image]);
    expect(result.current.isSubmitSealed).toBe(false);
    expect(result.current.sendError).toBe('codexImageInput.unsupported');
  });

  it.each([-1, 0, 1])('uses the shared combined UTF-8 text and full image limit: offset %s', async offset => {
    const prefix = 'data:image/png;base64,';
    const imageData = prefix + 'AAAA'.repeat(Math.floor((CODEX_IMAGE_INPUT_MAX_BYTES - prefix.length * 2 - 128) / 8));
    uploadedImageResult = [{ data: imageData }, { data: imageData.replace(/AAAA$/, 'AQ==') }];
    const text = 'ع' + 'x'.repeat(CODEX_IMAGE_INPUT_MAX_BYTES - imageData.length * 2 - 2 + offset);
    const { result, state } = harness({ sessionId: SESSION_ID, provider: 'codex' });
    const images = [new File(['x'], 'one.png'), new File(['x'], 'two.png')];
    act(() => { result.current.setInput(text); result.current.setAttachedImages(images); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(state.sent).toHaveLength(offset > 0 ? 0 : 1);
    if (offset > 0) {
      expect(result.current.input).toBe(text);
      expect(result.current.attachedImages).toEqual(images);
      expect(result.current.sendError).toBe('codexImageInput.tooLarge');
      expect(getOutboxSnapshot()).toHaveLength(0);
    } else {
      expect(state.sent[0].command).toBe(text);
      expect(state.sent[0].options.images).toEqual(uploadedImageResult);
    }
  });

  it.each([CODEX_IMAGE_INPUT_MAX_COUNT, CODEX_IMAGE_INPUT_MAX_COUNT + 1])('uses the shared maximum image count before sending: %s', async count => {
    const images = Array.from({ length: count }, () => new File(['x'], 'shot.png'));
    uploadedImageResult = images.map(() => ({ data: 'data:image/png;base64,eA==' }));
    const { result, state } = harness({ sessionId: SESSION_ID, provider: 'codex' });
    act(() => { result.current.setAttachedImages(images); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(state.sent).toHaveLength(count > CODEX_IMAGE_INPUT_MAX_COUNT ? 0 : 1);
    if (count > CODEX_IMAGE_INPUT_MAX_COUNT) {
      expect(result.current.attachedImages).toEqual(images);
      expect(result.current.sendError).toBe('codexImageInput.tooLarge');
    }
  });

  it.each(['claude', 'opencode'] as const)('preserves existing %s attachment behavior', async provider => {
    uploadedImageResult = [{ data: 'data:image/svg+xml;base64,eA==' }];
    const { result, state } = harness({ sessionId: SESSION_ID, provider });
    act(() => { result.current.setAttachedImages([new File(['x'], 'shot.svg')]); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].options.images).toEqual(uploadedImageResult);
  });
});

describe('الإرسال الناجح', () => {
  it('يُلحق clientMsgId بالحمولة ويُبقي الإدخال معلَّقاً (لا بطاقة)', async () => {
    const { result, state } = harness({ sessionId: SESSION_ID });

    expect(result.current.coordinationLevel).toBe('delegate');

    act(() => { result.current.setInput('رسالة تمضي'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });

    expect(state.sent).toHaveLength(1);
    const clientMsgId = state.sent[0].options.clientMsgId;
    expect(typeof clientMsgId).toBe('string');
    expect(clientMsgId).toBeTruthy();
    expect(state.sent[0].options.coordinationLevel).toBe('delegate');
    expect(state.added[0].coordinationLevel).toBe('delegate');

    const entries = getOutboxSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(clientMsgId);
    expect(entries[0].status).toBe('pending');
    expect(entries[0].intent.coordinationLevel).toBe('delegate');
    // معلَّق ⇒ لا بطاقة على الشاشة.
    expect(result.current.outboxEntries).toHaveLength(0);
  });
});

describe('إعادة الإرسال', () => {
  it('not_started الموثّق يعيد نفس clientMsgId فقط', async () => {
    recordOutboxEntry({
      id: 'not-started-id', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'لم تبدأ', status: 'failed', fileNames: [],
      intent: { provider: 'claude', coordinationLevel: 'delegate' },
    });
    markOutboxFailed('not-started-id', {
      code: 'spawn_failed', sameClientMsgIdRetryable: true,
    });

    const live = harness({ wsOpen: true, sessionId: SESSION_ID });
    await act(async () => { await live.result.current.retryOutboxEntry('not-started-id'); });

    expect(live.state.sent[0].options.clientMsgId).toBe('not-started-id');
  });

  it('الفشل النهائي يولّد clientMsgId جديداً ويحافظ على intent ومستوى التفويض', async () => {
    recordOutboxEntry({
      id: 'terminal-id', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'محاولة نهائية', status: 'failed', fileNames: [],
      intent: { provider: 'claude', model: 'sonnet-live', coordinationLevel: 'delegate_review' },
    });
    markOutboxFailed('terminal-id', {
      code: 'run_failed', sameClientMsgIdRetryable: false,
    });

    const live = harness({ wsOpen: true, sessionId: SESSION_ID });
    await act(async () => { await live.result.current.retryOutboxEntry('terminal-id'); });

    const nextId = live.state.sent[0].options.clientMsgId;
    expect(nextId).not.toBe('terminal-id');
    expect(live.state.sent[0].options.coordinationLevel).toBe('delegate_review');
    expect(live.state.sent[0].options.model).toBe('sonnet-live');
    expect(live.state.added[0]).toMatchObject({ id: nextId, coordinationLevel: 'delegate_review' });
    expect(getOutboxSnapshot().map((entry) => entry.id)).toEqual([nextId]);
  });

  it('الحالة الملتبسة أو التي بدأت لا تُعاد آلياً ولا تغيّر الصندوق', async () => {
    recordOutboxEntry({
      id: 'ambiguous-id', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'قد تكون بدأت', status: 'failed',
      intent: { provider: 'claude', coordinationLevel: 'delegate' },
    });
    const payload = {
      kind: 'complete',
      clientMsgId: 'ambiguous-id',
      success: false,
      code: 'client_msg_id_already_started',
      // الخادم يرسلها اليوم، لكنها لا تمنح إعادة الهوية ولا تدخل قرار الوضع.
      notStarted: true,
      sameClientMsgIdRetryable: false,
      error: 'This message id may already be running.',
    };
    const verdict = resolveOutboxVerdict(payload, {
      isActiveViewSession: true,
      readErrorCode: readServerErrorCode as (message: unknown) => string | null,
      readErrorDetail: readServerErrorDetail as (message: unknown) => string | null,
    });
    expect(verdict).toMatchObject({
      action: 'fail', code: 'client_msg_id_already_started', sameClientMsgIdRetryable: false,
    });
    if (verdict?.action !== 'fail') throw new Error('expected fail verdict');
    markOutboxFailed(verdict.id, {
      code: verdict.code,
      detail: verdict.detail,
      sameClientMsgIdRetryable: verdict.sameClientMsgIdRetryable,
    });
    expect(outboxRetryMode(getOutboxSnapshot()[0])).toBe('verify');
    const before = getOutboxSnapshot()[0];

    const live = harness({ wsOpen: true, sessionId: SESSION_ID });
    await act(async () => { await live.result.current.retryOutboxEntry('ambiguous-id'); });

    expect(live.state.sent).toHaveLength(0);
    expect(getOutboxSnapshot()[0]).toEqual(before);
  });

  it('outbox متلاعب به يسقط إلى direct ولا يوسّع التفويض', async () => {
    const entry = recordOutboxEntry({
      id: 'tampered-coordination',
      projectId: PROJECT.projectId,
      sessionId: SESSION_ID,
      text: 'رسالة متلاعب بها',
      fileNames: [],
      status: 'failed',
      intent: { provider: 'claude', coordinationLevel: 'unknown-level' as any },
    });
    expect(entry).toBeTruthy();

    const live = harness({ wsOpen: true, sessionId: SESSION_ID });
    await act(async () => { await live.result.current.retryOutboxEntry('tampered-coordination'); });

    expect(live.state.sent[0].options.coordinationLevel).toBe('direct');
    expect(live.state.added[0].coordinationLevel).toBe('direct');
  });

  it('تخزين مستوى تالف يُستعاد direct بينما الغائب يبقى delegate', async () => {
    localStorage.setItem(`coordination_level_${SESSION_ID}`, 'delegate_review_plus');
    const corrupt = harness({ sessionId: SESSION_ID });
    await waitFor(() => expect(corrupt.result.current.coordinationLevel).toBe('direct'));

    localStorage.removeItem(`coordination_level_${SESSION_ID}`);
    const absent = harness({ sessionId: SESSION_ID });
    await waitFor(() => expect(absent.result.current.coordinationLevel).toBe('delegate'));
  });

  it('تقرأ toolsSettings حيّة ولا تُعيد صلاحية أطفأها المستخدم', async () => {
    const { result, state } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput('رسالة'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    const entryId = getOutboxSnapshot()[0].id;

    // بين المحاولتين: المستخدم يُطفئ تخطّي الأذونات.
    localStorage.setItem(
      'claude-settings',
      JSON.stringify({ allowedTools: [], disallowedTools: [], skipPermissions: false }),
    );

    const live = harness({ wsOpen: true, sessionId: SESSION_ID });
    await act(async () => { await live.result.current.retryOutboxEntry(entryId); });

    expect(live.state.sent).toHaveLength(1);
    expect(live.state.sent[0].options.toolsSettings.skipPermissions).toBe(false);
    expect(state.sent).toHaveLength(0);
  });

  it('تُعيد نيّة صاحب الرسالة (النموذج) لا اختيار المُؤلِّف الحالي', async () => {
    const { result } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput('رسالة'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    const entryId = getOutboxSnapshot()[0].id;
    expect(getOutboxSnapshot()[0].intent.model).toBe('sonnet-live');

    // المُؤلِّف الآن على نموذج آخر تماماً.
    const later = renderHookWithModel('opus-later');
    await act(async () => { await later.result.current.retryOutboxEntry(entryId); });

    expect(later.state.sent[0].options.model).toBe('sonnet-live');
  });

  it('تستأنف الجلسة التي وُلدت بين المحاولتين بدل فتح محادثة ثانية', async () => {
    const { result } = harness({ wsOpen: false, sessionId: null });

    act(() => { result.current.setInput('أول رسالة'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    const entryId = getOutboxSnapshot()[0].id;
    expect(getOutboxSnapshot()[0].sessionId).toBeNull();

    // الآن للمحادثة معرّف.
    const live = harness({ wsOpen: true, sessionId: 'sess-born-later' });
    await act(async () => { await live.result.current.retryOutboxEntry(entryId); });

    expect(live.state.sent[0].options.sessionId).toBe('sess-born-later');
    expect(live.state.sent[0].options.resume).toBe(true);
  });

  it('conversation_not_found: الإعادة تبدأ محادثة جديدة لا تستأنف ميتةً', async () => {
    const { result } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput('رسالة على محادثة ذهبت'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    const entryId = getOutboxSnapshot()[0].id;
    markOutboxFailed(entryId, { code: 'conversation_not_found' });

    const live = harness({ wsOpen: true, sessionId: SESSION_ID });
    await act(async () => { await live.result.current.retryOutboxEntry(entryId); });

    // بلا هذا لكانت الإعادة تستأنف المعرّف الميّت فتفشل ثانيةً — حلقة مغلقة.
    expect(live.state.sent[0].options.sessionId).toBeNull();
    expect(live.state.sent[0].options.resume).toBe(false);
  });

  /**
   * B-536 — رسالةٌ بلغت سجلَّ المحادثة لا تُسأل عنها ضغطةٌ ثانية.
   *
   * الحادثة: أمرُ المالك «نفذ» نُفِّذ وردُّه معروض أمامه، ومع ذلك بقيت بطاقةُ
   * «لم يصل تأكيد» ساعاتٍ — لأن `complete` وصل حين لم يكن هذا المتصفّح
   * متصلاً، فلا حكمَ يُحذف به الإدخال. التحقّق صار تلقائياً عند العرض.
   */
  /** إدخالٌ معلَّق أُنشئ في الماضي ⇒ يتجاوز مهلة الشكّ فيبلغ العرض. */
  async function stalePendingEntry(text: string) {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 10 * 60 * 1000);
    const { result, unmount } = harness({ wsOpen: false, sessionId: SESSION_ID });
    act(() => { result.current.setInput(text); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    const entryId = getOutboxSnapshot()[0].id;
    markOutboxPending(entryId);
    unmount();
    vi.useRealTimers();
    return entryId;
  }

  it('إدخال v1 مشكوك فيه يبقى حتى يستورده مسار v2 ذي الدليل الكامل', async () => {
    await stalePendingEntry('نفذ');
    expect(getOutboxSnapshot()).toHaveLength(1);

    // identity/receipt القديم لا يملك جيل v2 ولا تغطية أجزاء كاملة، فلا حذف.
    const live = harness({ wsOpen: true, sessionId: SESSION_ID, delivered: true });
    await waitFor(() => expect(getOutboxSnapshot()).toHaveLength(1));
    live.unmount();
  });

  it('السجلّ لا يحمل الرسالة ⇒ الإدخال يبقى ولا يُحذف صامتاً', async () => {
    await stalePendingEntry('رسالة لم تصل فعلاً');

    const live = harness({ wsOpen: true, sessionId: SESSION_ID, delivered: false });
    await waitFor(() => expect(live.result.current.outboxEntries).toHaveLength(1));
    expect(getOutboxSnapshot()).toHaveLength(1);
    live.unmount();
  });

  it('انقطاع أثناء Processing ثم إعادة الاتصال لا يُظهر بطاقةً كاذبة', async () => {
    await stalePendingEntry('رسالة بدأ تنفيذها');
    setSessionProcessState(SESSION_ID, 'running');
    testProcessEpoch = beginSessionProcessConnectionEpoch();
    const verify = vi.fn(async () => false);

    // الانقطاع لا يسقط دليل التشغيل المخزّن، وحتى لو غاب الدليل لا تكون قناة
    // الحالة ذات سلطة أثناء reconnect كي تحكم بأن الجولة ساكنة.
    const reconnecting = harness({
      sessionId: SESSION_ID,
      authoritative: false,
      verify,
    });
    expect(reconnecting.result.current.outboxEntries).toHaveLength(0);
    expect(verify).not.toHaveBeenCalled();
    reconnecting.unmount();

    // بعد رجوع القناة ووصول running يبقى الإدخال مخفياً ولا يبدأ تحققٌ كاذب.
    const reconnected = harness({
      sessionId: SESSION_ID,
      processState: 'running',
      delivered: false,
    });
    expect(reconnected.result.current.outboxEntries).toHaveLength(0);
    reconnected.unmount();
  });

  it('frozen جولة بدأت فعلاً فلا تظهر لها بطاقة', async () => {
    await stalePendingEntry('رسالة مجمّدة مؤقتاً');
    const frozen = harness({
      sessionId: SESSION_ID,
      processState: 'frozen',
      delivered: false,
    });

    expect(frozen.result.current.outboxEntries).toHaveLength(0);
    frozen.unmount();
  });

  it('إعادة الاتصال لا تخفي رسالة لم تبدأ فعلاً', async () => {
    await stalePendingEntry('رسالة لم تبدأ');
    setSessionProcessState(SESSION_ID, 'idle');

    const reconnected = harness({
      sessionId: SESSION_ID,
      processState: 'idle',
      delivered: false,
    });

    await waitFor(() => expect(reconnected.result.current.outboxEntries).toHaveLength(1));
    expect(getOutboxSnapshot()).toHaveLength(1);
    reconnected.unmount();
  });

  /**
   * B-539 — لا بطاقة قبل حكم.
   *
   * كانت تُرسم فور استحقاق الشكّ بينما جواب السجلّ في الطريق (وسجلّ المحادثة
   * نفسه لم يُحمَّل بعد)، فيراها المالك ثم تختفي بعد ثانية — ووميضُ إنذارٍ
   * كاذب أسوأ من إنذارٍ ثابت.
   */
  it('لا تُعرض بطاقةٌ ما دام التحقّق جارياً', async () => {
    await stalePendingEntry('رسالة قيد التحقّق');

    let release: (value: boolean) => void = () => {};
    const pendingVerify = new Promise<boolean>((resolve) => { release = resolve; });
    const live = harness({ wsOpen: true, sessionId: SESSION_ID, verify: () => pendingVerify });

    // الحكم لم يصل بعد ⇒ لا شيء على الشاشة، والإدخال محفوظ كما هو.
    expect(live.result.current.outboxEntries).toHaveLength(0);
    expect(getOutboxSnapshot()).toHaveLength(1);

    await act(async () => { release(false); await pendingVerify; });
    await waitFor(() => expect(live.result.current.outboxEntries).toHaveLength(1));
    live.unmount();
  });

  it('حكمٌ صريح بالفشل يُعرض فوراً بلا انتظار تحقّق', async () => {
    const { result } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput('فشل نقل صريح'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });

    expect(getOutboxSnapshot()[0].status).toBe('failed');
    expect(result.current.outboxEntries).toHaveLength(1);
  });

  // B-536 (قرار المالك 2026-08-07): «تعديل» تسليمٌ لا نسخ — النصّ ينتقل إلى
  // المُؤلِّف وتزول البطاقة. كان الإدخال يبقى محفوظاً، فتُعرض نسختان من كلامٍ
  // واحد ويبقى إنذارٌ قائم عن رسالةٍ صار أمرُها بيد صاحبها.
  it('«تعديل» يعيد النصّ إلى المُؤلِّف ويُزيل البطاقة', async () => {
    const { result } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput('نصّ للتعديل'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    const entryId = getOutboxSnapshot()[0].id;

    await act(async () => { await result.current.editOutboxEntry(entryId); });

    expect(result.current.input).toBe('نصّ للتعديل');
    expect(getOutboxSnapshot()).toHaveLength(0);
  });

  it('«حذف» يزيل الإدخال', async () => {
    const { result } = harness({ wsOpen: false, sessionId: SESSION_ID });

    act(() => { result.current.setInput('نصّ للحذف'); });
    await act(async () => { await result.current.handleSubmit(fakeEvent); });
    const entryId = getOutboxSnapshot()[0].id;

    act(() => { result.current.deleteOutboxEntry(entryId); });

    expect(getOutboxSnapshot()).toHaveLength(0);
  });
});

/** نسخة من الـharness بنموذج claude مختلف — لاختبار استعادة النيّة. */
function renderHookWithModel(claudeModel: string) {
  const state: Harness = { sent: [], withdrawn: [], withdrawnIds: [], added: [] };
  const props = {
    selectedProject: PROJECT,
    selectedSession: { id: SESSION_ID } as any,
    currentSessionId: SESSION_ID,
    provider: 'claude' as const,
    displayProvider: 'claude' as const,
    engineProvider: null,
    permissionMode: 'default',
    cyclePermissionMode: () => {},
    cursorModel: 'cur', claudeModel, codexModel: 'cx', geminiModel: 'gm',
    antigravityModel: 'ag', opencodeModel: 'oc', hermesModel: 'hm', kimiModel: 'km',
    deepseekModel: 'ds', glmModel: 'glm',
    isLoading: false,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: (message: unknown) => { state.sent.push(message); return { ok: true }; },
    pendingViewSessionRef: { current: null } as any,
    scrollToBottom: () => {},
    addMessage: (msg: any) => state.added.push(msg),
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setIsUserScrolledUp: () => {},
    setPendingPermissionRequests: () => {},
  };
  const rendered = renderHook(() => useChatComposerState(props as any));
  return { state, ...rendered };
}

describe('B-894 manual delivery verification', () => {
  it.each([false, 'network'])('keeps unknown delivery non-retryable for %s', async (outcome) => {
    const verify = vi.fn(async () => { if (outcome === 'network') throw new Error('offline'); return false; });
    const live = harness({ sessionId: SESSION_ID, verify });
    act(() => { recordOutboxEntry({ id: 'cmid_check', projectId: 'proj-1', sessionId: SESSION_ID, text: 'موافق' }); });
    await act(async () => { await live.result.current.verifyOutboxEntry('cmid_check'); });
    expect(verify).toHaveBeenCalledWith(SESSION_ID, 'cmid_check', undefined);
    expect(getOutboxSnapshot()[0].status).toBe('pending');
    expect(outboxRetryMode(getOutboxSnapshot()[0])).toBe('verify');
    live.unmount();
  });
  it('does not remove a replaced entry after an asynchronous verification', async () => {
    let resolve!: (accepted: boolean) => void;
    const live = harness({ sessionId: SESSION_ID, verify: () => new Promise<boolean>((done) => { resolve = done; }) });
    act(() => { recordOutboxEntry({ id: 'cmid_check', projectId: 'proj-1', sessionId: SESSION_ID, text: 'first' }); });
    let pending!: Promise<void>;
    act(() => { pending = live.result.current.verifyOutboxEntry('cmid_check'); });
    act(() => { recordOutboxEntry({ id: 'cmid_check', projectId: 'proj-1', sessionId: SESSION_ID, text: 'replacement' }); });
    await act(async () => { resolve(true); await pending; });
    expect(getOutboxSnapshot()[0].text).toBe('replacement');
    live.unmount();
  });
});

describe('B-894 durable delivery lifecycle in the composer hook', () => {
  it('retains accepted v1 text across remount; late identity alone is not deletion proof', async () => {
    const live = harness({ sessionId: SESSION_ID, verify: async () => 'accepted' });
    act(() => {
      for (const id of ['cmid_first', 'cmid_second']) recordOutboxEntry({ id, projectId: 'proj-1', sessionId: SESSION_ID, text: 'موافق', intent: { provider: 'codex' } });
    });
    await act(async () => { await live.result.current.verifyOutboxEntry('cmid_first'); });
    expect(getOutboxSnapshot()[0].status).toBe('delivered');
    expect(getOutboxSnapshot()[0].text).toBe('موافق');
    live.unmount();
    act(() => { setOutboxUser(null); setOutboxUser(2); });
    const restored = harness({ sessionId: SESSION_ID });
    expect(getOutboxSnapshot()[0].text).toBe('موافق');
    act(() => restored.updateHistory([{ id: 'old-server-row', sessionId: SESSION_ID, kind: 'text', role: 'user', content: 'موافق' }]));
    expect(getOutboxSnapshot()).toHaveLength(2);
    act(() => restored.updateHistory([{ id: 'saved', sessionId: SESSION_ID, kind: 'text', role: 'user', clientMsgId: 'cmid_first' }]));
    expect(getOutboxSnapshot().map((entry) => entry.id)).toEqual(['cmid_first', 'cmid_second']);
    restored.unmount();
  });
  it('refuses dispatch and preserves composer when confirmed storage is full', async () => {
    for (let n = 0; n < MAX_OUTBOX_ENTRIES; n++) {
      recordOutboxEntry({ id: `cmid_saved_${n}`, projectId: 'proj-1', sessionId: SESSION_ID, text: 'saved' });
      confirmOutboxEntry(`cmid_saved_${n}`);
    }
    const live = harness({ sessionId: SESSION_ID });
    act(() => live.result.current.setInput('new text'));
    await act(async () => { await live.result.current.handleSubmit(fakeEvent); });
    expect(live.state.sent).toHaveLength(0);
    expect(live.state.added).toHaveLength(0);
    expect(live.result.current.input).toBe('new text');
    expect(live.result.current.sendError).toBe('outbox.storageFull');
    live.unmount();
  });
});

it('B-894 does not settle another account after an in-flight receipt query', async () => {
  let resolve!: (accepted: 'accepted') => void;
  const verify = vi.fn(() => new Promise<'accepted'>((done) => { resolve = done; }));
  const live = harness({ sessionId: SESSION_ID, verify });
  act(() => { recordOutboxEntry({ id: 'cmid_x', projectId: 'proj-1', sessionId: SESSION_ID, text: 'owner', intent: { provider: 'codex', engineProvider: 'openai' } }); });
  let pending!: Promise<void>;
  act(() => { pending = live.result.current.verifyOutboxEntry('cmid_x'); });
  expect(verify).toHaveBeenCalledWith(SESSION_ID, 'cmid_x', 'codex');
  act(() => { setOutboxUser(3); recordOutboxEntry({ id: 'cmid_x', projectId: 'proj-1', sessionId: 'other-session', text: 'other owner' }); });
  await act(async () => { resolve('accepted'); await pending; });
  expect(getOutboxSnapshot()[0].status).toBe('pending');
  expect(getOutboxSnapshot()[0].text).toBe('other owner');
  live.unmount();
});

it('B-894 delivered card preserves text and offers no replay or edit action', () => {
  recordOutboxEntry({ id: 'cmid_x', projectId: 'proj-1', sessionId: SESSION_ID, text: 'موافق' });
  confirmOutboxEntry('cmid_x');
  const card = render(<OutboxCard entry={getOutboxSnapshot()[0]} onRetry={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onVerify={vi.fn()} />);
  expect(card.getByText('موافق')).toBeTruthy();
  expect(card.getByText('outbox.titleDelivered')).toBeTruthy();
  expect(card.queryByText('outbox.verify')).toBeNull();
  expect(card.queryByText('outbox.edit')).toBeNull();
  expect(card.queryByText('outbox.retry')).toBeNull();
  card.unmount();
});

it('B-894 retries unknown receipt verification after a new authoritative connection without deleting v1', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() - 120_000);
  recordOutboxEntry({ id: 'cmid_reconnect', projectId: 'proj-1', sessionId: SESSION_ID, text: 'موافق', intent: { provider: 'codex' } });
  vi.useRealTimers();
  let accepted = false;
  const verify = vi.fn(async () => accepted ? 'accepted' as const : 'unknown' as const);
  const live = harness({ sessionId: SESSION_ID, verify });
  await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
  accepted = true;
  act(() => { testProcessEpoch = beginSessionProcessConnectionEpoch(); });
  act(() => { setSessionProcessState(SESSION_ID, 'idle', { epoch: testProcessEpoch, authoritative: true }); });
  await waitFor(() => expect(getOutboxSnapshot()[0].status).toBe('delivered'));
  expect(verify).toHaveBeenCalledTimes(2);
  live.unmount();
});

it('B-894 same-id retry stops before upload and dispatch if pending cannot persist', async () => {
  recordOutboxEntry({ id: 'cmid_retry_quota', projectId: 'proj-1', sessionId: SESSION_ID, text: 'retained', fileNames: [], images: [new File(['image'], 'image.png')] });
  markOutboxFailed('cmid_retry_quota', { code: 'not_started', sameClientMsgIdRetryable: true });
  const live = harness({ sessionId: SESSION_ID });
  const before = localStorage.getItem('nassaj_outbox_v1_u2');
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  try {
    await act(async () => { await live.result.current.retryOutboxEntry('cmid_retry_quota'); });
    expect(live.state.sent).toHaveLength(0);
    expect(uploadCalls).toHaveLength(0);
    expect(live.state.added).toHaveLength(0);
    expect(live.result.current.sendError).toBe('outbox.storageFull');
    expect(getOutboxSnapshot()[0].status).toBe('failed');
    expect(localStorage.getItem('nassaj_outbox_v1_u2')).toBe(before);
  } finally { setItem.mockRestore(); live.unmount(); }
});

it('B-894 online wake recovers unknown once and throttles repeated wake events', async () => {
  vi.useFakeTimers();
  const verify = vi.fn(async () => 'unknown' as const);
  recordOutboxEntry({ id: 'wake', projectId: 'proj-1', sessionId: SESSION_ID, text: 'retained', status: 'unconfirmed' });
  const live = harness({ sessionId: SESSION_ID, verify });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
    expect(verify).toHaveBeenCalledTimes(5);
    act(() => window.dispatchEvent(new Event('online')));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(verify).toHaveBeenCalledTimes(6);
    act(() => window.dispatchEvent(new Event('online')));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(verify).toHaveBeenCalledTimes(6);
  } finally { live.unmount(); vi.useRealTimers(); }
});

describe('B-969 durable retry admission', () => {
  it.each(['storage', 'image-copy'] as const)('does not upload a new-ID retry before durable replacement (%s)', async (failure) => {
    const image = new File(['image'], 'image.png', { type: 'image/png' });
    recordOutboxEntry({ id: 'durable-original', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'retain the original', fileNames: [], images: [image] });
    markOutboxFailed('durable-original', { code: 'run_failed', sameClientMsgIdRetryable: false });
    const original = getOutboxSnapshot()[0];
    const live = harness({ sessionId: SESSION_ID });
    const put = vi.spyOn(blobs.store, 'put');
    if (failure === 'image-copy') put.mockRejectedValue(new Error('image copy unavailable'));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    if (failure === 'storage') setItem.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      await act(async () => { await live.result.current.retryOutboxEntry(original.id); });
      expect(uploadCalls).toHaveLength(0);
      expect(live.state.sent).toHaveLength(0);
      expect(live.state.added).toHaveLength(0);
      expect(getOutboxSnapshot()).toHaveLength(1);
      expect(getOutboxSnapshot()[0]).toMatchObject(original);
      expect(blobs.map.get('durable-original#0')).toBe(image);
    } finally { put.mockRestore(); setItem.mockRestore(); live.unmount(); }
  });

  it('keeps same-ID upload failure retryable and sends that ID when upload later succeeds', async () => {
    recordOutboxEntry({ id: 'retry-upload', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'same identity', fileNames: [], images: [new File(['image'], 'image.png')] });
    markOutboxFailed('retry-upload', { code: 'not_started', sameClientMsgIdRetryable: true });
    const originalCreatedAt = getOutboxSnapshot()[0].createdAt;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalCreatedAt + 1_000);
    const live = harness({ sessionId: SESSION_ID });
    try {
      uploadShouldFail = true;
      await act(async () => { await live.result.current.retryOutboxEntry('retry-upload'); });
      expect(live.state.sent).toHaveLength(0);
      expect(getOutboxSnapshot()).toHaveLength(1);
      expect(getOutboxSnapshot()[0]).toMatchObject({ id: 'retry-upload', text: 'same identity', status: 'failed' });
      expect(outboxRetryMode(getOutboxSnapshot()[0])).toBe('same_id');
      expect(getOutboxSnapshot()[0].createdAt).toBe(originalCreatedAt);
      uploadShouldFail = false;
      await act(async () => { await live.result.current.retryOutboxEntry('retry-upload'); });
      expect(uploadCalls).toHaveLength(2);
      expect(live.state.sent).toHaveLength(1);
      expect(live.state.sent[0].options.clientMsgId).toBe('retry-upload');
    } finally { clock.mockRestore(); live.unmount(); }
  });

  it.each([true, false].flatMap(sameId => [true, false].map(uploadFails => [sameId, uploadFails] as const)))(
    'does not dispatch or lose a receipt received during upload (same ID %s, upload fails %s)', async (sameId, uploadFails) => {
    recordOutboxEntry({ id: 'receipt-upload', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'already received', fileNames: [], images: [new File(['image'], 'image.png')] });
    markOutboxFailed('receipt-upload', { code: 'transport', sameClientMsgIdRetryable: sameId });
    const live = harness({ sessionId: SESSION_ID });
    let release!: () => void;
    uploadGate = new Promise<void>(resolve => { release = resolve; });
    let retry!: Promise<void>;
    try {
      act(() => { retry = live.result.current.retryOutboxEntry('receipt-upload'); });
      await waitFor(() => expect(uploadCalls).toHaveLength(1));
      act(() => { confirmOutboxEntry('receipt-upload'); });
      uploadShouldFail = uploadFails;
      await act(async () => { release(); await retry; });
      expect(live.state.sent).toHaveLength(0);
      expect(live.state.added).toHaveLength(0);
      expect(getOutboxSnapshot().find(entry => entry.id === 'receipt-upload')).toMatchObject({
        status: 'delivered', text: 'already received', imageNames: ['image.png'],
      });
    } finally { release(); await retry; live.unmount(); }
  });

  it.each([true, false])('admits one retry when clicked twice during upload (same ID %s)', async (sameId) => {
    recordOutboxEntry({ id: 'double-upload', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'send once', fileNames: [], images: [new File(['image'], 'image.png')] });
    markOutboxFailed('double-upload', { code: 'transport', sameClientMsgIdRetryable: sameId });
    const live = harness({ sessionId: SESSION_ID });
    let release!: () => void;
    uploadGate = new Promise<void>(resolve => { release = resolve; });
    let first!: Promise<void>; let second!: Promise<void>;
    try {
      act(() => { first = live.result.current.retryOutboxEntry('double-upload'); });
      await waitFor(() => expect(uploadCalls).toHaveLength(1));
      act(() => { second = live.result.current.retryOutboxEntry('double-upload'); });
      await act(async () => { release(); await Promise.all([first, second]); });
      expect(uploadCalls).toHaveLength(1);
      expect(live.state.sent).toHaveLength(1);
      expect(getOutboxSnapshot()).toHaveLength(1);
    } finally { release(); await Promise.all([first, second]); live.unmount(); }
  });

  it.each([true, false])('does not dispatch into an account switched during upload (same ID %s)', async (sameId) => {
    recordOutboxEntry({ id: 'account-upload', projectId: PROJECT.projectId, sessionId: SESSION_ID,
      text: 'belongs to account two', fileNames: [], images: [new File(['image'], 'image.png')] });
    markOutboxFailed('account-upload', { code: 'transport', sameClientMsgIdRetryable: sameId });
    const live = harness({ sessionId: SESSION_ID });
    let release!: () => void;
    uploadGate = new Promise<void>(resolve => { release = resolve; });
    let retry!: Promise<void>;
    try {
      act(() => { retry = live.result.current.retryOutboxEntry('account-upload'); });
      await waitFor(() => expect(uploadCalls).toHaveLength(1));
      act(() => {
        setOutboxUser(3);
        recordOutboxEntry({ id: 'other-account', projectId: PROJECT.projectId, sessionId: null, text: 'do not alter' });
      });
      const otherAccount = getOutboxSnapshot();
      const savedOtherAccount = localStorage.getItem('nassaj_outbox_v1_u3');
      await act(async () => { release(); await retry; });
      expect(live.state.sent).toHaveLength(0);
      expect(live.state.added).toHaveLength(0);
      expect(getOutboxSnapshot()).toEqual(otherAccount);
      expect(localStorage.getItem('nassaj_outbox_v1_u3')).toBe(savedOtherAccount);
    } finally { release(); await retry; live.unmount(); setOutboxUser(2); }
  });
});

it.each([true, false])('B-969 preserves a replacement receipt during upload (upload fails %s)', async (uploadFails) => {
  recordOutboxEntry({ id: 'replacement-origin', projectId: PROJECT.projectId, sessionId: SESSION_ID,
    text: 'retain confirmed replacement', fileNames: [], images: [new File(['image'], 'image.png')] });
  markOutboxFailed('replacement-origin', { code: 'transport', sameClientMsgIdRetryable: false });
  const live = harness({ sessionId: SESSION_ID });
  let release!: () => void;
  uploadGate = new Promise<void>(resolve => { release = resolve; });
  let retry!: Promise<void>;
  try {
    act(() => { retry = live.result.current.retryOutboxEntry('replacement-origin'); });
    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    const replacement = getOutboxSnapshot().find(entry => entry.id !== 'replacement-origin');
    expect(replacement).toBeDefined();
    act(() => { confirmOutboxEntry(replacement!.id); });
    uploadShouldFail = uploadFails;
    await act(async () => { release(); await retry; });
    expect(live.state.sent).toHaveLength(0);
    expect(live.state.added).toHaveLength(0);
    expect(getOutboxSnapshot().find(entry => entry.id === replacement!.id)).toMatchObject({
      status: 'delivered', text: 'retain confirmed replacement', imageNames: ['image.png'],
    });
  } finally { release(); await retry; live.unmount(); }
});


it('B-1007 shows uncertainty immediately, retains images through failed verification, and restores them for editing', async () => {
  const image = new File(['original-image'], 'failure.png', { type: 'image/png' });
  const live = harness({ sessionId: SESSION_ID, authoritative: false, verify: async () => { throw new Error('503'); } });
  act(() => {
    recordOutboxEntry({ id: 'dispatch-unknown', projectId: 'proj-1', sessionId: SESSION_ID, text: 'protected text', images: [image], fileNames: [], intent: { provider: 'codex' } });
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'dispatch-unknown', deliveryDisposition: 'unknown' });
  });
  expect(live.result.current.outboxEntries.map(entry => entry.id)).toEqual(['dispatch-unknown']);
  const card = render(<OutboxCard entry={live.result.current.outboxEntries[0]} onRetry={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onVerify={vi.fn()} />);
  expect(card.queryByText('outbox.verify')).not.toBeNull();
  expect(card.queryByText('outbox.retry')).toBeNull();
  await act(async () => { await live.result.current.verifyOutboxEntry('dispatch-unknown'); });
  expect(live.result.current.outboxEntries).toHaveLength(1);
  expect(live.state.sent).toHaveLength(0);
  await act(async () => { await live.result.current.editOutboxEntry('dispatch-unknown'); });
  expect(live.result.current.input).toBe('protected text');
  expect(live.result.current.attachedImages).toEqual([image]);
  card.unmount(); live.unmount();
});

it('B-1007 explicit pre-dispatch certificate permits same-ID retry with its image', async () => {
  const live = harness({ sessionId: SESSION_ID, provider: 'codex', authoritative: false });
  act(() => {
    recordOutboxEntry({ id: 'dispatch-not-started', projectId: 'proj-1', sessionId: SESSION_ID, text: 'retry text', images: [new File(['image'], 'retry.png', { type: 'image/png' })], fileNames: [], intent: { provider: 'codex' } });
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'dispatch-not-started', deliveryDisposition: 'not_started', notStarted: true, sameClientMsgIdRetryable: true });
  });
  expect(live.result.current.outboxEntries).toHaveLength(1);
  await act(async () => { await live.result.current.retryOutboxEntry('dispatch-not-started'); });
  expect(live.state.sent).toHaveLength(1);
  expect(JSON.stringify(live.state.sent[0])).toContain('dispatch-not-started');
  expect(live.state.sent[0].options.images).toEqual(uploadedImageResult);
  expect(uploadCalls).toHaveLength(1);
  live.unmount();
});

it('B-1007 editing an uncertain image does not cross an account switch during image read', async () => {
  const image = new File(['private'], 'private.png', { type: 'image/png' });
  let finishRead!: (files: File[]) => void;
  const live = harness({ sessionId: SESSION_ID, authoritative: false });
  act(() => {
    recordOutboxEntry({ id: 'edit-account-race', projectId: 'proj-1', sessionId: SESSION_ID, text: 'private text', images: [image], fileNames: [] });
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'edit-account-race', deliveryDisposition: 'unknown' });
  });
  await Promise.resolve();
  setOutboxBlobStore({ ...blobs.store, getMany: () => new Promise(resolve => { finishRead = resolve; }) });
  let editing!: Promise<void>;
  act(() => { editing = live.result.current.editOutboxEntry('edit-account-race'); });
  act(() => { setOutboxUser(3); });
  await act(async () => { finishRead([image]); await editing; });
  expect(live.result.current.input).not.toBe('private text');
  expect(live.result.current.attachedImages).toHaveLength(0);
  live.unmount();
});

it('B-1007 editing preserves the protected copy when image data is unavailable', async () => {
  const live = harness({ sessionId: SESSION_ID, authoritative: false });
  act(() => {
    recordOutboxEntry({ id: 'edit-missing-image', projectId: 'proj-1', sessionId: SESSION_ID, text: 'keep text', images: [new File(['private'], 'private.png', { type: 'image/png' })], fileNames: [] });
    consumeOutboxIngressVerdict({ kind: 'error', clientMsgId: 'edit-missing-image', deliveryDisposition: 'unknown' });
  });
  setOutboxBlobStore({ ...blobs.store, getMany: async () => [] });
  await act(async () => { await live.result.current.editOutboxEntry('edit-missing-image'); });
  expect(getOutboxSnapshot()).toHaveLength(1);
  expect(live.result.current.input).not.toBe('keep text');
  expect(live.result.current.sendError).toBe('outbox.reason.attachment_images_missing');
  live.unmount();
});
