import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, GitFork, Loader2, MessageCircleQuestion, MessageSquarePlus, X } from 'lucide-react';

import { Dialog, DialogContent } from '../../../../shared/view/ui';
import type { BtwForkMode, BtwState } from '../../hooks/useBtwSideChannel';

/**
 * T-849 — overlay القناة الجانبية «/btw».
 *
 * يعرض سؤال «/btw» + إجابته المتدفّقة (تراكم btw-chunk) + مؤشّر حالة
 * (جارٍ/متدفّق/مكتمل/خطأ) + زرّ إغلاق، مع تلميحَي C4 (يستهلك من حصة Claude)
 * وC5 (الإجابة على سياق الجلسة حتى آخر رسالة محفوظة). عرضٌ صرف بلا حالة داخلية:
 * كل المنطق في useBtwSideChannel. يتّكئ على Dialog المشترك للحصول على فخّ
 * التركيز وإغلاق Esc/النقر خارجاً واستعادة التركيز والطبقة العلوية.
 *
 * T-1090 — زرّ «فرك» في التذييل (واختصار «f» كما في الـCLI): يظهر فقط على إجابة
 * مكتملة غير فارغة، ويحوّل السؤال الجانبي إلى محادثة حقيقية يُتابع فيها الحوار.
 * خطأ الفرك يُعرض في صندوقه المستقلّ لأن الإجابة المعروضة تبقى سليمة.
 *
 * RTL: يتّبع اتجاه المستند (عربي = rtl) عبر الخصائص المنطقية فقط (لا left/right
 * صريحة)، فيسلم في العربية وفي اللغات LTR معاً.
 */

/** خريطة أكواد خطأ القناة → مفاتيح i18n (namespace: chat). */
const BTW_ERROR_CODE_KEYS: Record<string, string> = {
  unsupported_provider: 'btw.errors.unsupported_provider',
  session_not_found: 'btw.errors.session_not_found',
  not_visible: 'btw.errors.not_visible',
  busy: 'btw.errors.busy',
  sdk_error: 'btw.errors.sdk_error',
  timeout: 'btw.errors.timeout',
  disconnected: 'btw.errors.disconnected',
};

/** T-1090 — أكواد خطأ الفرك → مفاتيح i18n. أكوادٌ أخرى تسقط إلى النص العام. */
const BTW_FORK_ERROR_CODE_KEYS: Record<string, string> = {
  busy: 'btw.fork.errors.busy',
  session_not_found: 'btw.fork.errors.session_not_found',
  not_writable: 'btw.fork.errors.not_writable',
  unsupported_provider: 'btw.fork.errors.unsupported_provider',
  invalid_request: 'btw.fork.errors.invalid_request',
  transcript_not_found: 'btw.fork.errors.transcript_not_found',
  source_empty: 'btw.fork.errors.source_empty',
  source_too_large: 'btw.fork.errors.source_too_large',
  message_not_found: 'btw.fork.errors.message_not_found',
  fork_failed: 'btw.fork.errors.fork_failed',
  timeout: 'btw.fork.errors.timeout',
  disconnected: 'btw.fork.errors.disconnected',
};

/**
 * سقف طول رسالة الخادم المعروضة لـ`sdk_error`: رسالة SDK طويلة قد تكسر تخطيط
 * الـoverlay، فتُقتطع بلطف (مع «…») مع إبقاء المربّع قابلاً للتمرير عبر break-words.
 */
const BTW_SERVER_ERROR_MAX_LEN = 300;

/**
 * T-1091 — الوضعان المعروضان في التذييل. الترتيب مقصود: «الكامل» أولاً لأنه
 * سلوك الـCLI ولأنه الخيار الآمن حين يعتمد السؤال على سياق المحادثة، و«الجديدة»
 * تحته لسؤال قائم بذاته لا يستحق سحب المحادثة كلها.
 */
const FORK_ACTIONS: ReadonlyArray<{
  mode: BtwForkMode;
  Icon: typeof GitFork;
  labelKey: string;
  hintKey: string;
}> = [
  { mode: 'full', Icon: GitFork, labelKey: 'btw.fork.actionFull', hintKey: 'btw.fork.hintFull' },
  {
    mode: 'fresh',
    Icon: MessageSquarePlus,
    labelKey: 'btw.fork.actionFresh',
    hintKey: 'btw.fork.hintFresh',
  },
];

interface BtwOverlayProps {
  state: BtwState | null;
  onClose: () => void;
  /**
   * T-1090/T-1091: يفرع السؤال المكتمل إلى محادثة حقيقية بالشكل المطلوب —
   * 'full' يسحب المحادثة كاملة، و'fresh' يبدأ محادثة بالسؤال وإجابته وحدهما.
   * غيابه يُخفي الزرّين تماماً (لا زرّ معطّل بلا سبب مفهوم).
   */
  onFork?: (mode: BtwForkMode) => void;
}

const TITLE_ID = 'btw-overlay-title';

export default function BtwOverlay({ state, onClose, onFork }: BtwOverlayProps) {
  const { t } = useTranslation('chat');

  // رسالة الخطأ:
  //  - الأكواد ذات المعنى للمستخدم (unsupported_provider/session_not_found/
  //    not_visible/busy/timeout/disconnected): نصّها المخرَّط دائماً.
  //  - sdk_error (الغلاف العام لأعطال الخادم الحقيقية): رسالة الخادم الفعلية
  //    حين تتوفّر — مقتطعةً بسقف طول كي لا تكسر التخطيط — والنصّ العام احتياطاً.
  const errorText = useMemo(() => {
    if (!state || state.status !== 'error') {
      return null;
    }
    if (state.errorCode === 'sdk_error') {
      const raw = typeof state.errorMessage === 'string' ? state.errorMessage.trim() : '';
      if (raw) {
        return raw.length > BTW_SERVER_ERROR_MAX_LEN
          ? `${raw.slice(0, BTW_SERVER_ERROR_MAX_LEN)}…`
          : raw;
      }
      return t('btw.errors.sdk_error');
    }
    const key = state.errorCode ? BTW_ERROR_CODE_KEYS[state.errorCode] : undefined;
    const mapped = key ? t(key, { defaultValue: '' }) : '';
    if (mapped) {
      return mapped;
    }
    return state.errorMessage || t('btw.errors.sdk_error');
  }, [state, t]);

  // نفس منطق errorText لكن على أكواد الفرك: مفتاح مخرَّط، وإلا رسالة الخادم
  // مقصوصة، وإلا النصّ العام.
  const forkErrorText = useMemo(() => {
    if (!state || state.forkStatus !== 'error') {
      return null;
    }
    const key = state.forkErrorCode ? BTW_FORK_ERROR_CODE_KEYS[state.forkErrorCode] : undefined;
    const mapped = key ? t(key, { defaultValue: '' }) : '';
    if (mapped) {
      return mapped;
    }
    const raw = typeof state.forkErrorMessage === 'string' ? state.forkErrorMessage.trim() : '';
    if (raw) {
      return raw.length > BTW_SERVER_ERROR_MAX_LEN
        ? `${raw.slice(0, BTW_SERVER_ERROR_MAX_LEN)}…`
        : raw;
    }
    return t('btw.fork.errors.fork_failed');
  }, [state, t]);

  // شرط الفرك مطابق لشرط «f» في الـCLI: إجابة مكتملة وغير فارغة.
  const canFork = Boolean(
    onFork && state?.status === 'complete' && state.answer.trim() !== '',
  );
  const isForking = state?.forkStatus === 'forking';

  const handleFork = useCallback(
    (mode: BtwForkMode) => {
      if (!canFork || isForking) {
        return;
      }
      onFork?.(mode);
    },
    [canFork, isForking, onFork],
  );

  // اختصارا لوحة المفاتيح: «f» للفرع الكامل (نفس اختصار الـCLI) و«n» للمحادثة
  // الجديدة. الـoverlay بلا حقول إدخال، ومع ذلك نتجاهل الحدث القادم من عنصر
  // كتابة (أو مع مُعدِّل) كي لا نخطف كتابةً مشروعة.
  useEffect(() => {
    if (!canFork || isForking) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== 'f' && key !== 'n') {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }
      event.preventDefault();
      onFork?.(key === 'f' ? 'full' : 'fresh');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canFork, isForking, onFork]);

  if (!state) {
    return null;
  }

  const isError = state.status === 'error';
  const isPending = state.status === 'pending';
  const isStreaming = state.status === 'streaming';
  const isComplete = state.status === 'complete';
  const isBusy = isPending || isStreaming;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        aria-labelledby={TITLE_ID}
        className="flex max-h-[80vh] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden p-0"
      >
        {/* الرأس: العنوان + زرّ الإغلاق */}
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <h2
            id={TITLE_ID}
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <MessageCircleQuestion className="h-4 w-4 text-primary" aria-hidden="true" />
            {t('btw.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={[
              'flex h-7 w-7 items-center justify-center rounded-md',
              'text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2',
              'focus-visible:ring-ring focus-visible:ring-offset-2',
              'focus-visible:ring-offset-background',
            ].join(' ')}
            aria-label={t('btw.close')}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* الجسم: السؤال ثم الإجابة/الحالة */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {t('btw.questionLabel')}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
              {state.question}
            </p>
          </div>

          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            <span>{t('btw.answerLabel')}</span>
            {isBusy && (
              <span className="inline-flex items-center gap-1 text-primary">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                <span>{isPending ? t('btw.status.pending') : t('btw.status.streaming')}</span>
              </span>
            )}
            {isComplete && (
              <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                <Check className="h-3 w-3" aria-hidden="true" />
                <span>{t('btw.status.complete')}</span>
              </span>
            )}
          </div>

          {isError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-foreground"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{errorText}</span>
            </div>
          ) : (
            <div
              className="min-h-6 whitespace-pre-wrap break-words text-sm text-foreground"
              aria-live="polite"
              aria-busy={isBusy}
            >
              {state.answer}
              {isPending && !state.answer && (
                <span className="text-muted-foreground">{t('btw.status.thinking')}</span>
              )}
            </div>
          )}
        </div>

        {/* خطأ الفرك — منفصل عن خطأ الإجابة: الإجابة سليمة والفرك وحده فشل */}
        {state.forkStatus === 'error' && forkErrorText && (
          <div
            role="alert"
            className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 whitespace-pre-wrap break-words">{forkErrorText}</span>
          </div>
        )}

        {/* التذييل: الفرك (يمين/بداية السطر) + التلميحان C4 (الحصة) وC5 (حدّ السياق) */}
        <div className="flex items-start justify-between gap-3 border-t border-border/60 px-4 py-2">
          <div className="min-w-0 space-y-0.5">
            <p className="text-[11px] leading-snug text-muted-foreground/80">
              {t('btw.hints.quota')}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground/80">
              {t('btw.hints.context')}
            </p>
          </div>

          {canFork && (
            <div className="flex shrink-0 flex-col items-stretch gap-1">
              {FORK_ACTIONS.map(({ mode, Icon, labelKey, hintKey }) => {
                const isThisRunning = isForking && state.forkMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleFork(mode)}
                    disabled={isForking}
                    title={t(hintKey)}
                    className={[
                      'inline-flex items-center gap-1.5 rounded-md border border-border/60',
                      'px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors',
                      'hover:bg-accent hover:text-accent-foreground',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                      'focus-visible:outline-none focus-visible:ring-2',
                      'focus-visible:ring-ring focus-visible:ring-offset-2',
                      'focus-visible:ring-offset-background',
                    ].join(' ')}
                  >
                    {isThisRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{isThisRunning ? t('btw.fork.pending') : t(labelKey)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
