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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks } from 'lucide-react';

import { formatObservedCount, ObservedSkillCount, ObservedSkillsList } from '../../../participants/ObservedSkills';
import { cn } from '../../../../lib/utils';
import { formatWorkDuration } from '../../../../utils/workDurationFormat';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../../shared/view/ui';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { subagentTypeLabel } from '../../tools/subagentTitle';
import { resolveOverallPercent } from '../../hooks/declaredProgress';
import type { RunAgent, RunProgress } from '../../hooks/useRunProgress';
import { mergeSessionAgents, nextRegistryExpiry } from '../../hooks/mergeSessionAgents';
import type { SessionAgentRow } from '../../hooks/useSessionAgents';
import type { WorkflowUiDescriptor } from '../../../../stores/workflowStatus';

import ClaudeStatus from './ClaudeStatus';
import { ACTION_KEYS, DEFAULT_ACTION_WORDS, localizeStatusText, stripTrailingEllipsis } from './runStatusText';
import { shortModelLabel } from './MessageModelBadge';
import PercentMeter, { formatPercent } from './PercentMeter';
import { RunStatusActions, RunStatusIdentityLabel, RunStatusSteerHint } from './RunStatusViewerActions';
import { OutcomeIcon } from './SubagentOutcome';
import {
  agentCountsLabel, countAgentOutcomes, isUnsuccessfulOutcome, OUTCOME_BADGE_CLASS, outcomeLabel, outcomeTooltip,
  rowOutcome,
} from './subagentOutcomeText';

// ── ثوابت مشتركة مع ClaudeStatus ─────────────────────────────────────────────
const PROVIDER_LABEL_KEYS: Record<string, string> = {
  claude: 'messageTypes.claude',
  codex: 'messageTypes.codex',
  cursor: 'messageTypes.cursor',
  opencode: 'messageTypes.opencode',
  kimi: 'messageTypes.kimi',
  deepseek: 'messageTypes.deepseek',
  glm: 'messageTypes.glm',
};
const EMA_ALPHA = 0.25;
const MIN_DONE_FOR_ESTIMATE = 1;
const MIN_ELAPSED_SECONDS_FOR_ESTIMATE = 15;

// ── تفضيل إخفاء الوكلاء المكتملين (محلي، مستمرّ) ─────────────────────────────
// افتراضياً مخفيّون: بطاقة تتراكم فيها صفوف ✓ خضراء تفقد فائدتها كمؤشّر حيّ.
// فقط النجاح المؤكَّد (`done` بنتيجة `completed`) يُخفى؛ الفاشل والموقوف ومجهول
// النهاية و`stale` و`running` تبقى ظاهرة دائماً بصرف النظر عن التفضيل (P0).
const HIDE_COMPLETED_STORAGE_KEY = 'nassaj:agentStatusCard:hideCompleted';

function readHideCompletedPref(): boolean {
  try {
    const stored = localStorage.getItem(HIDE_COMPLETED_STORAGE_KEY);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch {
    // localStorage unavailable (SSR / private mode) — fall back to default.
  }
  return true;
}

function writeHideCompletedPref(value: boolean): void {
  try {
    localStorage.setItem(HIDE_COMPLETED_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // localStorage unavailable — preference stays in-memory for this session.
  }
}

// ── ما أعلنه الوكيل: المنجز/التالي/المتبقي (يظهر داخل الجزء القابل للطيّ) ──────

function DeclaredProgressNote({ progress }: { progress: NonNullable<RunAgent['progress']> }) {
  const { t, i18n } = useTranslation('chat');
  const { done, next, left } = progress;
  if (!done && !next && left === undefined) return null;
  return (
    <section
      className="space-y-0.5 py-1.5 text-[11px]"
      data-testid="agent-declared-note"
      aria-label={t('agentActivity.declaredHeading', { defaultValue: 'Reported by the agent' })}
    >
      <p className="font-medium text-violet-700 dark:text-violet-300">
        {t('agentActivity.declaredHeading', { defaultValue: 'Reported by the agent' })}
      </p>
      {done && (
        <p className="break-words text-muted-foreground">
          <span className="font-medium">{t('agentActivity.declaredDone', { defaultValue: 'Done' })}:</span> {done}
        </p>
      )}
      {next && (
        <p className="break-words text-muted-foreground">
          <span className="font-medium">{t('agentActivity.declaredNext', { defaultValue: 'Next' })}:</span> {next}
        </p>
      )}
      {left !== undefined && (
        <p className="text-muted-foreground">
          {t('agentActivity.declaredLeft', {
            minutes: left.toLocaleString(i18n.language),
            defaultValue: '~{{minutes}} min left',
          })}
        </p>
      )}
    </section>
  );
}

// ── AgentRow (صفّ الوكيل الواحد داخل البطاقة — غير مُصدَّر) ─────

function AgentRow({ agent, frozen }: { agent: RunAgent; frozen: boolean }) {
  const { t, i18n } = useTranslation('chat');
  const localeNum = (n: number) => n.toLocaleString(i18n.language);
  const skillCount = new Set(agent.observedSkills?.map(item => item.skillKey)).size;
  const skillAria = skillCount > 0 && agent.observedSkills ? t('skillObservations.count', { value: !agent.skillCoverage || ['unsupported', 'unavailable'].includes(agent.skillCoverage.state) ? '—' : formatObservedCount(skillCount, i18n.language) }) : '';
  const outcome = rowOutcome(agent);
  const running = outcome === 'running';
  const unsuccessful = isUnsuccessfulOutcome(outcome);
  // A stale row is NOT a done row and NOT a live one: it started, never produced a
  // result, and stopped writing. It gets its own mark (a hollow amber ring, no
  // pulse) because reusing the green tick would claim success and reusing the
  // pulsing dot would claim life — the 18-hour "running · now Bash" on a run that
  // died overnight was exactly the second mistake.
  const stale = outcome === 'stale';
  const pulse = running && !frozen;
  const contentId = useId();
  const typeLabel = subagentTypeLabel(t, agent.agentName || agent.type) || '—';
  const modelLabel = agent.model ? shortModelLabel(agent.model, 32) : '—';
  const effortLabel = agent.effort || '—';
  const toolRows = new Map<
    string,
    { key: string; name: string; succeeded: boolean; failed: boolean }
  >();
  for (const tool of agent.childTools ?? []) {
    const key = tool.toolId || `legacy:${tool.toolName}`;
    toolRows.set(key, {
      key,
      name: tool.toolName,
      succeeded: Boolean(tool.toolResult && !tool.toolResult.isError),
      failed: Boolean(tool.toolResult?.isError),
    });
  }
  for (const tool of agent.tools ?? []) {
    const key = tool.id || `legacy:${tool.name}`;
    toolRows.set(key, {
      key,
      name: tool.name,
      succeeded: ['done', 'success', 'completed'].includes(tool.status ?? ''),
      failed: tool.status === 'failed' || tool.status === 'error',
    });
  }
  const tools = [...toolRows.values()];
  // P0: only a successful end is 100%; failed/stopped/unknown show no percent at all.
  const rowPercent = outcome === 'completed' ? 100 : running ? (agent.progress?.percent ?? null) : null;

  // صدق العرض (B-208، بند 8 — فيتو): الأداة الجارية وعدّاد الاستدعاءات يأتيان
  // حصراً من `childTools`، وهذه تُبنى إمّا من البثّ الحيّ (صفوف تحمل
  // `parentToolUseId`) أو من مجموع التاريخ (`subagentTools`) الذي لا يُلصق إلا
  // مع نتيجة الوكيل. فوكيل ما يزال يعمل بعد تحديث الصفحة لا يملك أياً منهما —
  // صفر صفوف `parentToolUseId` في transcripts حيّة — فالعدّاد ليس «0 استدعاء»
  // بل «غير معروف». نُخفي الحقلين صراحةً بدل تلفيق صفر.
  const callsKnown = Number.isFinite(agent.callCount) && agent.callCount > 0;
  const showCurrentTool = running && Boolean(agent.currentTool);

  const statusLabel = outcomeLabel(t, outcome, agent.outcomeCause);
  // P0: the inferred cause also reaches keyboard (aria-label) and touch (expanded
  // panel) users, not only a hover `title`.
  const causeText = unsuccessful ? outcomeTooltip(t, outcome, agent.outcomeCause) : '';

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
          type: typeLabel,
          status: statusLabel,
          defaultValue: '{{type}} — {{status}}',
        }) + (causeText ? ` · ${causeText}` : '') + (skillAria ? ` · ${skillAria}` : '')}
      >
        {/* علامة الحالة: علامة الصحّ للنجاح وحده (P0) */}
        <OutcomeIcon outcome={outcome} pulse={pulse} />

        {/* Name, model and effort stay scannable as compact chips. */}
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <span
            className={[
              'max-w-40 truncate rounded bg-muted/60 px-1.5 py-0.5 text-xs',
              'font-medium text-foreground',
            ].join(' ')}
          >
            <bdi>{typeLabel}</bdi>
          </span>
          {/* B-1665: a Latin model id truncated inside an RTL row lost its head
              ("…-5-5"). The truncating element itself is LTR, so the ellipsis
              lands at the end, and the label is the short form with the full id
              in the tooltip. */}
          <span
            dir="ltr"
            title={agent.model || undefined}
            className={[
              'max-w-48 truncate rounded border border-border px-1.5 py-0.5 text-[10px]',
              'text-muted-foreground',
            ].join(' ')}
          >
            <bdi>{modelLabel}</bdi>
          </span>
          <span
            className={[
              'max-w-32 truncate rounded border border-border px-1.5 py-0.5 text-[10px]',
              'text-muted-foreground',
            ].join(' ')}
          >
            <bdi>{effortLabel}</bdi>
          </span>
        </span>
        {agent.description && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            <bdi>{agent.description}</bdi>
          </span>
        )}

        {skillCount > 0 && <ObservedSkillCount count={skillCount} coverage={agent.skillCoverage} />}

        {/* نسبة الإنجاز: «انتهى» عبر tool_result = 100% محسوبة؛ الجاري = ما أعلنه
            الوكيل نفسه (موسومة). بعد تحديث الصفحة لا نثر → تُخفى، لا 0% مختلقة. */}
        {rowPercent !== null && (
          <PercentMeter
            testId="agent-percent"
            percent={rowPercent}
            declared={running}
            label={t('agentActivity.percentAria', { defaultValue: 'Agent progress' })}
            barFromSm
            barWidth="w-8"
          />
        )}

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

        {/* «بلا إشارة» — نصّ صريح لا نقطة وحدها. الاعتماد على لون النقطة كان
            سيترك الصفّ يُقرأ «يعمل» لمن لا يميّز الأخضر من الكهرماني. */}
        {stale && (
          <span
            className="ms-auto shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"
            title={t('agentActivity.staleTooltip', {
              defaultValue:
                'Started, never returned a result, and its transcript stopped growing — neither running nor confirmed dead.',
            })}
          >
            {t('agentActivity.stale', { defaultValue: 'No signal' })}
          </span>
        )}

        {/* ADR-218: a state the server reconstructed (or an end it could not
            observe) is marked as such, muted, so it never reads as measured. */}
        {agent.estimated && (
          <span
            data-testid="agent-estimated-badge"
            className={cn(
              'shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
              !stale && !unsuccessful && !showCurrentTool && 'ms-auto',
            )}
            title={t('agentActivity.estimatedTooltip', {
              defaultValue: 'Rebuilt by the server from the session record, not from a live event.',
            })}
          >
            {t('agentActivity.estimated', { defaultValue: 'Estimated state' })}
          </span>
        )}

        {/* نهاية بلا نجاح — نصّ صريح لا لون وحده، مع سبب الاستنتاج في التلميح. */}
        {unsuccessful && (
          <span
            data-testid="agent-outcome-badge"
            className={cn(
              'ms-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
              OUTCOME_BADGE_CLASS[outcome as 'failed' | 'stopped' | 'unknown'],
            )}
            title={causeText}
          >
            {statusLabel}
          </span>
        )}

        {/* عدّاد الاستدعاءات — مُخفى حين تكون القيمة غير مستعادة من القرص */}
        {callsKnown && (
          <span
            className={cn(
              'shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px]',
              'font-medium tabular-nums text-muted-foreground',
              !showCurrentTool && !stale && !unsuccessful && 'ms-auto',
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
        {!showCurrentTool && !callsKnown && !stale && !unsuccessful && <span className="ms-auto" aria-hidden="true" />}

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
          {causeText && <p className="py-1 text-xs text-muted-foreground" data-testid="agent-outcome-cause">{causeText}</p>}
          {agent.progress && <DeclaredProgressNote progress={agent.progress} />}
          {skillCount > 0 && agent.observedSkills && <section className="space-y-0.5 py-1.5" aria-label={t('skillObservations.title')}>
            <p className="text-xs font-medium text-muted-foreground">{t('skillObservations.title')}</p>
            {agent.skillsStale && <p className="text-xs text-muted-foreground">{t('skillObservations.stale')}</p>}
            <ObservedSkillsList observations={agent.observedSkills} />
          </section>}
          {!tools || tools.length === 0 ? (
            <p className="py-1 text-[11px] text-muted-foreground/70">
              {t('agentActivity.noTools', {
                defaultValue: 'No tool calls recorded yet.',
              })}
            </p>
          ) : (
            <ul className="max-h-48 overflow-y-auto py-0.5">
              {tools.map((tool) => {
                return (
                  <li
                    key={tool.key}
                    className="flex items-center gap-1.5 py-0.5 text-[11px]"
                  >
                    {tool.succeeded ? (
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
                    ) : tool.failed ? (
                      <svg
                        className="h-2.5 w-2.5 shrink-0 text-destructive"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-label={t('agentActivity.toolFailed', { defaultValue: 'Failed' })}
                      >
                        <path strokeLinecap="round" strokeWidth={2} d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    ) : (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate font-mono text-foreground/80">
                      <bdi>{tool.name}</bdi>
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
  /**
   * ADR-218: the server registry's rows for this session (`useSessionAgents`).
   * Merged with `agents` (stream detail, registry liveness) and deduped against
   * `workflowAgents`; registry-only rows show agents of earlier turns too.
   */
  sessionAgents?: SessionAgentRow[];
  /** Internal: true when a row on the card comes from a background workflow. */
  hasWorkflowRows?: boolean;
  /**
   * The server's honest verdict on the workflow those rows belong to, or null.
   *
   * Without it this card printed the literal word "running" for every surfaced
   * workflow — including `unknown` (liveness the server explicitly refused to
   * vouch for) and `frozen` (SIGSTOPped). The verdict existed upstream all
   * along; only the wire to this component was missing.
   */
  workflowStatus?: WorkflowUiDescriptor | null;
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
  /** T-1904 — see ClaudeStatus.tsx. Only reaches ClaudeStatus (agents.length===0). */
  viewerStarterName?: string | null;
  steerable?: boolean;
  onSteerClick?: () => void;
  /** T-1904 e2e (BLOCKER) — see ChatComposer.tsx. Only reaches ClaudeStatus. */
  runActiveOverride?: boolean;
  /** T-1904 e2e (BLOCKER) — see ClaudeStatus.tsx. Fail-closed; defaults true (legacy solo). */
  isConfirmedStarter?: boolean;
  /** T-1956 — see ClaudeStatus.tsx. Reaches both ClaudeStatus and MergedCard. */
  showSteerHint?: boolean;
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
  workflowStatus = null,
  hasWorkflowRows = false,
  viewerStarterName = null,
  steerable = false,
  onSteerClick,
  isConfirmedStarter = true,
  showSteerHint = false,
}: AgentStatusCardProps) {
  const isViewer = viewerStarterName != null;
  const { t, i18n } = useTranslation('chat');
  // The workflow labels live in `common` (shared with the sidebar badge, so the
  // two surfaces cannot drift apart); everything else on this card is `chat`.
  const { t: tCommon } = useTranslation('common');
  const locale = i18n.language;
  const localeNum = (n: number) => n.toLocaleString(locale);

  // ── منطق المؤقت (مطابق لـ ClaudeStatus) ──────────────────────────────────
  const [elapsedTime, setElapsedTime] = useState(0);
  const [dots, setDots] = useState('');
  const runAnchorRef = useRef<number | null>(null);
  // A false→true edge while mounted is itself a truthful local start. Mounting
  // into an older active run is different: without `runStartedAt` its elapsed
  // duration remains unknown and stays hidden until the transcript resolves it.
  const previousLoadingRef = useRef(isLoading);
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
    const startedWhileMounted = isLoading && !previousLoadingRef.current;
    previousLoadingRef.current = isLoading;

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
        setAnchorResolved(startedWhileMounted);
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

  // ── حالة الطيّ (بلا حفظ دائم — MergedCard تُركَّب من جديد مع كل تشغيل
  // يظهر فيه وكلاء، فتبدأ موسَّعة دائماً؛ الطيّ يخصّ هذه البطاقة فقط) ────────
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  const toggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // ── إخفاء المكتمل (مستمرّ عبر localStorage، افتراضي: مخفي) ────────────────
  const [hideCompleted, setHideCompleted] = useState<boolean>(readHideCompletedPref);

  const toggleHideCompleted = useCallback(() => {
    setHideCompleted((prev) => {
      const next = !prev;
      writeHideCompletedPref(next);
      return next;
    });
  }, []);

  // P0: «مكتمل» = نجح فقط؛ الفاشل والموقوف ومجهول النهاية لا تُعدّ ولا تُخفى معه.
  const outcomeCounts = countAgentOutcomes(agents);
  const completedCount = outcomeCounts.succeeded;
  const visibleAgents = hideCompleted
    ? agents.filter((a) => rowOutcome(a) !== 'completed')
    : agents;
  const allHiddenAsCompleted = hideCompleted && completedCount > 0 && visibleAgents.length === 0;
  // ADR-199 Decision 18: this provider reports a sub-agent only once it settled,
  // so its rows are finished ones and the card says so instead of implying life.
  const shownWhenFinished = Boolean(progress?.subagentsWhenFinished) && (progress?.agents.length ?? 0) > 0;

  // ── القيم المشتقة ──────────────────────────────────────────────────────────
  const isFrozenLoading = isLoading && frozen;
  const actionWords = ACTION_KEYS.map((key, i) =>
    t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }),
  );
  // Idle coordinator + rows on screen = the rows belong to a background workflow.
  // Cycling "Thinking…/Analyzing…" here would assert the assistant is working on
  // the user's turn when it is not; the label names what is actually running.
  const backgroundOnly = !isLoading && agents.length > 0;
  // The verdict, when the server gave one. `workflowStatus.labelKey` already
  // distinguishes running / unknown / frozen / the three orphan shapes, so this
  // line can no longer assert life the server would not assert. It falls back to
  // the old wording ONLY when no descriptor arrived (a workflow-less card, or a
  // caller that has not been wired yet) — never to paper over `unknown`.
  const backgroundText = (): string => {
    if (hasWorkflowRows) {
      return workflowStatus
        ? tCommon(workflowStatus.labelKey)
        : t('agentActivity.backgroundWorkflow', { defaultValue: 'Background workflow running' });
    }
    // Registry rows only (ADR-218): agents of an earlier turn, not a workflow.
    return agents.some((a) => rowOutcome(a) === 'running')
      ? t('agentActivity.backgroundAgents', { defaultValue: 'Background agents running' })
      : t('agentActivity.backgroundAgentsEnded', { defaultValue: 'Background agents finished' });
  };
  const statusText = isFrozenLoading
    ? t('claudeStatus.frozen', { defaultValue: 'Paused (process frozen)' })
    : backgroundOnly
      ? backgroundText()
      : stripTrailingEllipsis(
          status?.text
            ? localizeStatusText(status.text, t)
            : actionWords[Math.floor(elapsedTime / 3) % actionWords.length],
        );

  const providerLabel = t(
    PROVIDER_LABEL_KEYS[provider] || 'claudeStatus.providers.assistant',
    { defaultValue: 'Assistant' },
  );

  const showProgressArea = isLoading && !frozen;
  const showTaskCounter = showProgressArea && total > 0;
  // Overall percent: TodoWrite-computed (inside the Tasks chip), else declared by
  // the coordinator, else the agents' average (only when every agent has a value).
  const overall = showProgressArea && progress ? resolveOverallPercent(progress) : null;
  const canInterrupt = isConfirmedStarter && isLoading && status?.can_interrupt !== false && !!onAbort;

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

  // نصّ المؤشّر الموحّد مفصَّلاً بالنتيجة: «N نجحوا · K فشل · M يعمل».
  const countsLabel = agentCountsLabel(t, locale, outcomeCounts);

  // ── عرض البطاقة الموحّدة ──────────────────────────────────────────────────
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 mb-3 w-full duration-500">
      <div
        className={[
          'mx-auto max-w-4xl overflow-hidden border border-border/50',
          'bg-muted shadow-sm backdrop-blur-md',
          isExpanded ? 'rounded-2xl' : 'rounded-full',
          'transition-[border-radius] duration-150',
        ].join(' ')}
      >
        {/* ── صف الرأس ─────────────────────────────────────────────────────── */}
        {/* النقر على الصف (باستثناء أزرار مستقلة) يُطوي/يُوسِّع البطاقة.
            لا نحوّله إلى <button> لأنه يحوي أزرار تفاعلية (no nested interactive).
            نتجاهل النقر إذا كان المستخدم يُحدّد نصاً (سحب للنسخ). */}
        <div
          className="flex cursor-pointer items-center gap-2 px-3 py-1.5"
          onClick={() => {
            if (window.getSelection()?.toString()) return;
            toggle();
          }}
        >

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
            {/* اسم بادئ الدور لغير البادئ فقط (T-1904)؛ اسم المزوّد للبادئ يكرّر الشعار
                فحُذف. قطعة مشتركة مع ClaudeStatus (RunStatusViewerActions.tsx). */}
            {isViewer && viewerStarterName && (
              <RunStatusIdentityLabel
                isViewer={isViewer}
                viewerStarterName={viewerStarterName}
                providerLabel={providerLabel}
              />
            )}
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
              <p
                className="truncate text-xs font-medium text-foreground"
                // The label is three words; the hint is where "neither confirmed
                // alive nor dead" actually gets explained. Same string the
                // sidebar badge shows, so hovering either teaches the same thing.
                title={workflowStatus ? tCommon(workflowStatus.hintKey) : undefined}
              >
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
              {overall && (
                <span className="shrink-0 tabular-nums" data-testid="tasks-percent">
                  {formatPercent(overall.percent, locale)}
                </span>
              )}
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

          {/* النسبة الكلية المعلنة من الوكيل (بلا قائمة مهام) — لا تُعرض أبداً كـ0% مختلقة */}
          {overall && (
            <PercentMeter
              testId="overall-percent"
              percent={overall.percent}
              declared={overall.source !== 'tasks'}
              label={t('runProgress.overallAria', { defaultValue: 'Overall progress' })}
              barFromSm
              // With a todo list the desktop percent rides inside the Tasks chip
              // (sm+ only); this standalone chip then serves narrow screens.
              className={cn('bg-muted/50', overall.source === 'tasks' && 'sm:hidden')}
            />
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

          {/* مدة التشغيل الجاري مستقلة عن قابلية الإيقاف وعن إجمالي مدد الردود
              المكتملة. تظهر أيضاً في العرض الضيق ما دامت مرساة التشغيل صادقة. */}
          {isLoading && anchorResolved && (
            <div
              data-testid="current-run-elapsed"
              className={[
                'flex shrink-0 items-center rounded-md bg-muted/50 px-2 py-0.5',
                'text-[10px] font-medium tabular-nums text-muted-foreground',
              ].join(' ')}
            >
              {formatWorkDuration(
                elapsedTime * 1_000,
                locale.startsWith('ar') ? 'ar' : 'en',
              )}
            </div>
          )}

          {/* مؤشّر وكلاء واحد بصيغة «N منتهٍ · M يعمل» بدل شارتين بصيغة x/N
              متطابقة. حين لا يوجد منتهٍ يظهر «يعمل» وحده كنصّ، وإلا يحمله زر
              التبديل أدناه. */}
          {countsLabel && completedCount === 0 && (
            <span
              data-testid="agent-counts-text"
              className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/60"
            >
              {countsLabel}
            </span>
          )}

          {/* تبديل إخفاء/إظهار المكتمل — مستقلّ لا يُطلق toggle البطاقة.
              يظهر فقط حين توجد صفوف مكتملة فعلاً؛ لا فائدة من زر بلا أثر.
              أيقونة + شارة عدد بدل النصّ الطويل (كان يُزاحم الشريط)؛ نفس
              نصوص aria/title المترجمة (ar/en) محفوظة لقارئ الشاشة والتلميح. */}
          {completedCount > 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleHideCompleted(); }}
              aria-pressed={hideCompleted}
              title={
                hideCompleted
                  ? t('agentActivity.showCompleted', {
                      count: completedCount,
                      defaultValue: 'Show completed ({{count}})',
                    })
                  : t('agentActivity.hideCompleted', {
                      defaultValue: 'Hide completed',
                    })
              }
              aria-label={
                hideCompleted
                  ? t('agentActivity.showCompletedAria', {
                      defaultValue: 'Show completed agents',
                    })
                  : t('agentActivity.hideCompletedAria', {
                      defaultValue: 'Hide completed agents',
                    })
              }
              className={cn(
                'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5',
                'text-[10px] font-medium tabular-nums transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                hideCompleted
                  ? 'bg-muted/50 text-muted-foreground hover:bg-muted/70'
                  : 'bg-primary/15 text-primary hover:bg-primary/25',
              )}
            >
              <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span data-testid="agent-counts-chip">{countsLabel}</span>
            </button>
          )}

          {/* زر chevron الطيّ — عنصر تفاعلي مستقل.
              stopPropagation يمنع الحدث من الوصول إلى الصف الأب فيُطلق toggle مرتين. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggle(); }}
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

          {/* زر الإجراء الوحيد — STOP للبادئ أو التوجيه لغير البادئ، مستقلّ لا
              يُطلق toggle. قطعة مشتركة مع ClaudeStatus (RunStatusViewerActions.tsx):
              لا مسار يُظهر STOP لغير البادئ، بصرف النظر عن canInterrupt.
              آخر عنصر في الصفّ عمداً (ms-auto) — أقصى اليسار في RTL، بعيداً عن
              أزرار الطيّ/الإخفاء كي لا يُضغط بالخطأ (طلب المالك 2026-10-02). */}
          <RunStatusSteerHint show={showSteerHint} t={t} onSteerClick={onSteerClick} />
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            <RunStatusActions
              canStop={canInterrupt}
              onAbort={onAbort}
              steerable={steerable}
              onSteerClick={onSteerClick}
              t={t}
              isArabic={Boolean(i18n.language?.startsWith('ar'))}
            />
          </div>
        </div>

        {/* ── صفوف الوكلاء (قابلة للطيّ) ───────────────────────────────────── */}
        {isExpanded && (
          <div className="border-t border-border/30 px-3 py-1.5">
            {shownWhenFinished && (
              <p
                className="px-1.5 pb-0.5 text-[10px] text-muted-foreground/70"
                data-testid="agents-shown-when-finished"
              >
                {t('agentActivity.shownWhenFinished', { defaultValue: 'Shown when finished' })}
              </p>
            )}
            {allHiddenAsCompleted ? (
              <p className="px-1.5 py-1 text-[11px] text-muted-foreground/70">
                {t('agentActivity.allCompletedSummary', {
                  count: completedCount,
                  defaultValue: '{{count}} completed',
                })}
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {visibleAgents.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} frozen={frozen} />
                ))}
              </div>
            )}
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
const NO_WORKFLOW_AGENTS: RunAgent[] = [];
const NO_SESSION_AGENTS: SessionAgentRow[] = [];

/**
 * Clock for the registry's "recently ended" window: re-renders once when the
 * next ended registry-only row is due to leave, never on a tick.
 */
function useRegistryClock(sessionAgents: readonly SessionAgentRow[]): number {
  const [tick, setTick] = useState(0);
  // Read the clock when the rows change or the scheduled expiry fires — never per second.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [sessionAgents, tick]);
  useEffect(() => {
    const expiry = nextRegistryExpiry(sessionAgents, now);
    if (expiry === null) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), expiry - now + 50);
    return () => clearTimeout(timer);
  }, [sessionAgents, now]);
  return now;
}

export default function AgentStatusCard(props: AgentStatusCardProps) {
  const workflowAgents = props.workflowAgents ?? NO_WORKFLOW_AGENTS;
  const sessionAgents = props.sessionAgents ?? NO_SESSION_AGENTS;
  const now = useRegistryClock(sessionAgents);
  // Reply-scoped rows first (they belong to what is happening right now), then
  // agents of earlier turns the registry knows, then the workflow rows.
  const allAgents = useMemo(
    () => mergeSessionAgents(props.agents, workflowAgents, sessionAgents, now),
    [props.agents, workflowAgents, sessionAgents, now],
  );
  const hasWorkflowRows = workflowAgents.length > 0
    || allAgents.some((a) => sessionAgents.some((row) => row.key === a.id && row.source === 'workflow'));

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
        viewerStarterName={props.viewerStarterName}
        steerable={props.steerable}
        onSteerClick={props.onSteerClick}
        runActiveOverride={props.runActiveOverride}
        isConfirmedStarter={props.isConfirmedStarter}
        showSteerHint={props.showSteerHint}
      />
    );
  }

  // A workflow outlives the reply that launched it, so its rows must render even
  // when the coordinator is idle. In that state the card is informational only:
  // `isLoading` stays false, which already suppresses the elapsed timer, the
  // animated dots and the STOP button (STOP aborts the SESSION — it cannot stop a
  // detached workflow, so offering it here would be a false promise).
  return <MergedCard {...props} agents={allAgents} hasWorkflowRows={hasWorkflowRows} />;
}
