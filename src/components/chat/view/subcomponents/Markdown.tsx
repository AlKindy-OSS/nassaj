import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { PluggableList } from 'unified';
import { useTranslation } from 'react-i18next';
// ملاحظة: ورقة `katex/dist/katex.min.css` محمَّلة على مستوى التطبيق في
// `src/main.jsx`، فلا تُستورَد هنا ثانيةً.

import { codeHighlightTheme } from '../../../../syntax/codeHighlightTheme';
import { useCodeHighlighter } from '../../../../syntax/useCodeHighlighter';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import {
  resolveBlockDirection,
  resolveContainerDirection,
  type TextDirection,
} from '../../../../utils/textDirection';
import { useChatActions } from '../../context/ChatActionsContext';
import { deniedCommandMessage } from '../../../command-board/denyRuleSeverity';
import { roleSatisfies } from '../../../../hooks/useServerActionCatalog';
import { useRestartWatch } from '../../../../hooks/useRestartWatch';
import { useAuth } from '../../../auth';
import { useRawExecConfig } from '../../../../hooks/useRawExecConfig';
import { authenticatedFetch } from '../../../../utils/api';
import { ExecReviewDialog, type RawCommand } from '../../../command-board/ExecReviewDialog';
import {
  parseRawInsertResponse,
  nextInsertError,
  isMalfunction,
  type InsertErrorState,
} from '../../../command-board/rawInsertResponse';
import {
  classifyImageSrc,
  parseFenceBody,
  buildAssistantImageUrl,
  resolveAssistantImageError,
} from '../../utils/assistantImageSrc';
import DocumentShareButton from '../../../document-sharing/DocumentShareButton';
import { shareableReference } from '../../../document-sharing/share-contract';

import ChatMessageImage from './ChatMessageImage';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /**
   * الرسالة ما تزال تُبَثّ. يُمرَّر إلى `resolveContainerDirection` لتفعيل
   * حارسَي الاستقرار (إسقاط الكتلة النامية من التصويت + عتبة الحسم).
   */
  streaming?: boolean;
};

type CodeBlockProps = {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
};

/**
 * regex كشف علامة التنفيذ المضمَّن.
 * react-markdown يُخرج className="language-nassaj-exec:<actionType>".
 */
const EXEC_MARKER_RE = /^language-nassaj-exec:([a-z0-9-]{1,64})$/;

type ExecStatus = 'idle' | 'executing' | 'restarting' | 'deferred' | 'success' | 'unverified' | 'failed';

// ── Raw-exec from chat code blocks ─────────────────────────────────────────
/**
 * وسم النيّة الصريح لزرّ التنفيذ الحر (B-429/T-1233).
 *
 * كان الشرط لغةَ الكتلة: أي كتلة `bash|sh|shell|zsh|fish` — **أو بلا لغة
 * إطلاقاً** — تحمل زرّ تنفيذ. لكن اللغة تصف ما هو النصّ لا ما يُراد به: كتلةُ
 * شرحٍ تعرض أمراً للتوضيح لغتها `bash` تماماً كأمرٍ يُقصد تشغيله، فلا تملك
 * الواجهة ما تفرّق به. والشرط «بلا لغة» وسّع ذلك إلى كتل JSON وسجلّات ونصّ خام.
 *
 * الآن النيّة **مكتوبة في الكتلة**: ```` ```bash nassaj-run ````. الوسم يعيش في
 * `meta` — كل ما بعد رمز اللغة في سطر السياج — فلا يمسّ اللغة ولا التلوين ولا
 * محتوى النسخ.
 *
 * لماذا `meta` وحدها ولا تُقبل لغةً (```` ```nassaj-run ````): موضعا استخراج
 * اللغة في هذا الملف يستعملان `/language-(\w+)/`، و`\w` لا يشمل الشرطة، فتصير
 * اللغة `nassaj` صامتةً — تحقّقٌ لا يطابق أبداً وترويسة تعرض «nassaj» وتلوين
 * ساقط. قبولها كان يستلزم تعديل الموضعين معاً؛ صيغة واحدة أرخص وأمنع.
 *
 * **هذا وسم واجهة لا حدّ أمني.** من يملك طبقة `raw` يُدرج أي أمر بطلب HTTP
 * مباشر بلا واجهة أصلاً؛ الحدود الحقيقية هي الطبقة و`rawExecEnabled` وقائمة
 * المنع والبصمة وحوار المراجعة، ولا يمسّها هذا الوسم. الخادم لا يراه ويجب ألّا
 * يراه: تصديقُ وسمٍ يكتبه منتِج النصّ حارسٌ يثق بمن يحرسه منه.
 */
const RUN_TAG = 'nassaj-run';

/**
 * هل تحمل الكتلة وسم التشغيل؟
 *
 * التقطيع بالفراغات مقصود ولازم: ‏`meta` قد تحمل أكثر من رمز (`bash nassaj-run
 * title=x`) وقد تفصلها فراغات متعددة. و`includes` النصّية كانت ستطابق
 * `nassaj-runner` و`no-nassaj-run` — وأولهما اسم مشروع قائم في هذا الريبو.
 */
function hasRunTag(node: unknown): boolean {
  const meta = (node as { data?: { meta?: unknown } } | undefined)?.data?.meta;
  if (typeof meta !== 'string') return false;
  return meta.trim().split(/\s+/).includes(RUN_TAG);
}

/**
 * هل الرسالة ما تزال تُبَثّ؟ يُمرَّر عبر السياق لأن `react-markdown` لا يمرّر
 * props من الجذر إلى مكوّنات الكتل.
 *
 * سببه: ‏remark يفكّ سطر السياج فور اكتماله، أي أن الوسم يصل **قبل** جسم
 * الكتلة. فالزرّ كان يظهر على أمرٍ نصف مكتوب، ونقرةٌ حينها تُدرج بايتات مبتورة
 * ببصمتها — `rm -rf /tmp/x` قبل وصول بقيّته أمرٌ آخر تماماً.
 */
const StreamingContext = React.createContext(false);

const RAW_EXEC_URL = '/api/system/command-board-raw';

/**
 * Translates a server insert-error code to a user-facing message.
 *
 * B-260: every code missing from this map fell through to 'internal', whose text
 * is «Failed to add command to queue» — which describes a malfunction. Two of the
 * codes that landed there are the opposite of a malfunction: they are the
 * denylist and the control-character scanner REFUSING the command on purpose. So
 * a working guard reported itself as a broken feature, and the owner was left
 * without the one thing that would have told them what to do instead.
 *
 * `denied_command` arrives as `denied_command:<rule>` (e.g. denied_command:
 * pm2_lifecycle), so it is matched by prefix and the rule is surfaced. B-1278: the
 * wording follows the rule's severity (denyRuleSeverity), not one claim for all.
 */
function resolveInsertError(
  code: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const base = 'codeBlock.insertError';

  const denied = deniedCommandMessage(t, code, base);
  if (denied !== null) return denied;

  const known = [
    'carriage_return_forbidden',
    'forbidden_control_char',
    'too_many_lines',
    'empty_command',
    'invalid_command',
    'command_too_long',
    'too_many_commands',
    'raw_exec_disabled',
    'config_denied',
  ];
  return t(`${base}.${known.includes(code) ? code : 'internal'}`, { defaultValue: code });
}

// ─── T-1737: مكوّن عرض سياج `image` ──────────────────────────────────────

/**
 * يُصيَّر عند كل كتلة ```` ```image ```` في رسائل المساعد.
 *
 * مسؤوليات:
 * 1. تحليل الجسم (parseFenceBody) → مصدر + caption.
 * 2. تصنيف المصدر (classifyImageSrc) → نوع الجلب.
 * 3. بناء URL الجلب المناسب للنوع.
 * 4. تفويض العرض والـlightbox إلى ChatMessageImage.
 * 5. حالات الخطأ المرئية للأنواع المرفوضة (remote/empty).
 *
 * `sessionId` يصل عبر ChatActionsContext لتجنّب prop-drilling.
 */
const AssistantImageBlock = ({ raw }: { raw: string }) => {
  const { sessionId } = useChatActions();
  const { source, caption } = parseFenceBody(raw);
  const kind = classifyImageSrc(source);

  // basename للـalt الافتراضي (آخر مقطع من المسار أو النصّ كاملاً)
  const defaultAlt = source.split('/').filter(Boolean).pop() ?? source;
  const alt = defaultAlt || 'image';

  // حالة المصدر الفارغ
  if (kind === 'empty') {
    return (
      <InlineImageError message="طلب صورة غير صالح" />
    );
  }

  // الروابط البعيدة معطَّلة في المرحلة الأولى (§4 من التصميم)
  if (kind === 'remote') {
    return (
      <InlineImageError message="الروابط البعيدة معطّلة" />
    );
  }

  // data: يُمرَّر مباشرةً
  if (kind === 'data') {
    return (
      <AssistantImageDisplay src={source} alt={alt} caption={caption} />
    );
  }

  // /api/... يُمرَّر مباشرةً (authenticatedFetch داخل ChatMessageImage)
  if (kind === 'api') {
    return (
      <AssistantImageDisplay src={source} alt={alt} caption={caption} />
    );
  }

  // مسار مطلق محلي — يحتاج sessionId لبناء URL نقطة النهاية
  // kind === 'path'
  if (!sessionId) {
    return (
      <InlineImageError message={resolveAssistantImageError(400)} />
    );
  }
  const apiUrl = buildAssistantImageUrl(source, sessionId);
  return (
    <AssistantImageDisplay src={apiUrl} alt={alt} caption={caption} />
  );
};

/** غلاف بسيط يجمع ChatMessageImage مع caption اختياري. */
const AssistantImageDisplay = ({
  src,
  alt,
  caption,
}: {
  src: string;
  alt: string;
  caption: string;
}) => (
  <figure className="my-2">
    <ChatMessageImage
      src={src}
      alt={alt}
      showLoadError={true}
      loadErrorMessageFor={resolveAssistantImageError}
      objectFit="contain"
    />
    {caption && (
      <figcaption className="mt-1 text-center text-xs text-muted-foreground">
        {caption}
      </figcaption>
    )}
  </figure>
);

/** رسالة خطأ مرئية صغيرة لحالات الرفض قبل أي جلب. */
const InlineImageError = ({ message }: { message: string }) => (
  <div
    role="img"
    aria-label={message}
    className="my-1 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
  >
    <svg
      className="h-4 w-4 flex-shrink-0"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
        clipRule="evenodd"
      />
    </svg>
    <span>{message}</span>
  </div>
);

const CodeBlock = ({ node, inline, className, children, ...props }: CodeBlockProps) => {
  const { t: tChat } = useTranslation('chat');
  const { t: tSidebar } = useTranslation('sidebar');

  // ─── الـhooks تُستدعى دائماً قبل أي return مبكر (قاعدة React) ───────────
  // المُلوِّن: مكوِّن ثابت المرجع، ونطاق لغاته تفضيلُ مستخدم. اللغة خارج النطاق
  // تُعرَض نصّاً سليماً بنفس الإطار (تفصيل السقوط في src/syntax/prismRegistry).
  const { SyntaxHighlighter } = useCodeHighlighter();
  const { catalog, runAction, userRole, inlineExecEnabled, liveStatusOf } = useChatActions();
  const { isRestarting, isSuccess, startPolling } = useRestartWatch();
  const [copied, setCopied] = useState(false);
  const [execStatus, setExecStatus] = useState<ExecStatus>('idle');
  const [execDetail, setExecDetail] = useState('');

  // ── Raw-exec hooks (زرّ التنفيذ من المحادثة) ───────────────────────────
  // كل الـhooks قبل أي return مبكر — قاعدة React.
  const { user } = useAuth();
  // لا نفحص الدور هنا: منذ ADR-072 (تعديل 2026-07-26) أي دور قد يملك طبقة raw،
  // وفحص «owner» عميلياً كان يُخفي الزرّ عن أدمن يقبله الخادم فعلاً. القرار كله
  // من الخادم عبر useRawExecConfig (نفس مدخلات دالّة القرار).
  // cache على مستوى الوحدة: استدعاء شبكة واحد لكل الكتل بـTTL 30 ثانية.
  const { canUseRaw } = useRawExecConfig(!!user);
  const isStreaming = useContext(StreamingContext);
  const [rawExecTarget, setRawExecTarget] = useState<RawCommand | null>(null);
  const [isInserting, setIsInserting] = useState(false);
  /**
   * B-261 — the refusal is an ATTEMPT RECORD, not a system state.
   *
   * It used to be a bare string, so three clicks in eighty seconds re-set the
   * same text to the same value: zero visible change, indistinguishable from a
   * frozen screen. The owner then fixed the problem in their own terminal and
   * read the still-standing red line as «my fix did not work» — the message was
   * describing a click from a minute earlier and had no way to say so.
   *
   * `at` and `attempt` are what make the second click visible; `code` is what
   * lets a deliberate refusal be styled differently from an actual malfunction.
   */
  const [insertError, setInsertError] = useState<InsertErrorState | null>(null);

  const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(raw);
  const inlineDetected = inline || (node && node.type === 'inlineCode');
  const shouldInline = inlineDetected || !looksMultiline;

  // T-1737 — فرع سياج `image`. يجب أن يُفحَص هنا، قبل shouldInline:
  // جسم فارغ يجعل looksMultiline=false ← shouldInline=true ← يُعرَض
  // كـ<code> سطري لو أجّلنا الفحص. السياف `image` مقصود دائماً كتلةً.
  // `!inlineDetected` يضمن ألا نعترض الكود السطري المكتوب صراحةً بـ
  // backtick واحد.
  const isImageFence = !inlineDetected && /language-image/.test(className ?? '');

  // ── كشف وسم النيّة (```bash nassaj-run) ──────────────────────────────
  // اللغة لم تعد معياراً: الوسم وحده يقول «هذه الكتلة مقصودة للتشغيل».
  const isRunTagged = !shouldInline && hasRunTag(node);

  // Editing the block is the one event that can change the verdict, since every
  // refusal here is a judgement on these exact bytes. Note that it does NOT fire
  // on a repeat click of unchanged text — that case is the attempt counter's.
  useEffect(() => {
    setInsertError(null);
  }, [raw]);

  /**
   * Records an attempt that failed, incrementing the counter when the previous
   * line said the same thing. Same code + same bytes ⇒ the owner learns nothing
   * from the text, so the count is the only honest signal that the click landed.
   */
  const noteInsertFailure = useCallback((code: string, message: string) => {
    setInsertError(prev => nextInsertError(prev, code, message, Date.now()));
  }, []);

  // ── معالج إدراج الأمر في الطابور ثم فتح حوار المراجعة ─────────────────
  const handleRawExec = useCallback(async () => {
    const cmd = raw.trim();
    if (!cmd || isInserting) return;
    setIsInserting(true);
    // NOT cleared here: a refusal that is about to repeat identically would blink
    // out and back with nothing changed. The attempt counter below carries the
    // difference instead, and a successful insert clears it on its own.
    try {
      const res = await (
        authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
      )(RAW_EXEC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      // B-257: الصفّ يعود مُعشَّشاً تحت `command` لا مسطَّحاً. قراءته مسطَّحة كانت
      // تُسقِط الحارس فيُبلَّغ المالك بالفشل بينما الأمر أُدرج فعلاً (201 وسجل
      // تدقيق وشارة) — والحوار لا يُفتح. عقد الشكل صار في parseRawInsertResponse.
      const outcome = parseRawInsertResponse(res.ok, await res.json().catch(() => ({})));
      if (!outcome.ok) {
        noteInsertFailure(
          outcome.code,
          resolveInsertError(
            outcome.code,
            tChat as (key: string, opts?: Record<string, unknown>) => string,
          ),
        );
        return;
      }
      // الإدراج نجح → افتح حوار المراجعة فوراً
      setInsertError(null);
      setRawExecTarget(outcome.row);
    } catch {
      noteInsertFailure(
        'internal',
        tChat('codeBlock.insertError.internal', {
          defaultValue: 'Failed to add command to queue',
        }) as string,
      );
    } finally {
      setIsInserting(false);
    }
  }, [raw, isInserting, tChat, noteInsertFailure]);

  // ─── كشف علامة nassaj-exec ───────────────────────────────────────────────
  const markerMatch = EXEC_MARKER_RE.exec(className || '');
  const execActionType = markerMatch?.[1] ?? null;

  // الحاجز الأمني: لا زر إلا إذا كان الـactionType في الـcatalog
  const catalogEntry = execActionType
    ? (catalog.find((a) => a.actionType === execActionType) ?? null)
    : null;

  const isExecBlock = inlineExecEnabled && catalogEntry !== null;
  const roleOk = isExecBlock && roleSatisfies(userRole, catalogEntry!.minRole);

  // ── شرط إظهار زرّ التنفيذ الحر ────────────────────────────────────────
  //
  // أربعة شروط، كلٌّ منها يغلق باباً مختلفاً:
  //   • canUseRaw         — قرار الخادم نفسه (طبقة raw + تسليح + لا مانع بيئي).
  //   • inlineExecEnabled — رسالة مساعد رئيسية حصراً. غيابه هو ما كان يجعل
  //     الزرّ يظهر على **نتائج الأدوات وكتل التفكير**، أي أن محتوى ملف مقروء
  //     أو صفحة مجلوبة كان يكفيه سياج ```bash ليعرض زرّ تنفيذ. الشرط قائم
  //     ومحترَم في كتل `nassaj-exec` منذ T-947 F3، وسقط عن هذا المسار وحده.
  //   • isRunTagged       — النيّة مكتوبة لا مُستنتَجة من اللغة.
  //   • !isStreaming      — لا نقرة على أمرٍ لم يكتمل بعد.
  const showRawExecButton =
    canUseRaw && inlineExecEnabled && isRunTagged && !isExecBlock && !isStreaming;

  // الحالة المشتركة من الطابور (T-947 F4): يربط الزر بلوحة الأوامر — تنفيذ
  // الأمر نفسه من النافذة (أو تبويب آخر) يجعل صفّه 'executing' فينعكس هنا لحظيّاً.
  const sharedStatus = execActionType ? liveStatusOf(execActionType) : null;

  // Durable locks take precedence even over a previous local failure or success.
  const effectiveStatus: ExecStatus = sharedStatus === 'execution_unresolved' || isSuccess
    ? 'unverified'
    : sharedStatus === 'executing'
      ? 'executing'
      : isRestarting
        ? 'restarting'
        : execStatus;

  const isInFlight = effectiveStatus === 'executing' || effectiveStatus === 'restarting';

  // ─── معالج التنفيذ ────────────────────────────────────────────────────────
  const handleExec = useCallback(async () => {
    if (!execActionType || isInFlight || effectiveStatus === 'unverified') return;
    setExecStatus('executing');
    setExecDetail('');

    const outcome = await runAction(execActionType);

    if (outcome.status === 'restarting') {
      setExecStatus('idle'); // useRestartWatch يتولّى المرحلة
      startPolling();
    } else if (outcome.status === 'success') {
      setExecStatus('success');
    } else if (outcome.status === 'deferred') {
      setExecStatus('deferred');
      setExecDetail(outcome.detail ?? outcome.reason ?? '');
    } else {
      // status === 'error'
      setExecStatus(['outcome_unverified', 'execution_unresolved'].includes(outcome.code) ? 'unverified' : 'failed');
      setExecDetail(outcome.code ?? 'internal');
    }
  }, [execActionType, isInFlight, effectiveStatus, runAction, startPolling]);

  // الكود السطري لا زرّ له — يُعرَض بعد استدعاء كل الـhooks (قاعدة React)
  //
  // `dir="ltr"` مقصود ولازم: الشيفرة LTR دوماً، والسِمة نفسها تُفعِّل
  // `unicode-bidi: isolate` من ورقة أنماط المتصفح — فيصبح المعرّف اللاتيني
  // جزيرة معزولة داخل الفقرة العربية بدل أن يجرّ المحايدات حوله (الأقواس
  // والنقاط والأرقام) إلى مواضع خاطئة. العزل هنا لا يعتمد على اتجاه الجذر.
  // T-1737 — عرض سياج `image` (قبل shouldInline لمعالجة الجسم الفارغ).
  // لا نعرض أثناء البثّ: المسار قد لم يكتمل بعد (ت-2 من التقرير).
  if (isImageFence && !isStreaming) {
    return <AssistantImageBlock raw={raw} />;
  }

  if (shouldInline) {
    return (
      <code
        dir="ltr"
        className={`whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground ${className || ''}`}
        {...props}
      >
        {children}
      </code>
    );
  }

  // ─── عرض اللغة في العنوان ────────────────────────────────────────────────
  const matchLang = /language-(\w+)/.exec(className || '');
  const displayLang = isExecBlock
    ? execActionType!          // e.g. "safe-restart"
    : matchLang
      ? matchLang[1]
      : 'text';

  // ما يُعرَض داخل SyntaxHighlighter: commandPreview للكتل التنفيذية، raw لغيرها
  const syntaxContent = isExecBlock
    ? (catalogEntry!.commandPreview ?? raw)
    : raw;

  const highlightLang = isExecBlock ? 'bash' : displayLang;

  /*
   * B-274 — إزاحات فيزيائية داخل جزيرة LTR، لا منطقية. الكود دائماً LTR ولذلك
   * الغلاف يثبّت dir="ltr"، لكن ذلك وحده لا يكفي:
   *
   * إضافة tailwindcss-rtl تُصدِر لكل أداة منطقية قاعدتين بمُحدِّد سليل:
   *     [dir=rtl] .end-2 { left: .5rem }
   *     [dir=ltr] .end-2 { right: .5rem }
   * والرسالة العربية تحمل dir="rtl" فوق هذا الغلاف. فالسلف موجود مهما بَعُد،
   * والقاعدتان تنطبقان معاً. وليستا متنازعتين تحسمهما الأسبقية: كلٌّ تضبط
   * **خاصية مختلفة**، فتثبتان معاً → left:8px مع right:8px. عنصر مطلق بجانبين
   * مضبوطين وعرض auto يتمدّد على العرض كلّه، فيقع محتواه عند بداية السطر — أي
   * يساراً. قيس هذا في المتصفح: left=8px وright=8px وx=8 داخل غلاف عرضه 1280.
   *
   * لذلك right-2 وleft-3: الغلاف يثبّت LTR فالفيزيائي هنا هو التعبير الصادق عن
   * «نهاية الكتلة»، وهو منيع لأن الإضافة لا تُولّد بدائل اتجاهية للفيزيائي.
   *
   * وحده. القاعدة تفترض عنصراً يتبع اتجاه الصفحة، وهذه جزيرة LTR مثبَّتة بالقوة
   * لأن الصدفة والشيفرة لا تنعكس. المنطقيّ هنا لا يعطي «حسب الاتجاه» بل يعطي
   * الجانبين معاً (مقيس أعلاه)، فيتمدّد الشريط ويهبط يساراً. أي عنصر يتبع اتجاه
   * الصفحة في هذا الملف يبقى على ms-/me-/start-/end- كما هو.
   */
  return (
    <div className="group relative my-2" dir="ltr">
      {/* عنوان اللغة — يسار أعلى (ثابت في سياق LTR) */}
      {displayLang && displayLang !== 'text' && (
        <div
          className="absolute left-3 top-2 z-10 text-xs font-medium text-muted-foreground"
          dir="ltr"
        >
          {displayLang}
        </div>
      )}

      {/*
        شريط الأدوات — يمين أسفل (ثابت في سياق LTR).
        على الجوال (شاشات اللمس < sm) يظهر دائماً لأن hover لا يعمل؛
        على سطح المكتب (sm+) يظهر عند التمرير أو التركيز فقط.
        design-ok: هذه جزيرة LTR صريحة؛ البدائل المنطقية تتلقى قاعدتي اتجاه
        الأسلاف معاً، لذلك يحتاج الشريط واللصيقة الإزاحتين الفيزيائيتين (B-274).
      */}
      <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:focus-within:opacity-100 sm:group-hover:opacity-100">
        {/* زر التنفيذ (كتل exec فقط) */}
        {isExecBlock && (
          <>
            {effectiveStatus === 'idle' && (
              <button
                type="button"
                onClick={() => void handleExec()}
                disabled={!roleOk}
                title={
                  roleOk
                    ? tSidebar('pendingActions.inlineExecute', { defaultValue: 'تنفيذ' })
                    : tSidebar('pendingActions.inlineRequiresOwner', {
                        defaultValue: 'يتطلب صلاحية owner',
                      })
                }
                aria-label={
                  roleOk
                    ? tSidebar('pendingActions.inlineExecute', { defaultValue: 'تنفيذ' })
                    : tSidebar('pendingActions.inlineRequiresOwner', {
                        defaultValue: 'يتطلب صلاحية owner',
                      })
                }
                aria-disabled={!roleOk}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                  roleOk
                    ? 'border-amber-500 bg-amber-600/90 text-white hover:bg-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-400'
                    : 'cursor-not-allowed border-gray-600 bg-gray-700/50 text-muted-foreground opacity-60'
                }`}
              >
                {/* Play icon */}
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
                    clipRule="evenodd"
                  />
                </svg>
                {tSidebar('pendingActions.inlineExecute', { defaultValue: 'تنفيذ' })}
              </button>
            )}

            {effectiveStatus === 'executing' && (
              <span className="flex items-center gap-1 rounded-md border border-blue-500/50 bg-blue-600/20 px-2 py-1 text-xs text-blue-300">
                {/* Spinner */}
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {tSidebar('pendingActions.statusExecuting', { defaultValue: 'جارٍ التنفيذ…' })}
              </span>
            )}

            {effectiveStatus === 'restarting' && (
              <span className="flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-600/20 px-2 py-1 text-xs text-amber-300">
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {tSidebar('pendingActions.restarting', { defaultValue: 'جارٍ إعادة التشغيل…' })}
              </span>
            )}

            {effectiveStatus === 'success' && (
              <span className="flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-600/20 px-2 py-1 text-xs text-emerald-300">
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                {tSidebar('pendingActions.restartSuccess', { defaultValue: 'تمّ' })}
              </span>
            )}

            {effectiveStatus === 'deferred' && (
              <span
                className="max-w-56 truncate rounded-md border border-blue-500/50 bg-blue-600/20 px-2 py-1 text-xs text-blue-300"
                title={execDetail}
              >
                {tSidebar('pendingActions.deferredLiveWork', { defaultValue: 'مؤجَّل' })}
              </span>
            )}

            {effectiveStatus === 'unverified' && (
              <span role="status" className="rounded-md border border-amber-500/50 bg-amber-600/20 px-2 py-1 text-xs text-amber-300">
                {tSidebar('pendingActions.outcomeUnverified')}
              </span>
            )}

            {effectiveStatus === 'failed' && (
              <button
                type="button"
                onClick={() => { setExecStatus('idle'); setExecDetail(''); }}
                className="flex items-center gap-1 rounded-md border border-red-500/50 bg-red-600/20 px-2 py-1 text-xs text-red-300 hover:bg-red-600/30"
                title={execDetail}
                aria-label={tSidebar('pendingActions.errorGeneric', { defaultValue: 'فشل التنفيذ — انقر للإعادة' })}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                {tSidebar('pendingActions.errorGeneric', { defaultValue: 'خطأ' })}
              </button>
            )}
          </>
        )}

        {/* ── زرّ التنفيذ الحر (كتل shell للمالك فقط) ───────────────────── */}
        {showRawExecButton && (
          <button
            type="button"
            onClick={() => { void handleRawExec(); }}
            disabled={isInserting}
            title={tChat('codeBlock.executeRawTitle', {
              defaultValue: 'Execute this command on the Nassaj server (opens review dialog)',
            }) as string}
            aria-label={tChat('codeBlock.executeRawTitle', {
              defaultValue: 'Execute this command on the Nassaj server (opens review dialog)',
            }) as string}
            className="flex items-center gap-1 rounded-md border border-amber-600/70 bg-amber-700/80 px-2 py-1 text-xs text-white transition-colors hover:bg-amber-700 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:cursor-wait disabled:opacity-60"
          >
            {isInserting ? (
              <>
                {/* spinner */}
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {tChat('codeBlock.inserting', { defaultValue: 'Adding to queue…' })}
              </>
            ) : (
              <>
                {/* terminal icon */}
                <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.293 1.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L7.586 10 5.293 7.707a1 1 0 010-1.414zM11 12a1 1 0 100 2h3a1 1 0 100-2h-3z" clipRule="evenodd" />
                </svg>
                {tChat('codeBlock.executeRaw', { defaultValue: 'Execute' })}
              </>
            )}
          </button>
        )}

        {/* زر النسخ */}
        <button
          type="button"
          onClick={() =>
            copyTextToClipboard(raw).then((success) => {
              if (success) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })
          }
          className="rounded-md border border-gray-600 bg-gray-700/80 px-2 py-1 text-xs text-white transition-colors hover:bg-gray-700 focus:outline-none focus:ring-1 focus:ring-gray-500"
          title={copied ? tChat('codeBlock.copied') : tChat('codeBlock.copyCode')}
          aria-label={copied ? tChat('codeBlock.copied') : tChat('codeBlock.copyCode')}
        >
          {copied ? (
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              {tChat('codeBlock.copied')}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
              </svg>
              {tChat('codeBlock.copy')}
            </span>
          )}
        </button>
      </div>

      <SyntaxHighlighter
        language={highlightLang}
        style={codeHighlightTheme}
        customStyle={{
          margin: 0,
          borderRadius: '0.5rem',
          fontSize: '0.875rem',
          /*
           * padding-bottom = 2.5rem لضمان أن الشريط (bottom-2 ≈ 0.5rem + ارتفاع الزر ≈ 1.75rem)
           * لا يغطي السطر الأخير مهما كان عدد الأسطر (سطر واحد أو 100 سطر).
           * padding-top = 2rem عند وجود تسمية اللغة أعلى اليسار.
           */
          padding:
            (displayLang && displayLang !== 'text') || isExecBlock
              ? '2rem 1rem 2.5rem 1rem'
              : '1rem 1rem 2.5rem 1rem',
        }}
        codeTagProps={{
          style: {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          },
        }}
      >
        {syntaxContent}
      </SyntaxHighlighter>

      {/* ── نتيجة محاولة الإدراج (تحت الكتلة) ────────────────────────────
          B-261: أحمر و role=alert للعطل وحده. الرفض المتعمَّد كهرماني وrole=status
          لأنه حارسٌ يعمل لا ميزةٌ معطوبة، ويحمل وقته وعدد محاولاته وزرّ إغلاق —
          فلا يُقرأ حالةً جاريةً للنظام بعد أن يُعالج المالك الأمر من مكان آخر. */}
      {showRawExecButton && insertError && (
        <div
          role={isMalfunction(insertError.code) ? 'alert' : 'status'}
          className={`mt-1 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            isMalfunction(insertError.code)
              ? 'border-red-800/60 bg-red-950/30 text-red-400'
              : 'border-amber-800/60 bg-amber-950/25 text-amber-300'
          }`}
          dir="auto"
        >
          <svg className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div className="min-w-0 flex-1">
            <p>{insertError.message}</p>
            {/* Dates the line to its own click, and counts repeats — the two
                facts whose absence let a past attempt read as a live state. */}
            <p className="mt-0.5 opacity-70">
              {insertError.attempt > 1
                ? tChat('codeBlock.insertError.stampRepeat', {
                    time: new Date(insertError.at).toLocaleTimeString(),
                    count: insertError.attempt,
                    defaultValue: `Attempt ${insertError.attempt} at ${new Date(insertError.at).toLocaleTimeString()} — same result`,
                  })
                : tChat('codeBlock.insertError.stamp', {
                    time: new Date(insertError.at).toLocaleTimeString(),
                    defaultValue: `From your click at ${new Date(insertError.at).toLocaleTimeString()} — not a live status`,
                  })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setInsertError(null)}
            aria-label={tChat('codeBlock.insertError.dismiss', { defaultValue: 'Dismiss' })}
            className="-me-0.5 flex-shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:bg-card/10 hover:opacity-100"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/*
        حوار المراجعة (portal — يُعرَض خارج شجرة الـDOM).
        onComplete لا يُغلق الحوار — يبقى مفتوحاً ليُظهر نتيجة التنفيذ؛
        المستخدم يُغلقه بنفسه (onClose). في تبويب الإعدادات يُعيد
        onComplete تحميل الطابور — هنا لا طابور فيكفي بقاء الحوار.
      */}
      {showRawExecButton && (
        <ExecReviewDialog
          target={rawExecTarget}
          onClose={() => setRawExecTarget(null)}
          onComplete={() => {}}
        />
      )}
    </div>
  );
};

/**
 * اتجاه الحاوية، يُمرَّر للكتل عبر السياق.
 *
 * `null` ⇒ لا اتجاه محسوم للرسالة، فالكتل ترث المستند ولا تحمل `dir` إطلاقاً.
 */
const ContainerDirContext = React.createContext<TextDirection | null>(null);

/** نصّ الكتلة من شجرة hast، مع استبعاد الشيفرة — لاتينية بحكم البناء لا اللغة. */
function hastText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return String(node.value ?? '');
  if (node.type === 'element' && ['code', 'pre', 'kbd', 'samp'].includes(node.tagName)) {
    return ' ';
  }
  const children = node.children;
  return Array.isArray(children) ? children.map(hastText).join('') : '';
}

/**
 * سِمة `dir` للكتلة — أو `undefined` فترث الحاوية.
 *
 * الكتلة لا تخالف الحاوية إلا إذا كانت أحادية اللغة فعلاً (صفر حروف قوية باتجاه
 * الحاوية). التفصيل والمبرّر في `src/utils/textDirection.ts`.
 */
function useBlockDir(node: any): TextDirection | undefined {
  const containerDir = useContext(ContainerDirContext);
  return useMemo(() => resolveBlockDirection(hastText(node), containerDir), [node, containerDir]);
}

type BlockProps = {
  node?: any;
  children?: React.ReactNode;
  /**
   * محاذاة عمود الجدول القادمة من GFM (`|:---|---:|`). `mdast-util-to-hast`
   * يضعها في `properties.align`، و`react-markdown` v10 يحوّلها إلى
   * `style={{ textAlign }}` قبل أن تصل إلى المكوّن. المصنع كان يُهملها صامتاً.
   */
  style?: React.CSSProperties;
};

/**
 * مصنع مكوّنات الكتل: كلها تمرّ بنفس قاعدة الاتجاه، فلا يشذّ عنصر عن غيره.
 *
 * ملاحظة تاريخية: كانت هذه الكتل تحمل `dir="auto"` — خوارزمية «أول حرف قوي» —
 * فأي فقرة عربية تبدأ بمعرّف لاتيني تُحسب LTR فينقلب ترتيب مقاطعها وتقفز علامة
 * الترقيم للجهة الخاطئة. المشكلة كانت في «أول حرف قوي» لا في «لكل كتلة»: هنا
 * الاتجاه لكل كتلة بالأغلبية، والحاوية بتصويت الكتل.
 */
function blockComponent(tag: string, className?: string) {
  const Block = ({ node, children, style }: BlockProps) => {
    const dir = useBlockDir(node);
    // `style` هنا مصدرها الوحيد محاذاة أعمدة GFM. المحاذاة اختيار صريح لكاتب
    // الماركداون على العمود، ففيزيائيتها مقصودة ومطابقة لما يفعله GitHub:
    // `---:` تعني «يمين» في الاتجاهين. الاتجاه وحده منطقي هنا، و`text-start`
    // في الصنف يبقى الافتراضي حين لا محاذاة معلنة.
    return React.createElement(tag, { className, dir, style }, children);
  };
  Block.displayName = `MarkdownBlock_${tag}`;
  return Block;
}

/**
 * عنصر القائمة — الاستثناء الوحيد من `blockComponent`.
 *
 * `dir` على `<li>` نفسه يقلب موضع **العلامة** (النقطة/الرقم) لا النصّ وحده،
 * فيهبط ترقيم عنصرٍ واحد في الحافة المقابلة لقائمته. مقيس: 7 رسائل (1.9%)
 * و10 عناصر في 360 رسالة حقيقية. العلاج: العلامة تتبع `<ol>/<ul>` دائماً،
 * والاتجاه المخالف يُوضَع على غلاف داخلي يحيط النصّ وحده.
 *
 * الغلاف لا يُضاف إلا عند وجود اتجاه مخالف فعلاً — والمسار الشائع (كتلة موافقة
 * للحاوية) يبقى `<li>` عارياً كما كان.
 */
const ListItem = ({ node, children }: BlockProps) => {
  const dir = useBlockDir(node);
  if (!dir) return <li>{children}</li>;
  return (
    <li>
      <span dir={dir}>{children}</span>
    </li>
  );
};
ListItem.displayName = 'MarkdownBlock_li';

/** A file reference requests a user action; rendering never creates a public link. */
function ProjectFileLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const { inlineExecEnabled, shareProjectId, onShareFileOpen } = useChatActions();
  const streaming = useContext(StreamingContext);
  const relativePath = shareableReference(href);
  if (inlineExecEnabled && !streaming && shareProjectId && relativePath) {
    return <span className="not-prose inline-flex max-w-full flex-wrap items-center gap-2 align-middle">
      {onShareFileOpen ? <button type="button" className="min-h-11 break-all text-primary underline focus-visible:outline focus-visible:outline-ring"
        onClick={() => onShareFileOpen(relativePath)}>{children}</button> : <span className="break-all"><bdi>{children}</bdi></span>}
      <DocumentShareButton key={`${shareProjectId}:${relativePath}`} projectId={shareProjectId} filePath={relativePath} showLabel />
    </span>;
  }
  return <a href={href} className="text-blue-600 hover:underline dark:text-blue-400" target="_blank" rel="noopener noreferrer">{children}</a>;
}

const markdownComponents = {
  code: CodeBlock,
  h1: blockComponent('h1', 'mb-3 mt-4 text-2xl font-bold'),
  h2: blockComponent('h2', 'mb-2 mt-3 text-xl font-bold'),
  h3: blockComponent('h3', 'mb-2 mt-3 text-lg font-semibold'),
  h4: blockComponent('h4', 'mb-1 mt-2 text-base font-semibold'),
  li: ListItem,
  blockquote: blockComponent(
    'blockquote',
    'my-2 border-s-4 border-border ps-4 italic text-muted-foreground'
  ),
  // فقرة الماركداون تُصيَّر <div> لا <p>: قد تحوي كتل شيفرة، و<pre> داخل <p> HTML غير صالح.
  p: blockComponent('div', 'mb-2 last:mb-0'),
  th: blockComponent(
    'th',
    'border border-border px-3 py-2 text-start text-sm font-semibold'
  ),
  td: blockComponent(
    'td',
    'border border-border px-3 py-2 align-top text-sm'
  ),
  a: ProjectFileLink,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-border">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-muted">{children}</thead>
  ),
};

/**
 * إعدادات `remark-math`: رياضيات الدولار المفرد مُطفأة.
 *
 * `$…$` علامةً للرياضيات تبتلع المبالغ في النثر العربي والإنجليزي على السواء:
 * «التكلفة $5 ثم $10 شهرياً» كانت تُرسَم «التكلفة 5ثم5 ثم 5ثم10 شهرياً» — النصّ
 * بين الدولارين يصير صيغةً وتُحذف العلامتان. `$$…$$` (الرياضيات الكتلية) تبقى
 * عاملة: هي معلَنة صراحةً ولا تتصادم مع كتابة المبالغ.
 */
const REMARK_MATH_OPTIONS = { singleDollarTextMath: false };

export function Markdown({ children, className, streaming = false }: MarkdownProps) {
  const content = normalizeInlineCodeFences(String(children ?? ''));
  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkGfm, [remarkMath, REMARK_MATH_OPTIONS]],
    []
  );
  const rehypePlugins = useMemo(() => [rehypeKatex], []);

  // اتجاه الحاوية بتصويت الكتل (كتلة = صوت)، لا بأغلبية حروف الرسالة: عدّ
  // الحروف منحاز بنيوياً للاتينية، ففقرة إنجليزية واحدة كانت تقلب الرسالة كلها.
  // `null` ⇒ لا سِمة `dir` أصلاً فترث الرسالة اتجاه المستند.
  //
  // `streaming` يُفعِّل حارسَي الاستقرار أثناء البثّ (تفصيلهما في utils/textDirection):
  // بدونهما كانت 14.4% من الرسائل العربية الحقيقية تنقلب حاويتها وسط القراءة.
  const containerDir = useMemo(
    () => resolveContainerDirection(content, { streaming }),
    [content, streaming]
  );

  return (
    <div className={`nassaj-md ${className ?? ''}`} dir={containerDir ?? undefined}>
      <ContainerDirContext.Provider value={containerDir}>
        {/* البثّ يصل الكتل عبر السياق لا عبر props: `react-markdown` لا يمرّر
            شيئاً من الجذر إلى مكوّنات الكتل. */}
        <StreamingContext.Provider value={streaming}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={markdownComponents as any}
          >
            {content}
          </ReactMarkdown>
        </StreamingContext.Provider>
      </ContainerDirContext.Provider>
    </div>
  );
}
