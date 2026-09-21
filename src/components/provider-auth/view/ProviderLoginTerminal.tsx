/**
 * ProviderLoginTerminal.tsx — B-209
 *
 * The embedded login terminal, wrapped in the two things the bare shell was
 * missing.
 *
 * 1) A KEYSTROKE SHIELD. The websocket opens (and xterm is auto-focused) a good
 *    while before the provider CLI has put the pty into raw mode. Anything typed
 *    in that window is handled by the line discipline instead of the CLI, which
 *    echoes it back with `echoctl` spelling — that is where the reported
 *    `^[[B^[[A^[[B` came from: arrow keys pressed at an fully-focused terminal
 *    that was not listening yet. Nothing downstream can un-echo them, so the
 *    fix is upstream: hold the keyboard until the operator deliberately takes
 *    it, which is also the moment they have read the prompt.
 *
 *    The block is a CAPTURE-phase listener on the wrapper, not a CSS overlay:
 *    the overlay stops the mouse, but xterm's textarea is focused
 *    programmatically by Shell, so key events would otherwise reach it without
 *    ever passing through a pointer.
 *
 * 2) AN EXPLICIT TERMINAL STATE. The modal used to go silent after the process
 *    exited — the pty was gone, the terminal still looked alive, and the only
 *    trace was whatever the CLI happened to print last. Every phase now has a
 *    visible, announced status line, and the exited phase offers the two moves
 *    that actually exist: run it again, or close.
 *
 * 3) A VISIBLE SERVER REFUSAL. The shell websocket can answer `init` with an
 *    `error` frame (an update-gate denial, a refused project, …) and then send
 *    nothing else: no output, no exit. Whenever that happened the client
 *    swallowed the frame and this modal stayed on "preparing" with nothing on
 *    the pane. The refusal now ends the wait with its own state, carrying the
 *    server's reason and — when the server sends one — its machine-readable
 *    code. This closes a silent path; it was NOT the cause of the black
 *    terminal reported from the fleet, whose launches were authorized and ran
 *    (see docs/decisions/shell-gate-diagnostics-reconnect-and-log-throttle.md).
 *
 * Deliberately NOT claimed: which KIND of failure a non-zero exit was. The exit
 * code alone cannot separate "wrong credentials" from "no active subscription",
 * and inventing that distinction would be worse than naming the code and
 * offering both next steps.
 */

import { AlertTriangle, CheckCircle2, Keyboard, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import type { ShellErrorInfo } from '../../shell/types/types';
import type { Project } from '../../../types/app';

/** `preparing` → keyboard held · `live` → operator has it · `exited` → pty gone. */
type RunPhase = 'preparing' | 'live' | 'exited';

type ProviderLoginTerminalProps = {
  project: Project;
  command: string;
  provider: string;
  /** Bubbles the real exit code up to the caller (auth-status refresh, etc.). */
  onComplete?: (exitCode: number) => void;
  onClose: () => void;
};

export default function ProviderLoginTerminal({
  project,
  command,
  provider,
  onComplete,
  onClose,
}: ProviderLoginTerminalProps) {
  const { t } = useTranslation('settings');

  // Bumping this remounts the shell, which is what "run it again" means: a new
  // pty running the same command, not a reconnect to the dead one.
  const [runId, setRunId] = useState(0);
  const [phase, setPhase] = useState<RunPhase>('preparing');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [shellError, setShellError] = useState<ShellErrorInfo | null>(null);

  const shellWrapRef = useRef<HTMLDivElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);

  // A refused shell has no pty to type into, so the shield comes down with it:
  // holding the keyboard for a terminal that will never listen is just a trap.
  const keyboardHeld = phase === 'preparing' && shellError === null;

  // Swallow input at the wrapper during capture, before it can descend to
  // xterm's textarea. Cleared the moment the operator takes the keyboard.
  useEffect(() => {
    const node = shellWrapRef.current;
    if (!node || !keyboardHeld) {
      return undefined;
    }
    const swallowKey = (event: Event) => {
      // WCAG 2.1.2: Shell focuses xterm's textarea programmatically, so by the
      // time the shield is up the caret can already be INSIDE the region being
      // shielded. Swallowing every key there would leave no way out — a
      // keyboard trap traded for an echo bug.
      //
      // stopPropagation alone keeps the key away from xterm; skipping
      // preventDefault leaves the browser's own behaviour intact, so Tab still
      // moves focus (onto the shield button, which is next in the DOM) and
      // Escape still reaches the modal.
      event.stopPropagation();
      const key = (event as KeyboardEvent).key;
      if (key !== 'Tab' && key !== 'Escape') {
        event.preventDefault();
      }
    };
    const swallowPaste = (event: Event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    node.addEventListener('keydown', swallowKey, true);
    node.addEventListener('keypress', swallowKey, true);
    node.addEventListener('paste', swallowPaste, true);
    return () => {
      node.removeEventListener('keydown', swallowKey, true);
      node.removeEventListener('keypress', swallowKey, true);
      node.removeEventListener('paste', swallowPaste, true);
    };
  }, [keyboardHeld, runId]);

  // A state change nobody is told about is the bug this issue is about: move
  // focus onto the action that the new state introduced. The refusal moves
  // focus ONLY while the keyboard was still held — if the operator already took
  // it, the caret is inside a terminal they may be typing in, and yanking it out
  // from under them would be a second bug wearing the first one's clothes.
  useEffect(() => {
    if (phase === 'exited' || (shellError !== null && phase === 'preparing')) {
      primaryActionRef.current?.focus();
    }
  }, [phase, shellError]);

  const takeKeyboard = useCallback(() => {
    setPhase((current) => (current === 'preparing' ? 'live' : current));
  }, []);

  const handleComplete = useCallback(
    (code: number) => {
      setExitCode(code);
      setPhase('exited');
      onComplete?.(code);
    },
    [onComplete],
  );

  // The one copy of the refusal state. The shell hook both sets it (error
  // frame) and clears it (`null`) once the refusal is superseded — a socket
  // reopened, or the PTY resumed output — so a momentary gate closure over a
  // healthy PTY cannot leave this modal permanently 'blocked' and push the
  // operator to kill a working session. Not routed through handleComplete: a
  // refusal is not a process exit, and a fabricated exit code would be a lie
  // the caller acts on.
  const handleShellError = useCallback((error: ShellErrorInfo | null) => {
    setShellError(error);
  }, []);

  const handleRetry = useCallback(() => {
    setExitCode(null);
    setShellError(null);
    setPhase('preparing');
    setRunId((n) => n + 1);
  }, []);

  const succeeded = phase === 'exited' && exitCode === 0;
  // The refusal outranks 'preparing'/'live' — those describe a pty that exists.
  const blocked = shellError !== null && !succeeded;
  const showActions = blocked || phase === 'exited';

  // Localized explanation derived from the reason CODE, not from the server's
  // English sentence. Keyed on the code FAMILY on purpose: the update gate's
  // exact codes are server-side implementation detail that changes with the
  // guard, and a per-code key list here would silently rot into English
  // fallbacks. An unknown or absent code keeps the generic sentence and shows
  // the server's own text beside it.
  const errorCode = shellError?.code ?? null;
  const isUpdateGateCode = errorCode !== null && errorCode.startsWith('update_');
  const blockedReason = isUpdateGateCode
    ? t('providerLogin.status.blockedUpdateGate', {
        defaultValue:
          'A source-update maintenance window is holding the writer lock, so no new terminal can start right now. Try again once it clears.',
      })
    : errorCode === 'forbidden'
      ? t('providerLogin.status.blockedForbidden', {
          defaultValue:
            'Your role may not run this command in a terminal. Ask an administrator, or close and set an API key instead.',
        })
      : t('providerLogin.status.blockedGeneric', {
          defaultValue: 'The server refused to open this terminal.',
        });
  // Only worth showing when the code did not already carry the meaning.
  const showServerText = !isUpdateGateCode && errorCode !== 'forbidden' && Boolean(shellError?.message);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={shellWrapRef} className="relative min-h-0 flex-1">
        <StandaloneShell
          key={runId}
          project={project}
          command={command}
          provider={provider}
          onComplete={handleComplete}
          onShellError={handleShellError}
          minimal={true}
        />

        {keyboardHeld && (
          // A button, not a div: the shield must be reachable and releasable by
          // keyboard alone, and it is the only control over this region while
          // it is up.
          <button
            type="button"
            onClick={takeKeyboard}
            data-testid="login-keyboard-shield"
            aria-label={t('providerLogin.shield.action', {
              defaultValue: 'Take the keyboard and start typing in the terminal',
            })}
            className="absolute inset-0 z-10 flex cursor-text items-end justify-center bg-transparent p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="pointer-events-none inline-flex items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-1.5 text-[13px] text-foreground shadow-sm backdrop-blur">
              <Keyboard className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t('providerLogin.shield.chip', {
                defaultValue: 'Click here when the prompt appears, then type',
              })}
            </span>
          </button>
        )}
      </div>

      {/* One status line that is never blank — the silence after the process
          exited is the defect this replaces. */}
      <div
        role="status"
        aria-live="polite"
        data-testid="login-run-status"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-card px-4 py-3"
      >
        {blocked || phase === 'exited' ? (
          succeeded ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
          )
        ) : (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-foreground motion-safe:animate-pulse"
            aria-hidden="true"
          />
        )}

        {/* basis-full على الضيّق: جملة الرفض العربية طويلة، وإبقاؤها في عمود
            بعرض بضع كلمات بجانب الزرّين يجعلها غير مقروءة على الهاتف. من sm
            يتكفّل sm:flex-1 بالأمر (وهو يحمل flex-basis:0% ضمناً، فلا حاجة
            لصنف basis منفصل عنده). */}
        <p className="min-w-0 basis-full text-[13px] leading-relaxed text-foreground sm:flex-1">
          {blocked && (
            <>
              <span className="font-semibold">
                {t('providerLogin.status.blocked', {
                  defaultValue: 'The terminal session could not start.',
                })}
              </span>{' '}
              <span className="text-muted-foreground">{blockedReason}</span>
              {/* The server's own sentence is English by construction (the pty
                  pane cannot shape Arabic, so the wire text is ASCII). Shown
                  only when the reason code did not already explain the refusal,
                  and isolated in <bdi> so an English clause cannot drag its
                  final punctuation around inside the Arabic sentence. */}
              {showServerText ? (
                <>
                  {' '}
                  <span className="text-muted-foreground">
                    {t('providerLogin.status.blockedServerText', {
                      defaultValue: 'The server said:',
                    })}
                  </span>{' '}
                  <bdi className="text-muted-foreground" data-testid="login-error-server-text">
                    {shellError?.message}
                  </bdi>
                </>
              ) : null}
              {/* The reason code is an ASCII token; an older server omits it
                  entirely, so it is rendered only when present — never as an
                  empty pair of brackets. */}
              {shellError?.code ? (
                <>
                  {' '}
                  <span className="text-muted-foreground">
                    {t('providerLogin.status.blockedCode', { defaultValue: 'Reason code:' })}
                  </span>{' '}
                  {/* dir=ltr island for the token, same treatment the command
                      gets above: an Arabic sentence must not reorder it. */}
                  <code
                    dir="ltr"
                    data-testid="login-error-code"
                    className="inline-block rounded-sm bg-muted px-1 font-mono text-[13px]"
                  >
                    {shellError.code}
                  </code>
                </>
              ) : null}
            </>
          )}
          {!blocked && phase === 'preparing' && (
            <>
              {t('providerLogin.status.preparing', {
                defaultValue:
                  'Starting the sign-in command. The keyboard is on hold until you click the terminal, so early keystrokes cannot reach it as stray characters.',
              })}{' '}
              {/* dir=ltr: a shell command keeps its own base direction inside an
                  Arabic sentence. rounded-sm (not `rounded`) so the radius keeps
                  deriving from --radius rather than hardcoding 0.25rem. */}
              <code
                dir="ltr"
                className="inline-block rounded-sm bg-muted px-1 font-mono text-[13px]"
              >
                {command}
              </code>
            </>
          )}
          {!blocked && phase === 'live' &&
            t('providerLogin.status.live', {
              defaultValue: 'The terminal has your keyboard. Follow the prompts above.',
            })}
          {!blocked && phase === 'exited' && (
            <>
              <span className="font-semibold">
                {succeeded
                  ? t('providerLogin.status.succeeded', { defaultValue: 'Sign-in finished.' })
                  : t('providerLogin.status.failed', {
                      defaultValue: 'Sign-in did not complete.',
                    })}
              </span>{' '}
              <span className="text-muted-foreground">
                {succeeded
                  ? t('providerLogin.status.succeededDetail', {
                      defaultValue:
                        'The process exited normally. Close this window; the account card will show the new state.',
                      provider,
                    })
                  : t('providerLogin.status.failedDetail', {
                      defaultValue:
                        'The process exited with code {{code}}. Read the terminal output above for the reason — a rejected login and a plan that does not cover this CLI both end here. You can run it again, or close and set an API key instead.',
                      code: exitCode ?? -1,
                      provider,
                    })}
              </span>
            </>
          )}
        </p>

        {showActions && (
          <span className="flex shrink-0 items-center gap-2">
            {!succeeded && (
              <button
                type="button"
                ref={primaryActionRef}
                onClick={handleRetry}
                data-testid="login-retry"
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-[13px] font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t('providerLogin.action.retry', { defaultValue: 'Run it again' })}
              </button>
            )}
            <button
              type="button"
              ref={succeeded ? primaryActionRef : undefined}
              onClick={onClose}
              data-testid="login-close"
              className={
                succeeded
                  ? 'rounded-md bg-foreground px-3 py-1.5 text-[13px] font-semibold text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                  : 'rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              }
            >
              {t('providerLogin.action.close', { defaultValue: 'Close' })}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
