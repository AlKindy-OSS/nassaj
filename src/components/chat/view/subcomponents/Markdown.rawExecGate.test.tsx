/**
 * B-429/T-1233 — بوابة إظهار زرّ التنفيذ الحر على كتل الكود.
 *
 * الشكوى: «يظهر لي تنفيذ رغم أن العرض ليس للتنفيذ بل للشرح». كان الشرط لغةَ
 * الكتلة — `bash|sh|shell|zsh|fish` **أو بلا لغة إطلاقاً** — واللغةُ تصف ما هو
 * النصّ لا ما يُراد به. وكان الشرط ناقصاً `inlineExecEnabled`، وهو ما جعل الزرّ
 * يظهر أيضاً على نتائج الأدوات وكتل التفكير: محتوى ملف مقروء أو صفحة مجلوبة
 * يكفيه سياج ```bash ليعرض زرّ تنفيذ.
 *
 * ما يحرسه هذا الملف هو الشرط نفسه، لأنه الموضع الذي ينزلق صامتاً: عودةُ
 * `=== ''`، أو مطابقةُ الوسم بـ`includes` (تطابق `nassaj-runner` — وهو اسم
 * مشروع قائم في هذا الريبو)، أو سقوطُ `inlineExecEnabled` مرّةً أخرى.
 *
 * **تنبيه لقارئ لاحق:** هذا الشرط ليس حدّاً أمنياً. من يملك طبقة `raw` يُدرج أي
 * أمر بطلب HTTP مباشر بلا واجهة أصلاً. الحدود الحقيقية في
 * `server/services/command-board-raw.js` (الطبقة، التسليح، قائمة المنع، ربط
 * البصمة) وفي مراجعة المالك بـ`ExecReviewDialog`. هذه بوابة نيّة وضجيج.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/Markdown.rawExecGate.test.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { ChatActionsContext, type ChatActionsContextValue } from '../../context/ChatActionsContext';

import { Markdown } from './Markdown';

// محاكاة جزئية: الأصل يُبقي `initReactI18next` الذي تحتاجه سلسلة الاستيراد.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
  }),
}));

// مستخدم مُصادَق: `useRawExecConfig` هي من يقرّر، لا الدور هنا (ADR-072).
vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: 1, username: 'owner' } }),
}));

// قرار الخادم مُثبَّت `true` في معظم الحالات كي يبقى المتغيّر تحت الفحص هو
// الكتلة نفسها؛ الحالة المعاكسة لها اختبارها الخاص أدناه.
const mockCanUseRaw = vi.fn(() => true);
vi.mock('../../../../hooks/useRawExecConfig', () => ({
  useRawExecConfig: () => ({ canUseRaw: mockCanUseRaw(), loading: false }),
  useRawExecQueue: () => ({ commands: [], canUseRaw: false, loading: false, refresh: () => {} }),
  invalidateRawExecConfig: () => {},
  refreshRawExecConfig: () => {},
}));

/** تسمية الزرّ = `defaultValue` لمفتاح `codeBlock.executeRawTitle` (محاكاة t). */
const RAW_BUTTON = 'Execute this command on the Nassaj server (opens review dialog)';

const queryRawButton = () => screen.queryByRole('button', { name: RAW_BUTTON });

const CTX: ChatActionsContextValue = {
  catalog: [],
  runAction: async () => ({ status: 'error' as const, code: 'test' }),
  userRole: 'owner',
  inlineExecEnabled: true,
  liveStatusOf: () => null,
  sessionId: null,
};

/** يُصيّر داخل سياق رسالة المساعد الرئيسية (حيث الزرّ مسموح أصلاً). */
function renderInAssistantMessage(
  md: string,
  { streaming = false, ctx = CTX }: { streaming?: boolean; ctx?: ChatActionsContextValue } = {},
) {
  return render(
    <ChatActionsContext.Provider value={ctx}>
      <Markdown streaming={streaming}>{md}</Markdown>
    </ChatActionsContext.Provider>,
  );
}

const fence = (info: string, body = 'echo hi') => '```' + info + '\n' + body + '\n```';

afterEach(() => {
  cleanup();
  mockCanUseRaw.mockReturnValue(true);
});

describe('زرّ التنفيذ الحر — الكتلة الموسومة وحدها', () => {
  it('يظهر لكتلة تحمل وسم nassaj-run', () => {
    renderInAssistantMessage(fence('bash nassaj-run'));
    expect(queryRawButton()).not.toBeNull();
  });

  it('يقبل الفراغات المتعددة ورموز meta الإضافية', () => {
    // `meta` هي كل ما بعد رمز اللغة، وقد تحمل أكثر من رمز.
    for (const info of ['bash  nassaj-run', 'bash nassaj-run title=deploy', 'sh nassaj-run']) {
      renderInAssistantMessage(fence(info));
      expect(queryRawButton(), info).not.toBeNull();
      cleanup();
    }
  });
});

describe('زرّ التنفيذ الحر — ما كان يظهر ولم يعد', () => {
  // قلبُ السلوك القديم. كل واحدة من هذه كانت تحمل زرّاً قبل B-429.
  it.each([
    ['كتلة bash بلا وسم', 'bash'],
    ['كتلة sh بلا وسم', 'sh'],
    ['كتلة shell بلا وسم', 'shell'],
    ['كتلة بلا لغة إطلاقاً', ''],
  ])('لا زرّ لـ%s', (_label, info) => {
    renderInAssistantMessage(fence(info));
    expect(queryRawButton()).toBeNull();
  });

  it('لا زرّ لكتلة غير موسومة مهما طالت', () => {
    renderInAssistantMessage(fence('bash', 'cd /srv\nnpm ci\nnpm run build'));
    expect(queryRawButton()).toBeNull();
  });
});

describe('زرّ التنفيذ الحر — تفادي المطابقة الجزئية', () => {
  // `includes` النصّية كانت ستطابق هذه كلها. `nassaj-runner` مشروع قائم فعلاً.
  it.each(['bash nassaj-runner', 'bash no-nassaj-run', 'bash nassaj-run2', 'bash NASSAJ-RUN'])(
    'لا زرّ لـ«%s»',
    (info) => {
      renderInAssistantMessage(fence(info));
      expect(queryRawButton()).toBeNull();
    },
  );
});

describe('زرّ التنفيذ الحر — بقيّة شروط البوابة', () => {
  it('لا زرّ حين يرفض الخادم (canUseRaw=false) رغم الوسم', () => {
    mockCanUseRaw.mockReturnValue(false);
    renderInAssistantMessage(fence('bash nassaj-run'));
    expect(queryRawButton()).toBeNull();
  });

  it('لا زرّ خارج رسالة المساعد الرئيسية — نتيجة أداة أو كتلة تفكير', () => {
    // بلا Provider ⇒ افتراضي السياق inlineExecEnabled=false. هذا هو المسار الذي
    // يسلكه محتوى الأدوات (ToolRenderer/MarkdownContent) وكتل التفكير.
    render(<Markdown>{fence('bash nassaj-run')}</Markdown>);
    expect(queryRawButton()).toBeNull();
  });

  it('لا زرّ أثناء البثّ — سطر السياج يصل قبل جسم الأمر', () => {
    renderInAssistantMessage(fence('bash nassaj-run', 'rm -rf /tmp/x'), { streaming: true });
    expect(queryRawButton()).toBeNull();
  });

  it('يظهر الزرّ بعد انتهاء البثّ لنفس المحتوى', () => {
    renderInAssistantMessage(fence('bash nassaj-run', 'rm -rf /tmp/x'), { streaming: false });
    expect(queryRawButton()).not.toBeNull();
  });

  it('لا زرّ حرّ على كتلة nassaj-exec مسمّاة في الكتالوج', () => {
    const ctx: ChatActionsContextValue = {
      ...CTX,
      catalog: [
        {
          actionType: 'safe-restart',
          minRole: 'owner',
          commandPreview: 'bash scripts/safe-restart.sh --exec',
        } as ChatActionsContextValue['catalog'][number],
      ],
    };
    renderInAssistantMessage(fence('nassaj-exec:safe-restart'), { ctx });
    expect(queryRawButton()).toBeNull();
  });

  it('لا زرّ لكود سطري يحمل الوسم', () => {
    renderInAssistantMessage('استعمل `bash nassaj-run` في سطر السياج.');
    expect(queryRawButton()).toBeNull();
  });
});

describe('زرّ التنفيذ الحر — شرحُ الوسم يبقى خامداً', () => {
  it('كتلة تشرح الوسم داخل سياج رباعي لا تحمل زرّاً', () => {
    // درس الفكسچر القائم (adjacent-code-fences): الاستشهاد بكتلة تنفيذية يجب
    // ألّا يُنتج زرّاً. الكتلة الخارجية هنا بلا وسم — الوسم في محتواها لا في
    // سطر سياجها — فالبوابة تقرأ السياج لا النصّ.
    const md = '````\n```bash nassaj-run\nnpm run build:client\n```\n````';
    renderInAssistantMessage(md);
    expect(queryRawButton()).toBeNull();
  });
});


it('keeps an unverified symbolic action non-retryable without reporting success', async () => {
  const runAction = vi.fn().mockResolvedValue({ status: 'error', code: 'outcome_unverified' });
  const ctx: ChatActionsContextValue = { ...CTX, runAction, catalog: [
    { actionType: 'safe-restart', label: 'Restart', commandPreview: null, minRole: 'owner' },
  ] };
  renderInAssistantMessage(fence('nassaj-exec:safe-restart'), { ctx });
  fireEvent.click(screen.getByRole('button', { name: /تنفيذ/ }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('pendingActions.outcomeUnverified'));
  expect(screen.queryByRole('button', { name: /تنفيذ|الإعادة/ })).toBeNull();
  expect(runAction).toHaveBeenCalledTimes(1);
});

it.each(['executing', 'execution_unresolved'] as const)('preserves shared %s lock when the inline block remounts', (status) => {
  const runAction = vi.fn();
  const ctx: ChatActionsContextValue = { ...CTX, runAction, liveStatusOf: () => status, catalog: [
    { actionType: 'safe-restart', label: 'Restart', commandPreview: null, minRole: 'owner' },
  ] };
  const first = renderInAssistantMessage(fence('nassaj-exec:safe-restart'), { ctx });
  expect(screen.queryByRole('button', { name: /تنفيذ|الإعادة/ })).toBeNull();
  first.unmount();
  renderInAssistantMessage(fence('nassaj-exec:safe-restart'), { ctx });
  expect(screen.queryByRole('button', { name: /تنفيذ|الإعادة/ })).toBeNull();
  if (status === 'execution_unresolved') expect(screen.getByRole('status').textContent).toBe('pendingActions.outcomeUnverified');
  expect(runAction).not.toHaveBeenCalled();
});
