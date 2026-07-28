/**
 * AgentStatusCard — بطاقة حالة موحّدة تدمج ClaudeStatus و AgentActivityStrip
 * في عنصر واحد مضغوط يوفّر مساحة رأسية.
 *
 * عندما لا يوجد وكلاء (agents.length === 0): تُفوَّض مباشرةً إلى <ClaudeStatus>
 * بلا أي تغيير — سلوك الحالة الشائعة محفوظ بالكامل.
 *
 * عندما يوجد وكيل أو أكثر: تُعرض بطاقة واحدة يحمل رأسها:
 *   [شعار المزوّد + نبضة] [اسم المزوّد · نص الحالة] [مقاييس sm+]
 *   [ملخص الوكلاء N/M] [STOP ESC] [chevron الطيّ]
 * والصفوف التفصيلية للوكلاء داخل الجزء القابل للطيّ.
 * التوفير المقدَّر: ~44px رأسية (رأس البطاقة الثانية + المسافة mb-3).
 *
 * RTL/themes: خصائص منطقية فقط (ms-/me-/ps-/pe-/border-s)، لا left/right.
 * ألوان من tokens المشتركة + dark: variants تطابق ClaudeStatus.
 *
 * منطق المؤقّت (EMA، elapsed، dots، run-anchor) منسوخ من ClaudeStatus
 * لأن المكوّنين لا يُعرضان معاً أبداً — MergedCard يملك المؤقت حين
 * يكون نشطاً، وClaudeStatus يملكه في الحالة العادية.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../../shared/view/ui';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { RunAgent, RunProgress } from '../../hooks/useRunProgress';

import ClaudeStatus from './ClaudeStatus';

// ── ثوابت مشتركة مع ClaudeStatus ─────────────────────────────────────────────
const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
const DEFAULT_ACTION_WORDS = [
  'Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning',
];
const PROVIDER_LABEL_KEYS: Record<string, string> = {
  claude: 'messageTypes.claude',
  codex: 'messageTypes.codex',
  cursor: 'messageTypes.cursor',
  gemini: 'messageTypes.gemini',
  opencode: 'messageTypes.opencode',
  kimi: 'messageTypes.kimi',
  deepseek: 'messageTypes.deepseek',
  glm: 'messageTypes.glm',
};
const EMA_ALPHA = 0.25;
const MIN_DONE_FOR_ESTIMATE = 1;
const MIN_ELAPSED_SECONDS_FOR_ESTIMATE = 15;
const STORAGE_KEY = 'nassaj-agent-activity-expanded';

function formatElapsed(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return m < 1 ? `${s}s` : `${m}m ${s}s`;
}

// ── AgentRow (نسخة طبق الأصل من AgentActivityStrip — غير مُصدَّرة هناك) ─────

function AgentRow({ agent, frozen }: { agent: RunAgent; frozen: boolean }) {
  const { t, i18n } = useTranslation('chat');
  const localeNum = (n: number) => n.toLocaleString(i18n.language);
  const running = agent.status === 'running';
  const pulse = running && !frozen;
  const contentId = useId();

  // صدق العرض (B-208، بند 8 — فيتو): الأداة الجارية وعدّاد الاستدعاءات يأتيان
  // حصراً من `childTools`، وهذه تُبنى إمّا من البثّ الحيّ (صفوف تحمل
  // `parentToolUseId`) أو من مجموع التاريخ (`subagentTools`) الذي لا يُلصق إلا
  // مع نتيجة الوكيل. فوكيل ما يزال يعمل بعد تحديث الصفحة لا يملك أياً منهما —
  // صفر صفوف `parentToolUseId` في transcripts حيّة — فالعدّاد ليس «0 استدعاء»
  // بل «غير معروف». نُخفي الحقلين صراحةً بدل تلفيق صفر.
  const callsKnown = Number.isFinite(agent.callCount) && agent.callCount > 0;
  const showCurrentTool = running && Boolean(agent.currentTool);

  const statusLabel = running
    ? t('agentActivity.running', { defaultValue: 'Running' })
    : t('agentActivity.done', { defaultValue: 'Done' });

  return (
    <Collapsible className="group/agent">
      <CollapsibleTrigger
        aria-controls={contentId}
        className={[
          'flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start',
          'transition-colors hover:bg-muted/50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        ].join(' ')}
        aria-label={t('agentActivity.rowAria', {
          type: agent.type,
          status: statusLabel,
          defaultValue: '{{type}} — {{status}}',
        })}
      >
        {/* نقطة الحالة */}
        {running ? (
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500',
              pulse && 'animate-pulse',
            )}
            aria-hidden="true"
          />
        ) : (
          <svg
            className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        )}

        {/* نوع الوكيل + الوصف */}
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {agent.type}
          {agent.description && (
            <span className="text-muted-foreground/80">
              {' · '}
              {agent.description}
            </span>
          )}
        </span>

        {/* الأداة الحالية (sm+ فقط) — تُعرض فقط حين تكون معروفة فعلاً */}
        {showCurrentTool && (
          <span className="ms-auto hidden shrink-0 items-center gap-1 text-[10px] text-muted-foreground sm:flex">
            <span className="text-muted-foreground/50">
              {t('agentActivity.currently', { defaultValue: 'now' })}
            </span>
            <span className="max-w-32 truncate font-mono text-foreground/90">
              {agent.currentTool}
            </span>
          </span>
        )}

        {/* عدّاد الاستدعاءات — مُخفى حين تكون القيمة غير مستعادة من القرص */}
        {callsKnown && (
          <span
            className={cn(
              'shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px]',
              'font-medium tabular-nums text-muted-foreground',
              !showCurrentTool && 'ms-auto',
            )}
            title={t('agentActivity.callsTooltip', {
              calls: localeNum(agent.callCount),
              defaultValue: '{{calls}} tool calls',
            })}
          >
            {t('agentActivity.calls', {
              calls: localeNum(agent.callCount),
              defaultValue: '{{calls}}',
            })}
          </span>
        )}

        {/* فاصل يحفظ محاذاة chevron إلى الطرف حين يُخفى الحقلان معاً */}
        {!showCurrentTool && !callsKnown && <span className="ms-auto" aria-hidden="true" />}

        {/* chevron توسّع تاريخ الأدوات */}
        <svg
          className={[
            'h-2.5 w-2.5 shrink-0 text-muted-foreground/50 transition-transform duration-150',
            'group-data-[state=open]/agent:rotate-90',
            'rtl:rotate-180 rtl:group-data-[state=open]/agent:rotate-90',
          ].join(' ')}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </CollapsibleTrigger>

      {/* تاريخ أدوات الوكيل */}
      <CollapsibleContent id={contentId}>
        <div className="ms-3 mt-0.5 border-s border-border ps-3">
          {!agent.childTools || agent.childTools.length === 0 ? (
            <p className="py-1 text-[11px] text-muted-foreground/70">
              {t('agentActivity.noTools', {
                defaultValue: 'No tool calls recorded yet.',
              })}
            </p>
          ) : (
            <ul className="max-h-48 overflow-y-auto py-0.5">
              {agent.childTools.map((tool, idx) => {
                const succeeded = tool.toolResult != null;
                return (
                  <li
                    key={tool.toolId || idx}
                    className="flex items-center gap-1.5 py-0.5 text-[11px]"
                  >
                    {succeeded ? (
                      <svg
                        className="h-2.5 w-2.5 shrink-0 text-green-600 dark:text-green-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-label={t('agentActivity.toolSuccess', {
                          defaultValue: 'Done',
                        })}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    ) : (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate font-mono text-foreground/80">
                      {tool.toolName}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── نوع الخصائص المشتركة ───────────────────────────────────────────────────────

type AgentStatusCardProps = {
  agents: RunAgent[];
  /**
   * Rows for agents of a background WORKFLOW (server-sourced, disk-backed).
   *
   * Kept as a separate prop rather than merged upstream because the two sources
   * have different lifetimes: `agents` is a per-reply snapshot that vanishes when
   * the reply ends, while a workflow's agents keep running across replies — and
   * their presence alone is enough to show the card even when the coordinator is
   * idle (`isLoading === false`). Merged here, at the presentation layer only.
   */
  workflowAgents?: RunAgent[];
  status: {
    text?: string;
    tokens?: number;
    can_interrupt?: boolean;
  } | null;
  onAbort?: () => void;
  isLoading: boolean;
  frozen?: boolean;
  provider?: string;
  runStartedAt?: number | null;
  progress?: RunProgress | null;
};

// ── البطاقة الموحّدة — تُعرض فقط حين agents.length > 0 ──────────────────────

function MergedCard({
  agents,
  status,
  onAbort,
  isLoading,
  frozen = false,
  provider = 'claude',
  runStartedAt = null,
  progress = null,
}: AgentStatusCardProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const localeNum = (n: number) => n.toLocaleString(locale);

  // ── منطق المؤقت (مطابق لـ ClaudeStatus) ──────────────────────────────────
  const [elapsedTime, setElapsedTime] = useState(0);
  const [dots, setDots] = useState('');
  const runAnchorRef = useRef<number | null>(null);
  const anchorIsFallbackRef = useRef(false);
  /**
   * هل المرساة حقيقية (طابع آخر رسالة مستخدم) أم بديل وقت-التركيب؟
   *
   * B-208 (بند 8 — فيتو): بعد تحديث الصفحة قد يقع آخر صفّ مستخدم خارج نافذة
   * الجلب فيعود `runStartedAt = null`، فكانت البطاقة تبدأ العدّ من الآن وتعرض
   * «0:03» لتشغيل عمره 20 دقيقة. المؤقّت الآن يُخفى حتى تُحلّ المرساة الحقيقية
   * بدل عرض رقم ملفَّق. (نسخة state من `anchorIsFallbackRef` لأن الـref لا
   * يُعيد الرسم.)
   */
  const [anchorResolved, setAnchorResolved] = useState(false);
  const emaEstRef = useRef<number | null>(null);
  const prevDisplayedEstRef = useRef<number | null>(null);
  const [displayedEst, setDisplayedEst] = useState<number | null>(null);
  const ratioRef = useRef(0);
  const doneRef = useRef(0);
  const prevTotalRef = useRef<number | null>(null);

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const inProgress = progress?.inProgress ?? 0;
  const barRatio = total > 0 ? Math.min(1, (done + 0.5 * inProgress) / total) : 0;
  ratioRef.current = total > 0 && done >= 1 ? done / total : 0;
  doneRef.current = done;

  useEffect(() => {
    if (!isLoading) {
      runAnchorRef.current = null;
      anchorIsFallbackRef.current = false;
      emaEstRef.current = null;
      prevDisplayedEstRef.current = null;
      prevTotalRef.current = null;
      setElapsedTime(0);
      setDisplayedEst(null);
      setAnchorResolved(false);
      return;
    }

    if (runAnchorRef.current === null) {
      if (typeof runStartedAt === 'number' && Number.isFinite(runStartedAt)) {
        runAnchorRef.current = runStartedAt;
        anchorIsFallbackRef.current = false;
        setAnchorResolved(true);
      } else {
        runAnchorRef.current = Date.now();
        anchorIsFallbackRef.current = true;
        setAnchorResolved(false);
      }
      emaEstRef.current = null;
      prevDisplayedEstRef.current = null;
      prevTotalRef.current = null;
      setDisplayedEst(null);
    } else if (
      anchorIsFallbackRef.current &&
      typeof runStartedAt === 'number' &&
      Number.isFinite(runStartedAt)
    ) {
      runAnchorRef.current = Math.min(runAnchorRef.current, runStartedAt);
      anchorIsFallbackRef.current = false;
      setAnchorResolved(true);
    }

    // العملية مجمّدة: لا تُقدِّم أي مؤقتات
    if (frozen) return;

    const tick = () => {
      const anchor = runAnchorRef.current ?? Date.now();
      const elapsed = Math.max(0, Math.floor((Date.now() - anchor) / 1000));
      setElapsedTime(elapsed);

      if (anchorIsFallbackRef.current) {
        setDisplayedEst(null);
        return;
      }

      const ratio = ratioRef.current;
      const enoughSignal =
        doneRef.current >= MIN_DONE_FOR_ESTIMATE &&
        elapsed >= MIN_ELAPSED_SECONDS_FOR_ESTIMATE;

      if (!enoughSignal || ratio <= 0) {
        setDisplayedEst(null);
        return;
      }

      const rawEst = Math.max(0, elapsed / ratio - elapsed);
      const prevEma = emaEstRef.current;
      const ema =
        prevEma === null ? rawEst : EMA_ALPHA * rawEst + (1 - EMA_ALPHA) * prevEma;
      emaEstRef.current = ema;

      const prevDisplayed = prevDisplayedEstRef.current;
      const nextDisplayed =
        prevDisplayed === null ? ema : Math.min(ema, prevDisplayed);
      prevDisplayedEstRef.current = nextDisplayed;
      setDisplayedEst(nextDisplayed);
    };

    tick();
    const timer = setInterval(tick, 1000);
    const dotTimer = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);

    return () => {
      clearInterval(timer);
      clearInterval(dotTimer);
    };
  }, [isLoading, frozen, runStartedAt]);

  // FIX 3: إعادة ضبط التقدير عند نموّ الخطة في منتصف التشغيل
  useEffect(() => {
    if (!isLoading) return;
    const prev = prevTotalRef.current;
    prevTotalRef.current = total;
    if (prev !== null && total > prev) {
      emaEstRef.current = null;
      prevDisplayedEstRef.current = null;
      setDisplayedEst(null);
    }
  }, [total, isLoading]);

  // ── حالة الطيّ (محفوظة في localStorage) ──────────────────────────────────
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored !== null ? stored !== 'false' : true;
    } catch {
      return true;
    }
  });

  const toggle = useCallback(() => {
    setIsExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  // ── القيم المشتقة ──────────────────────────────────────────────────────────
  const isFrozenLoading = isLoading && frozen;
  const actionWords = ACTION_KEYS.map((key, i) =>
    t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }),
  );
  // Idle coordinator + rows on screen = the rows belong to a background workflow.
  // Cycling "Thinking…/Analyzing…" here would assert the assistant is working on
  // the user's turn when it is not; the label names what is actually running.
  const backgroundOnly = !isLoading && agents.length > 0;
  const statusText = isFrozenLoading
    ? t('claudeStatus.frozen', { defaultValue: 'Paused (process frozen)' })
    : backgroundOnly
      ? t('agentActivity.backgroundWorkflow', {
          defaultValue: 'Background workflow running',
        })
      : (
          status?.text ||
          actionWords[Math.floor(elapsedTime / 3) % actionWords.length]
        ).replace(/[.]+$/, '');

  const providerLabel = t(
    PROVIDER_LABEL_KEYS[provider] || 'claudeStatus.providers.assistant',
    { defaultValue: 'Assistant' },
  );

  const showProgressArea = isLoading && !frozen;
  const showTaskCounter = showProgressArea && total > 0;
  const canInterrupt = isLoading && status?.can_interrupt !== false && !!onAbort;

  const formatLocalizedDuration = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins < 1
      ? t('claudeStatus.elapsed.seconds', {
          count: secs,
          defaultValue: '{{count}}s',
        })
      : t('claudeStatus.elapsed.minutesSeconds', {
          minutes: mins,
          seconds: secs,
          defaultValue: '{{minutes}}m {{seconds}}s',
        });
  };

  const estimateReady =
    displayedEst !== null && Number.isFinite(displayedEst);
  const estimateText = estimateReady
    ? t('runProgress.estimateRemaining', {
        time: formatLocalizedDuration(Math.round(displayedEst as number)),
        defaultValue: '≈ {{time}} left',
      })
    : t('runProgress.estimating', { defaultValue: '…' });

  const runningCount = agents.reduce(
    (n, a) => (a.status === 'running' ? n + 1 : n),
    0,
  );

  // ── عرض البطاقة الموحّدة ──────────────────────────────────────────────────
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 mb-3 w-full duration-500">
      <div
        className={[
          'mx-auto max-w-4xl overflow-hidden border border-border/50',
          'bg-slate-100 shadow-sm backdrop-blur-md dark:bg-slate-900',
          isExpanded ? 'rounded-2xl' : 'rounded-full',
          'transition-[border-radius] duration-150',
        ].join(' ')}
      >
        {/* ── صف الرأس ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-3 py-1.5">

          {/* شعار المزوّد + خاتم النبضة */}
          <div
            className={[
              'relative flex h-6 w-6 shrink-0 items-center justify-center',
              'rounded-full bg-primary/20 ring-1 ring-primary/10',
            ].join(' ')}
          >
            <SessionProviderLogo provider={provider} className="h-3.5 w-3.5" />
            {isLoading && !frozen && (
              <span className="absolute inset-0 animate-pulse rounded-full ring-2 ring-emerald-500/20" />
            )}
          </div>

          {/* اسم المزوّد + نص الحالة */}
          <div className="flex min-w-0 grow flex-col sm:flex-row sm:items-center sm:gap-2">
            {/* اسم المزوّد مُترجَم (عربي في الواجهة العربية): لا `tracking-*`
                عليه — التباعد الحرفي يكسر التحام الحروف العربية. */}
            <span className="shrink-0 text-[10px] font-bold uppercase text-muted-foreground/70">
              {providerLabel}
            </span>
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  isLoading && !frozen
                    ? 'animate-pulse bg-emerald-500'
                    : 'bg-amber-500',
                )}
                aria-hidden="true"
              />
              <p className="truncate text-xs font-medium text-foreground">
                {statusText}
                <span className="inline-block w-4 text-primary">
                  {isLoading && !frozen ? dots : ''}
                </span>
              </p>
            </div>
          </div>

          {/* مقاييس: عدّاد المهام + الشريط (sm+) */}
          {showTaskCounter && (
            <div
              className={[
                'hidden shrink-0 items-center gap-1.5 rounded-md',
                'bg-muted/50 px-2 py-0.5 text-[10px] font-medium',
                'text-muted-foreground sm:flex',
              ].join(' ')}
              title={[
                t('runProgress.tasksTooltip', {
                  done: localeNum(done),
                  total: localeNum(total),
                  defaultValue: 'Tasks: {{done}} of {{total}} done',
                }),
                inProgress > 0
                  ? t('runProgress.inProgressTooltip', {
                      count: inProgress,
                      defaultValue: '{{count}} in progress',
                    })
                  : null,
              ]
                .filter(Boolean)
                .join('\n')}
            >
              <span className="shrink-0 tabular-nums">
                {t('runProgress.tasksLabel', { defaultValue: 'Tasks' })}{' '}
                {localeNum(done)}/{localeNum(total)}
              </span>
              <div
                className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border/60"
                role="progressbar"
                aria-valuenow={Math.round(barRatio * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('runProgress.barAria', {
                  defaultValue: 'Task progress',
                })}
              >
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
                  style={{ width: `${barRatio * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* تقدير الوقت المتبقّي (sm+، عند وجود مهام فقط) */}
          {showTaskCounter && (
            <div
              className={[
                'hidden shrink-0 items-center rounded-md bg-muted/50 px-2 py-0.5',
                'text-[10px] font-medium tabular-nums text-muted-foreground sm:flex',
              ].join(' ')}
              title={t('runProgress.estimateTooltip', {
                defaultValue:
                  'Rough estimate — based on completed tasks so far.',
              })}
            >
              {estimateText}
            </div>
          )}

          {/* الوقت المنقضي (sm+، حين يتوفر زر STOP ومرساة حقيقية للتشغيل).
              بلا مرساة لا يُعرض شيء — لا عدّ من صفر (بند 8). */}
          {canInterrupt && anchorResolved && (
            <div
              className={[
                'hidden shrink-0 items-center rounded-md bg-muted/50 px-2 py-0.5',
                'text-[10px] font-medium tabular-nums text-muted-foreground sm:flex',
              ].join(' ')}
            >
              {formatElapsed(elapsedTime)}
            </div>
          )}

          {/* ملخّص الوكلاء: N/M running — ظاهر دائماً */}
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            {t('agentActivity.summary', {
              running: runningCount,
              total: agents.length,
              defaultValue: '{{running}}/{{total}} running',
            })}
          </span>

          {/* زر STOP — مستقل لا يُطلق toggle */}
          {canInterrupt && (
            <button
              type="button"
              onClick={onAbort}
              className={[
                'group flex shrink-0 items-center gap-1.5 rounded-full',
                'bg-destructive/10 px-2.5 py-1 text-[10px] font-bold text-destructive',
                'transition-all hover:bg-destructive hover:text-destructive-foreground',
              ].join(' ')}
            >
              <svg
                className="h-3 w-3 fill-current"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M6 6h12v12H6z" />
              </svg>
              <span className="hidden sm:inline">STOP</span>
              <kbd className="hidden rounded bg-black/10 px-1 text-[9px] group-hover:bg-white/20 sm:block">
                ESC
              </kbd>
            </button>
          )}

          {/* زر chevron الطيّ — عنصر تفاعلي مستقل */}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t('agentActivity.collapseAria', {
                    defaultValue: 'Collapse agent activity',
                  })
                : t('agentActivity.expandAria', {
                    defaultValue: 'Expand agent activity',
                  })
            }
            className={[
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
              'transition-colors hover:bg-muted/40',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            ].join(' ')}
          >
            <svg
              className={cn(
                'h-3 w-3 text-muted-foreground/50 transition-transform duration-150',
                isExpanded ? 'rotate-0' : '-rotate-90 rtl:rotate-90',
              )}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>

        {/* ── صفوف الوكلاء (قابلة للطيّ) ───────────────────────────────────── */}
        {isExpanded && (
          <div className="border-t border-border/30 px-3 py-1.5">
            <div className="flex flex-col gap-0.5">
              {agents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} frozen={frozen} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── التصدير العام ─────────────────────────────────────────────────────────────

/**
 * AgentStatusCard — entry point:
 * - agents.length === 0 → <ClaudeStatus> مباشرةً (حالة شائعة، صفر انحدار)
 * - agents.length > 0 → <MergedCard> (البطاقة الموحّدة)
 */
export default function AgentStatusCard(props: AgentStatusCardProps) {
  const workflowAgents = props.workflowAgents ?? [];
  // Reply-scoped rows first (they belong to what is happening right now), then
  // the longer-lived workflow rows.
  const allAgents = workflowAgents.length > 0 ? [...props.agents, ...workflowAgents] : props.agents;

  if (allAgents.length === 0) {
    return (
      <ClaudeStatus
        status={props.status}
        onAbort={props.onAbort}
        isLoading={props.isLoading}
        frozen={props.frozen}
        provider={props.provider}
        runStartedAt={props.runStartedAt}
        progress={props.progress}
      />
    );
  }

  // A workflow outlives the reply that launched it, so its rows must render even
  // when the coordinator is idle. In that state the card is informational only:
  // `isLoading` stays false, which already suppresses the elapsed timer, the
  // animated dots and the STOP button (STOP aborts the SESSION — it cannot stop a
  // detached workflow, so offering it here would be a false promise).
  return <MergedCard {...props} agents={allAgents} />;
}
