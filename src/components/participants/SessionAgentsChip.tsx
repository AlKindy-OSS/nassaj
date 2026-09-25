import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Wrench, XIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import SessionProviderLogo from '../llm-logo-provider/SessionProviderLogo';
import {
  resolveAnchoredPlacement,
  type AnchoredPlacement,
} from '../chat/view/subcomponents/anchoredPopover';

import type { SessionAgent } from './types';
import type { SessionSkillsState } from './useSessionSkills';
import { SessionSkillsSection } from './ObservedSkills';
import { PROVIDER_DISPLAY_NAME, summarizeAgents, type SessionAgentLike } from './utils';

/** Harness ids that carry a real brand mark; anything else falls back to text. */
const HARNESS_DISPLAY_NAME: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  kimi: 'Kimi CLI',
  hermes: 'Hermes',
});

type SessionAgentsChipProps = {
  agents: SessionAgent[];
  /**
   * `sessions.provider` — the CLI the turns ran under. Kept in the detail panel:
   * the same model behaves differently under Claude Code, Codex and OpenCode.
   */
  harness?: string | null;
  t: TFunction;
  dir: 'rtl' | 'ltr';
  className?: string;
  skills?: SessionSkillsState;
};

function providerNameOf(agent: SessionAgentLike | null): string | null {
  if (!agent?.agent_provider) return null;
  return PROVIDER_DISPLAY_NAME[agent.agent_provider] ?? agent.agent_provider;
}

function harnessNameOf(harness: string | null | undefined): string | null {
  if (!harness) return null;
  return HARNESS_DISPLAY_NAME[harness] ?? harness;
}

/**
 * The detail panel: the full roster the header used to spell out inline.
 *
 * Rendered through a portal and pinned under its trigger, reusing the geometry
 * already proven for the cost popover — a panel that opens in the middle of the
 * screen severs the link between what was clicked and what appeared.
 */
function AgentsPanel({
  models,
  subagents,
  distinctSubagents,
  totalInvocations,
  currentModelName,
  harnessProvider,
  harnessName,
  t,
  dir,
  triggerRef,
  onClose,
  skills,
}: {
  models: SessionAgentLike[];
  subagents: SessionAgentLike[];
  /** Number of distinct subagent rows represented by the roster. */
  distinctSubagents: number;
  /** Sum over subagents — the figure the compact face has no room for. */
  totalInvocations: number;
  /** The model answering now — subagent rows hide a model equal to it. */
  currentModelName: string | null;
  /** Raw harness id, for the brand mark. */
  harnessProvider: string | null | undefined;
  /** Display name of the harness described in the panel. */
  harnessName: string | null;
  t: TFunction;
  dir: 'rtl' | 'ltr';
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  skills?: SessionSkillsState;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);

  useLayoutEffect(() => {
    const reposition = () => {
      const trigger = triggerRef.current;
      if (!trigger || typeof window === 'undefined') return;
      const rect = trigger.getBoundingClientRect();
      setPlacement(
        resolveAnchoredPlacement({
          trigger: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          measuredHeight: dialogRef.current?.offsetHeight ?? 0,
          preferredWidth: 400,
          isRtl: dir === 'rtl',
        }),
      );
    };

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [dir, triggerRef]);

  // Escape closes; Tab cycles WITHIN the panel. Without the trap, Tab walked
  // out of a dialog that still covers the screen and landed on controls the
  // reader cannot see — the classic keyboard-only trapdoor.
  useEffect(() => {
    const focusablesOf = (root: HTMLElement) =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const root = dialogRef.current;
      if (!root) return;
      const focusables = focusablesOf(root);
      // A panel whose only control is the close button still traps: the single
      // element is both edges, so Tab lands back on it instead of escaping.
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus enters the panel on open and RETURNS to the trigger on close. Without
  // the return, closing dropped focus onto document.body and the next Tab
  // restarted from the top of the page.
  useEffect(() => {
    const opener = triggerRef.current;
    dialogRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [triggerRef]);

  const handleOverlayPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  const title = skills ? t('skillObservations.panelTitle') : t('participants.agentsPanelTitle', { defaultValue: 'Conversation actors' });

  return createPortal(
    <div className="fixed inset-0 z-[9999]" onPointerDown={handleOverlayPointerDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        dir={dir}
        tabIndex={-1}
        style={
          placement
            ? {
                position: 'fixed',
                // design-ok: portal coordinates are necessarily physical — the
                // reasoning lives in anchoredPopover.ts, which resolves the
                // direction explicitly via isRtl.
                top: placement.top,
                bottom: placement.bottom,
                left: placement.left,
                right: placement.right,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }
            : { position: 'fixed', top: 16 }
        }
        className="overflow-y-auto rounded-xl border border-border/70 bg-background shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            {/* The mark on the trigger is a picture; this is the only place its
                name is spelled out, so a harness the reader does not recognise
                by logo is still identifiable. */}
            {harnessName && (
              <bdi className="break-words text-[11px] text-muted-foreground">
                {t('participants.harnessLine', {
                  harness: harnessName,
                  defaultValue: 'Harness: {{harness}}',
                })}
              </bdi>
            )}
          </span>
          <button
            type="button"
            aria-label={t('contextRot.close', { defaultValue: 'Close' })}
            onClick={onClose}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        {models.length > 0 && <div className="px-4 py-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t('participants.modelsSection', { defaultValue: 'Models' })}
          </p>
          <ul className="space-y-1" role="list">
            {models.map((model) => {
              const provider = providerNameOf(model);
              return (
                <li
                  key={`model:${model.agent_name}`}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 self-center"
                    aria-hidden
                  >
                    <SessionProviderLogo provider={harnessProvider} className="h-3.5 w-3.5" />
                  </span>
                  {/* A model id is a Latin string inside an Arabic panel: <bdi>
                      isolates it so it neither flips its neighbours nor gets
                      reordered itself. */}
                  <bdi className="min-w-0 flex-1 break-words font-mono text-foreground">
                    {model.agent_name}
                  </bdi>
                  {provider && (
                    <span className="shrink-0 text-muted-foreground/70">{provider}</span>
                  )}
                  <span className="shrink-0 text-muted-foreground/70">
                    {model.agent_name === currentModelName
                      ? t('participants.currentModel', { defaultValue: 'Current' })
                      : t('participants.earlierModel', { defaultValue: 'Earlier' })}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {t('participants.turns', {
                      count: model.invocation_count,
                      defaultValue: '{{count}} turns',
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>}

        {subagents.length > 0 && (
          <div className="border-t border-border/40 px-4 py-2">
            {/* The section heading carries the TOTAL. It is deliberately here
                and not on the trigger: the sum is the most volatile figure on
                the roster (it moves with every delegation mid-stream), and a
                number that twitches in a permanently-visible header is noise,
                while the same number inside a panel opened on purpose is an
                answer to a question just asked. */}
            <p className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs font-medium text-muted-foreground">
              <span>{t('participants.subagentsSection', { defaultValue: 'Subagents' })}</span>
              <span className="shrink-0 font-normal tabular-nums text-muted-foreground/80">
                {t('participants.agentSummary', {
                  count: distinctSubagents,
                  defaultValue_one: '{{count}} agent',
                  defaultValue_other: '{{count}} agents',
                })}
                <span aria-hidden className="px-1 opacity-40">·</span>
                {t('participants.totalInvocations', {
                  count: totalInvocations,
                  defaultValue: '{{count}} calls',
                })}
              </span>
            </p>
            <ul className="space-y-1" role="list">
              {subagents.map((agent) => (
                <li
                  key={`subagent:${agent.agent_name}`}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
                >
                  <Wrench
                    className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground"
                    aria-hidden
                  />
                  <bdi className="min-w-0 flex-1 break-words text-foreground">{agent.agent_name}</bdi>
                  {/* The model is shown only when it DIFFERS from the answering
                      model. Subagents usually inherit it, so printing it always
                      stacked four identical `claude-opus-5` columns whose only
                      real message — "this one ran on something else" — was the
                      one case it could no longer signal. */}
                  {agent.agent_model && agent.agent_model !== currentModelName && (
                    <bdi className="min-w-0 max-w-full break-words font-mono text-muted-foreground/70">
                      {agent.agent_model}
                    </bdi>
                  )}
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {t('participants.invocations', {
                      count: agent.invocation_count,
                      defaultValue: '{{count}} invocations',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {skills && <SessionSkillsSection state={skills} />}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The conversation's non-human actors, collapsed into one quiet control.
 *
 * The permanent face names only the model answering now. Harness, provider,
 * model history and delegation are diagnostic details: the panel keeps every
 * one of them, while the 44px bar no longer repeats them on every glance.
 */
export default function SessionAgentsChip({
  agents,
  harness,
  t,
  dir,
  className,
  skills,
}: SessionAgentsChipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const { models, subagents, current, distinctSubagents, totalInvocations } = summarizeAgents(agents);
  if (agents.length === 0 && !skills) return null;

  const harnessName = harnessNameOf(harness);

  const panelTitle = skills ? t('skillObservations.panelTitle') : t('participants.agentsPanelTitle', { defaultValue: 'Conversation actors' });
  const openDetailsLabel = t('participants.openAgentsDetails', {
    defaultValue: 'Open conversation actor details',
  });
  const face = current?.agent_name ?? t('participants.actorsFallback', { defaultValue: 'Actors' });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={openDetailsLabel}
        title={panelTitle}
        className={cn(
          'inline-flex min-h-7 min-w-0 flex-wrap items-center gap-1.5 rounded-lg bg-transparent px-2 text-xs text-muted-foreground transition-colors motion-reduce:transition-none hover:bg-accent/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'bg-accent/80 text-foreground',
          className,
        )}
      >
        <bdi dir="ltr" className="min-w-0 truncate font-medium text-foreground/90">
          {face}
        </bdi>

        <ChevronDown
          className={cn('h-3 w-3 shrink-0 opacity-50 transition-transform motion-reduce:transition-none', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open && (
        <AgentsPanel
          models={models}
          subagents={subagents}
          distinctSubagents={distinctSubagents}
          totalInvocations={totalInvocations}
          currentModelName={current?.agent_name ?? null}
          harnessProvider={harness}
          harnessName={harnessName}
          t={t}
          dir={dir}
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          skills={skills}
        />
      )}
    </>
  );
}
