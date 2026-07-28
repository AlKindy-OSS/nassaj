import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { RunProgress } from '../../hooks/useRunProgress';

type ClaudeStatusProps = {
  status: {
    text?: string;
    tokens?: number;
    can_interrupt?: boolean;
  } | null;
  onAbort?: () => void;
  isLoading: boolean;
  /**
   * True while the session's provider process is externally frozen
   * (kill -STOP). Pauses the spinner animation and elapsed/dots timers and
   * shows a static amber indicator instead of an endless "working" pulse.
   */
  frozen?: boolean;
  provider?: string;
  /**
   * Epoch-ms timestamp of the user message that started the current run.
   * Used only to *seed* the run anchor (below) so a page refresh / re-attach
   * resumes the elapsed counter at its true value instead of restarting at 0.
   * NOT read on every tick.
   */
  runStartedAt?: number | null;
  /**
   * Compact task/agent progress snapshot derived once per transcript change in
   * `useRunProgress` (ChatInterface). When omitted or empty, ClaudeStatus
   * behaves exactly as before (elapsed + status only). Never recomputed here.
   */
  progress?: RunProgress | null;
  /**
   * When true, hide ONLY the rotating action word (the "Thinking…/Working…"
   * line and its animated dots). Everything else — the STOP button, ESC hint,
   * elapsed timer, task counter/bar and the spinner — stays exactly as is. Set
   * by ChatComposer when the AgentActivityStrip is shown above this row (the
   * strip already conveys "working", so the duplicated spinning word is dropped
   * to avoid two competing activity labels). Defaults to false → no change.
   */
  suppressActionWord?: boolean;
};

const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
const DEFAULT_ACTION_WORDS = ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'];

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

// --- Time-estimate tuning (see task spec §2) ----------------------------------------
// EMA smoothing factor for the raw per-tick estimate. Lower = smoother/slower.
const EMA_ALPHA = 0.25;
// Suppress the estimate until the run has real signal: at least one completed
// task AND enough wall-clock that ratio isn't wildly noisy.
const MIN_DONE_FOR_ESTIMATE = 1;
const MIN_ELAPSED_SECONDS_FOR_ESTIMATE = 15;
// ------------------------------------------------------------------------------------

function formatElapsedTime(totalSeconds: number) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return mins < 1 ? `${secs}s` : `${mins}m ${secs}s`;
}

export default function ClaudeStatus({
  status,
  onAbort,
  isLoading,
  frozen = false,
  provider = 'claude',
  runStartedAt = null,
  progress = null,
  suppressActionWord = false,
}: ClaudeStatusProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const [elapsedTime, setElapsedTime] = useState(0);
  const [dots, setDots] = useState('');

  // --- Run anchor (task spec §4, critical C1) ---------------------------------------
  // We must NOT base elapsed/estimate on `runStartedAt` directly: it is derived
  // from the last type:'user' message, and coordinator→sub-agent prompts are
  // rewritten as type:'user', so `runStartedAt` jumps forward every time an
  // agent is launched → elapsed collapses to ~0 and the estimate explodes.
  //
  // Instead we pin an anchor at the false→true transition of isLoading and hold
  // it until the run ends (!isLoading). `runStartedAt` is used only to *seed*
  // the anchor (so refresh-into-running resumes at the true elapsed); once the
  // run is live the anchor never moves.
  const runAnchorRef = useRef<number | null>(null);
  // True while the anchor still holds a mount-time fallback (Date.now()) rather
  // than a real run-start timestamp, so we can upgrade it once `runStartedAt`
  // resolves shortly after a refresh — mirrors the previous fallbackStartRef.
  const anchorIsFallbackRef = useRef(false);
  /**
   * نسخة state من `anchorIsFallbackRef` (الـref لا يُعيد الرسم).
   *
   * B-208 (بند 8 — فيتو): بعد تحديث الصفحة قد يقع آخر صفّ مستخدم خارج نافذة
   * الجلب فيعود `runStartedAt = null`؛ كان المؤقّت حينها يبدأ من الآن فيعرض
   * «0:03» لتشغيل عمره 20 دقيقة. يُخفى المؤقّت حتى تُحلّ المرساة الحقيقية.
   */
  const [anchorResolved, setAnchorResolved] = useState(false);

  // --- Estimate state (task spec §2) ------------------------------------------------
  // Kept in refs so the per-second tick can update them without re-rendering on
  // every internal step; we surface the displayed estimate via state.
  const emaEstRef = useRef<number | null>(null);
  const prevDisplayedEstRef = useRef<number | null>(null);
  const [displayedEst, setDisplayedEst] = useState<number | null>(null);

  // Latest ratio snapshot fed to the tick. Refs (not deps) so changing progress
  // does not re-arm the interval; the running tick reads the freshest value.
  const ratioRef = useRef(0);
  const doneRef = useRef(0);
  // Previous `total` within the live run, to detect a mid-run *plan growth*
  // (e.g. 3/3 → 1/10). On growth we reseed the estimate smoothing so the
  // monotonic-down clamp doesn't pin the estimate to the old, smaller scope.
  // null = no run total observed yet this run (reset on run end / new run).
  const prevTotalRef = useRef<number | null>(null);

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const inProgress = progress?.inProgress ?? 0;
  const activeSubagent = progress?.activeSubagent ?? null;
  const agentsTotal = progress?.agentsTotal ?? 0;
  const agentsDone = progress?.agentsDone ?? 0;

  // Bar ratio reflects the *truth* (no monotonic clamp): half-credit for the
  // in-progress task. Estimate ratio uses completed-only.
  const barRatio = total > 0 ? Math.min(1, (done + 0.5 * inProgress) / total) : 0;
  const estimateRatio = total > 0 && done >= 1 ? done / total : 0;

  // Push the freshest ratio/done into refs for the tick (no interval re-arm).
  ratioRef.current = estimateRatio;
  doneRef.current = done;

  // Reset all estimate/anchor state when the run ends. Also reset when the
  // anchor identity changes (new run) — handled by the false→true seed below.
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

    // Seed the anchor on the false→true edge (or on mount into a running run).
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
      // Fresh run → discard any stale estimate history so it can't leak across
      // runs and so the next computation is a clean cold start.
      emaEstRef.current = null;
      prevDisplayedEstRef.current = null;
      prevTotalRef.current = null;
      setDisplayedEst(null);
    } else if (
      anchorIsFallbackRef.current &&
      typeof runStartedAt === 'number' &&
      Number.isFinite(runStartedAt)
    ) {
      // Upgrade a mount-time fallback to the real start once it resolves (e.g.
      // messages finished loading just after a refresh). Only ever moves the
      // anchor *earlier*, never forward mid-run.
      runAnchorRef.current = Math.min(runAnchorRef.current, runStartedAt);
      anchorIsFallbackRef.current = false;
      setAnchorResolved(true);
    }

    // Frozen process: nothing is advancing, so pause the timers (elapsed
    // display keeps its last value; the dots animation stops).
    if (frozen) {
      return;
    }

    const tick = () => {
      const anchor = runAnchorRef.current ?? Date.now();
      const elapsed = Math.max(0, Math.floor((Date.now() - anchor) / 1000));
      setElapsedTime(elapsed);

      // --- Time estimate ----------------------------------------------------
      // FIX 4: while the anchor is still a mount-time fallback (real run-start
      // not yet resolved after a refresh), `elapsed` is measured from ~now and
      // is bogusly small — any estimate off it would jump (e.g. 0s → 3m12s) the
      // instant the real anchor lands. Suppress the estimate until the real
      // start arrives; elapsed display itself is left alone.
      if (anchorIsFallbackRef.current) {
        setDisplayedEst(null);
        return;
      }

      const ratio = ratioRef.current;
      const enoughSignal =
        doneRef.current >= MIN_DONE_FOR_ESTIMATE && elapsed >= MIN_ELAPSED_SECONDS_FOR_ESTIMATE;

      if (!enoughSignal || ratio <= 0) {
        // Not enough to estimate yet — show the early-suppression placeholder.
        setDisplayedEst(null);
        return;
      }

      const rawEst = Math.max(0, elapsed / ratio - elapsed);

      // EMA. Cold start (no history, e.g. first tick after resume OR after a
      // mid-run plan-growth reseed): start at the raw value directly so there's
      // no spurious ramp from 0 and the new, larger scope is reflected at once.
      const prevEma = emaEstRef.current;
      const ema = prevEma === null ? rawEst : EMA_ALPHA * rawEst + (1 - EMA_ALPHA) * prevEma;
      emaEstRef.current = ema;

      // Monotonic-down clamp on the *displayed* estimate: never rises while the
      // plan stays the same size. Reset happens on a new run (anchor reseed
      // above) and on a confirmed mid-run plan growth (FIX 3 effect below),
      // both of which null `prevDisplayedEstRef` so the estimate may rise once.
      const prevDisplayed = prevDisplayedEstRef.current;
      const nextDisplayed = prevDisplayed === null ? ema : Math.min(ema, prevDisplayed);
      prevDisplayedEstRef.current = nextDisplayed;
      setDisplayedEst(nextDisplayed);
    };

    // Run immediately so a refreshed page shows the real elapsed time at once
    // instead of starting from 0 until the first interval fires.
    tick();
    const timer = setInterval(tick, 1000);
    const dotTimer = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);

    return () => {
      clearInterval(timer);
      clearInterval(dotTimer);
    };
    // runStartedAt is included so a late-arriving real start can upgrade the
    // fallback anchor; the interval body itself reads ratio/done from refs and
    // is unaffected by progress changes.
  }, [isLoading, frozen, runStartedAt]);

  // --- FIX 3: reset the estimate smoothing on mid-run plan GROWTH -------------
  // The monotonic-down clamp keeps the displayed estimate from ever rising
  // within a run. That is correct while the plan size is stable, but wrong when
  // a *longer* TodoWrite list appears mid-run (e.g. 3/3 → 1/10): the clamp would
  // pin the estimate to the old, smaller scope and read falsely low. On a
  // confirmed increase in `total` we treat it as a smoothing reset point only:
  // null the EMA and the displayed clamp so the next tick re-seeds from a fresh
  // rawEst and the estimate is allowed to climb to the larger scope. Crucially
  // we do NOT touch the run anchor — elapsed keeps counting. A *decrease* in
  // `total` (completion/removal) is left to the clamp so the estimate falls
  // monotonically and does not oscillate upward.
  useEffect(() => {
    if (!isLoading) return; // run-end reset is handled by the main effect.
    const prev = prevTotalRef.current;
    prevTotalRef.current = total;
    if (prev !== null && total > prev) {
      emaEstRef.current = null;
      prevDisplayedEstRef.current = null;
      setDisplayedEst(null);
    }
  }, [total, isLoading]);

  if (!isLoading && !status) return null;

  const isFrozenLoading = isLoading && frozen;
  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  const statusText = isFrozenLoading
    ? t('claudeStatus.frozen', { defaultValue: 'Paused (process frozen)' })
    : (status?.text || actionWords[Math.floor(elapsedTime / 3) % actionWords.length]).replace(/[.]+$/, '');
  // Hide only the rotating action word (+ its dots) when the AgentActivityStrip
  // above already conveys "working". The frozen "Paused" state is NOT a rotating
  // word but a real status, so it is always kept so the user still sees the
  // process is halted even while sub-agents are listed above.
  const showActionWordLine = !suppressActionWord || isFrozenLoading;

  const providerLabel = t(PROVIDER_LABEL_KEYS[provider] || 'claudeStatus.providers.assistant', { defaultValue: 'Assistant' });

  // --- Progress indicators visibility (task spec §1, §5) ----------------------------
  // Authority for "are we still working" is `isLoading` (NOT aggregated tool
  // completion). Indicators show only while loading and not frozen, and are
  // INDEPENDENT of the can_interrupt / STOP-button block.
  const showProgressArea = isLoading && !frozen;
  // A real TodoWrite list → counter + bar. The task counter and the active-agent
  // chip are now INDEPENDENT (FIX 2): the pulsing "agent working" chip shows
  // whenever a sub-agent is running, with OR without a todo list, so the
  // reassuring live pulse never disappears just because todos exist. When both
  // are present they render side by side; when there are no todos the chip
  // stands alone.
  const showTaskCounter = showProgressArea && total > 0;
  const showAgentChip = showProgressArea && activeSubagent !== null;

  const localeNum = (n: number) => n.toLocaleString(locale);

  // Tooltip for the task counter: completed/total + in-progress + sub-agent
  // breakdown (agents never enter the fraction; they live here only).
  const counterTooltipLines = [
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
    agentsTotal > 0
      ? t('runProgress.agentsTooltip', {
          done: localeNum(agentsDone),
          total: localeNum(agentsTotal),
          defaultValue: 'Sub-agents: {{done}}/{{total}}',
        })
      : null,
    activeSubagent
      ? t('runProgress.agentWorkingTooltip', {
          calls: localeNum(activeSubagent.callCount),
          defaultValue: 'Agent working: {{calls}} calls',
        })
      : null,
  ].filter(Boolean) as string[];

  // Localized "Xm Ys" / "Ys" for the estimate, reusing the existing elapsed
  // keys so Arabic renders "٦د ٣٠ث" rather than the literal English "6m 30s".
  const formatLocalizedDuration = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return mins < 1
      ? t('claudeStatus.elapsed.seconds', { count: secs, defaultValue: '{{count}}s' })
      : t('claudeStatus.elapsed.minutesSeconds', {
          minutes: mins,
          seconds: secs,
          defaultValue: '{{minutes}}m {{seconds}}s',
        });
  };

  const estimateReady = displayedEst !== null && Number.isFinite(displayedEst);
  const estimateText = estimateReady
    ? t('runProgress.estimateRemaining', {
        time: formatLocalizedDuration(Math.round(displayedEst as number)),
        defaultValue: '≈ {{time}} left',
      })
    : t('runProgress.estimating', { defaultValue: '…' });
  const estimateTooltip = t('runProgress.estimateTooltip', {
    defaultValue: 'Rough estimate — based on completed tasks so far.',
  });

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 mb-3 w-full duration-500">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 overflow-hidden rounded-full border border-border/50 bg-slate-100 px-3 py-1.5 shadow-sm backdrop-blur-md dark:bg-slate-900">

        {/* Left Side: Identity & Status */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 ring-1 ring-primary/10">
            <SessionProviderLogo provider={provider} className="h-3.5 w-3.5" />
            {isLoading && !frozen && (
              <span className="absolute inset-0 animate-pulse rounded-full ring-2 ring-emerald-500/20" />
            )}
          </div>

          <div className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
            {/* اسم المزوّد مُترجَم (عربي في الواجهة العربية): لا `tracking-*`
                عليه — التباعد الحرفي يكسر التحام الحروف العربية. */}
            <span className="text-[10px] font-bold uppercase text-muted-foreground/70">
              {providerLabel}
            </span>
            {showActionWordLine && (
              <div className="flex items-center gap-1.5">
                <span className={cn("h-1.5 w-1.5 rounded-full", isLoading && !frozen ? "bg-emerald-500 animate-pulse" : "bg-amber-500")} />
                <p className="truncate text-xs font-medium text-foreground">
                  {statusText}<span className="inline-block w-4 text-primary">{isLoading && !frozen ? dots : ''}</span>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Metrics & Actions */}
        <div className="flex items-center gap-2">
          {/* Run progress: task counter (with thin bar) OR sub-agent-only chip.
              Independent of the STOP block so it shows even when interruption
              is unavailable. */}
          {showTaskCounter && (
            <div
              className="hidden min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:flex"
              title={counterTooltipLines.join('\n')}
            >
              <span className="shrink-0 tabular-nums">
                {t('runProgress.tasksLabel', { defaultValue: 'Tasks' })} {localeNum(done)}/{localeNum(total)}
              </span>
              {/* Thin progress bar. Flex/`w` fill mirrors automatically under RTL. */}
              <div
                className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border/60"
                role="progressbar"
                aria-valuenow={Math.round(barRatio * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('runProgress.barAria', { defaultValue: 'Task progress' })}
              >
                <div
                  className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
                  style={{ width: `${barRatio * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Active sub-agent pulse. Shows whenever a sub-agent is running,
              independent of the task counter (FIX 2) — side by side with the
              counter when todos exist, standalone otherwise. Stays terse on
              narrow screens: a pulsing dot + the call count. The agents
              done/total breakdown lives in the task counter's tooltip. */}
          {showAgentChip && (
            <div
              className="hidden min-w-0 items-center gap-1.5 rounded-md bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground sm:flex"
              title={t('runProgress.agentWorkingTooltip', {
                calls: localeNum(activeSubagent.callCount),
                defaultValue: 'Agent working: {{calls}} calls',
              })}
            >
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-500" />
              <span className="shrink-0 tabular-nums">
                {t('runProgress.agentWorking', {
                  calls: localeNum(activeSubagent.callCount),
                  defaultValue: 'Agent · {{calls}}',
                })}
              </span>
            </div>
          )}

          {/* Time estimate — only meaningful with a task fraction. Hidden on
              narrow screens (behaves like elapsed: detail lives in tooltip). */}
          {showTaskCounter && (
            <div
              className="hidden items-center rounded-md bg-muted/50 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground sm:flex"
              title={estimateTooltip}
            >
              {estimateText}
            </div>
          )}

          {isLoading && status?.can_interrupt !== false && onAbort && (
            <>
              {/* المؤقّت يظهر فقط مع مرساة تشغيل حقيقية — لا عدّ من صفر (بند 8). */}
              {anchorResolved && (
                <div className="hidden items-center rounded-md bg-muted/50 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground sm:flex">
                  {formatElapsedTime(elapsedTime)}
                </div>
              )}

              <button
                type="button"
                onClick={onAbort}
                className="group flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-[10px] font-bold text-destructive transition-all hover:bg-destructive hover:text-destructive-foreground"
              >
                <svg className="h-3 w-3 fill-current" viewBox="0 0 24 24">
                  <path d="M6 6h12v12H6z" />
                </svg>
                <span className="hidden sm:inline">STOP</span>
                <kbd className="hidden rounded bg-black/10 px-1 text-[9px] group-hover:bg-white/20 sm:block">
                  ESC
                </kbd>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
