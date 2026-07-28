import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../../../../shared/view/ui';
import type { RunAgent } from '../../hooks/useRunProgress';

/**
 * AgentActivityStrip — a compact panel shown above the composer while one or
 * more sub-agents are delegated during a run. One row per delegated agent:
 *   [status dot] type · description    [current tool]    [×N calls]
 *
 * It REPLACES the ClaudeStatus spinner only when `agents.length > 0`; otherwise
 * ChatComposer renders the unchanged ClaudeStatus (the no-agents path is not
 * touched). Visual language mirrors ClaudeStatus: the same rounded pill, slate
 * surface, border, emerald "live" pulse for running and a green ✓ for done.
 *
 * RTL/themes: layout is purely logical (flex + gap, `ms-`/`me-` only, no
 * left/right), so it mirrors automatically under `dir="rtl"`; colors use the
 * shared theme tokens (muted/foreground/border) and explicit dark: variants,
 * matching ClaudeStatus.
 *
 * Expansion-ready (NOT built yet, per spec): each row is a Collapsible whose
 * trigger is the whole row (clickable, keyboard-focusable, aria-expanded wired
 * by the primitive) and whose CollapsibleContent is a details slot — collapsed
 * by default — reserved for a future per-agent tool history. The content is
 * intentionally a minimal placeholder today so the structure already supports a
 * click-to-expand without a later refactor.
 */

type AgentActivityStripProps = {
  agents: RunAgent[];
  /**
   * True while the provider process is externally frozen (kill -STOP). Pauses
   * the running pulse so we don't imply live progress on a halted process —
   * mirrors ClaudeStatus's frozen handling.
   */
  frozen?: boolean;
};

function AgentRow({ agent, frozen }: { agent: RunAgent; frozen: boolean }) {
  const { t, i18n } = useTranslation('chat');
  const localeNum = (n: number) => n.toLocaleString(i18n.language);
  const running = agent.status === 'running';
  const pulse = running && !frozen;
  // Unique, HTML-valid id per row so the trigger's `aria-controls` points at its
  // own details panel (assistive tech announces the expandable relationship).
  const contentId = useId();

  const statusLabel = running
    ? t('agentActivity.running', { defaultValue: 'Running' })
    : t('agentActivity.done', { defaultValue: 'Done' });

  return (
    <Collapsible className="group/agent">
      <CollapsibleTrigger
        aria-controls={contentId}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        aria-label={t('agentActivity.rowAria', {
          type: agent.type,
          status: statusLabel,
          defaultValue: '{{type}} — {{status}}',
        })}
      >
        {/* Status dot: emerald pulse while running, solid green when done. */}
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
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}

        {/* Agent identity: type (identifier, never translated) + optional description. */}
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {agent.type}
          {agent.description && (
            <span className="text-muted-foreground/80">
              {' · '}
              {agent.description}
            </span>
          )}
        </span>

        {/* Current tool (running only). Mono, ellipsized; pushed to the inline-end. */}
        {running && agent.currentTool && (
          <span className="ms-auto hidden shrink-0 items-center gap-1 text-[10px] text-muted-foreground sm:flex">
            <span className="text-muted-foreground/50">{t('agentActivity.currently', { defaultValue: 'now' })}</span>
            <span className="max-w-32 truncate font-mono text-foreground/90">{agent.currentTool}</span>
          </span>
        )}

        {/* Call counter. `ms-auto` when no current-tool block claimed it. */}
        <span
          className={cn(
            'shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground',
            !(running && agent.currentTool) && 'ms-auto',
          )}
          title={t('agentActivity.callsTooltip', {
            calls: localeNum(agent.callCount),
            defaultValue: '{{calls}} tool calls',
          })}
        >
          {t('agentActivity.calls', { calls: localeNum(agent.callCount), defaultValue: '{{calls}}' })}
        </span>

        {/* Disclosure chevron — rotates when the (future) details panel opens. */}
        <svg
          className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-data-[state=open]/agent:rotate-90 rtl:rotate-180 rtl:group-data-[state=open]/agent:rotate-90"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </CollapsibleTrigger>

      {/* Tool history panel — expanded on click. Lists every child tool call with
          its name and success/running status. Scrollable when the list is long. */}
      <CollapsibleContent id={contentId}>
        <div className="ms-3 mt-0.5 border-s border-border ps-3">
          {!agent.childTools || agent.childTools.length === 0 ? (
            <p className="py-1 text-[11px] text-muted-foreground/70">
              {t('agentActivity.noTools', { defaultValue: 'No tool calls recorded yet.' })}
            </p>
          ) : (
            <ul
              className="max-h-48 overflow-y-auto py-0.5"
              aria-label={t('agentActivity.rowAria', {
                type: agent.type,
                status: running
                  ? t('agentActivity.running', { defaultValue: 'Running' })
                  : t('agentActivity.done', { defaultValue: 'Done' }),
                defaultValue: '{{type}} — {{status}}',
              })}
            >
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
                        aria-label={t('agentActivity.toolSuccess', { defaultValue: 'Done' })}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                        aria-label={t('agentActivity.toolRunning', { defaultValue: 'Running' })}
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate font-mono text-foreground/80">{tool.toolName}</span>
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

const AGENT_ACTIVITY_STORAGE_KEY = 'nassaj-agent-activity-expanded';

export default function AgentActivityStrip({ agents, frozen = false }: AgentActivityStripProps) {
  const { t } = useTranslation('chat');

  // Persisted collapse preference: default expanded, survives refresh and sessions.
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(AGENT_ACTIVITY_STORAGE_KEY);
      return stored !== null ? stored !== 'false' : true;
    } catch {
      return true;
    }
  });

  const toggle = useCallback(() => {
    setIsExpanded(prev => {
      const next = !prev;
      try { localStorage.setItem(AGENT_ACTIVITY_STORAGE_KEY, String(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  if (agents.length === 0) return null;

  const runningCount = agents.reduce((n, a) => (a.status === 'running' ? n + 1 : n), 0);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 mb-3 w-full duration-500">
      <div className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-border/50 bg-slate-100 px-3 py-2 shadow-sm backdrop-blur-md dark:bg-slate-900">
        {/* Header: full-width clickable button. Title + counter always visible.
            Collapses the agent list to a single header row on narrow screens. */}
        <button
          type="button"
          className="mb-1 flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          onClick={toggle}
          aria-expanded={isExpanded}
        >
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            {t('agentActivity.title', { defaultValue: 'Agent activity' })}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/60">
              {t('agentActivity.summary', {
                running: runningCount,
                total: agents.length,
                defaultValue: '{{running}}/{{total}} running',
              })}
            </span>
            {/* Chevron: ▼ when expanded, ▶ LTR / ◀ RTL when collapsed. */}
            <svg
              className={cn(
                'h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform duration-150',
                isExpanded ? 'rotate-0' : '-rotate-90 rtl:rotate-90',
              )}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>

        {isExpanded && (
          <div className="flex flex-col gap-0.5">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} frozen={frozen} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
