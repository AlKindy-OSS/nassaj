/**
 * ExecReviewDialog — shared raw-exec review gate.
 *
 * Extracted from CommandBoardSettingsTab so both the settings queue and the
 * chat code-block "Execute" button can use the same dialog without duplicating
 * the security logic.
 *
 * Security guarantees (unchanged from the original; documented in
 * CommandBoardSettingsTab.tsx ADR veto comment):
 *   1. Command rendered verbatim in dir="ltr" + unicode-bidi:isolate monospace
 *      (Trojan Source / bidi-injection prevention).
 *   2. Client-side SHA-256 over rendered text compared to server digest;
 *      execution blocked on mismatch or when SubtleCrypto is unavailable.
 *   3. Explicit, per-command, non-remembered checkbox required.
 *   4. Sends the server-returned digest as confirmationDigest (not the locally
 *      computed hash — the server re-verifies over its stored bytes to defeat
 *      TOCTOU swaps).
 *   5. Dialog cannot be closed during execution.
 *
 * Enhancements over the original:
 *   A. Execution-target warning — prominently names WHERE the command runs
 *      (local Nassaj server, service user "nassaj") so the owner cannot
 *      accidentally execute a command meant for another host.
 *   B. Line-count indicator alongside character count.
 *   C. Scrollable command block (max-h-64) for multi-line commands so all
 *      lines are visible without silent folding.
 *   D. Translates new server error codes:
 *      carriage_return_forbidden → plain-language CR/CRLF message.
 *      too_many_lines            → "exceeds 100 lines" message.
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../utils/api';
import { Button, Dialog, DialogContent, DialogTitle } from '../../shared/view/ui';
import { cn } from '../../lib/utils';

import { classifyExecResult } from './execResultClassify';
import { deniedCommandMessage } from './denyRuleSeverity';

// ── Types ────────────────────────────────────────────────────────────────────

export type RawCommand = {
  id: string;
  command: string;
  /** sha256 of command text, computed server-side over stored bytes */
  digest: string;
  requestedBy?: string | null;
  requestedAt?: string | null;
};

type RawExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

const RAW_URL = '/api/system/command-board-raw';

// ── Component ────────────────────────────────────────────────────────────────

interface ExecReviewDialogProps {
  target: RawCommand | null;
  onClose: () => void;
  /**
   * Called after any execute attempt that consumed the queued row (success OR
   * pre-exec error that invalidated it) so the parent can reload.
   */
  onComplete: () => void;
}

export function ExecReviewDialog({ target, onClose, onComplete }: ExecReviewDialogProps) {
  const { t } = useTranslation('settings');

  // Per-dialog state — reset whenever target changes (new command, new review).
  const [ack, setAck] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<RawExecResult | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  /**
   * null = computing · true = client digest matches server · false = MISMATCH
   * 'unavailable' = WebCrypto absent (non-secure context), so the check could not
   * run at all. That is NOT a pass: claiming a silent success would forge the one
   * guarantee this dialog exists to provide. It is surfaced as a warning and the
   * review proceeds on the server-side digest binding alone.
   */
  const [digestOk, setDigestOk] = useState<boolean | null | 'unavailable'>(null);

  const [outcomeUnverified, setOutcomeUnverified] = useState(false);

  // Reset ALL state on every new target so checkbox is NEVER pre-checked and
  // a previous result never leaks into the next review session.
  useEffect(() => {
    setAck(false);
    setResult(null);
    setExecError(null);
    setExecuting(false);
    setOutcomeUnverified(false);
  }, [target]);

  // Client-side SHA-256 over the rendered text, compared to the server digest.
  // Catches any gap between displayed bytes and stored bytes (bidi injection,
  // in-flight mutation, stale cache). The server repeats this at exec time.
  useEffect(() => {
    if (!target) { setDigestOk(null); return; }
    setDigestOk(null);
    const text = target.command;
    const serverDigest = target.digest;
    void (async () => {
      if (typeof crypto === 'undefined' || !crypto.subtle) {
        // WebCrypto is unavailable outside a secure context (plain http, e.g. a
        // tailnet IP). Report it honestly instead of pretending the bytes checked
        // out — the server still binds the digest to what it stores.
        setDigestOk('unavailable');
        return;
      }
      try {
        const buf = new TextEncoder().encode(text);
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        setDigestOk(hex === serverDigest);
      } catch {
        setDigestOk('unavailable');
      }
    })();
  }, [target]);

  const handleClose = () => {
    if (!executing) onClose();
  };

  const handleExecute = async () => {
    // 'unavailable' may proceed (the server enforces its own binding); only a real
    // MISMATCH or a still-running computation blocks.
    if (!target || !ack || executing || outcomeUnverified || digestOk === false || digestOk === null) return;
    setExecuting(true);
    setExecError(null);
    setResult(null);

    try {
      const res = await (
        authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
      )(`${RAW_URL}/${target.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send the server-returned digest — not a locally re-computed hash.
        // Server recomputes over its stored text and rejects on mismatch.
        body: JSON.stringify({ confirmationDigest: target.digest }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        code?: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        truncated?: boolean;
      };

      if (typeof data.exitCode !== 'undefined') {
        setResult({
          exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
          stdout: typeof data.stdout === 'string' ? data.stdout : '',
          stderr: typeof data.stderr === 'string' ? data.stderr : '',
          truncated: data.truncated === true,
        });
        onComplete();
      } else {
        // A proxy response without execution evidence leaves the outcome unknown.
        if (typeof data.code !== 'string') {
          setOutcomeUnverified(true);
          setExecError(t('commandBoardSettings.rawExec.dialog.outcomeUnverified'));
          onComplete();
          return;
        }

        const code = String(data.code ?? 'internal');
        const invalidating = ['digest_mismatch', 'not_found', 'forbidden_control_char'];
        // B-276: the execute path re-runs the denylist, so it can answer
        // `denied_command:<rule>` too. Unmatched, it fell into 'internal' and a
        // deliberate refusal read as a breakage — the same defect B-260 fixed on
        // the insert path, still standing on this one. B-1278: wording by severity.
        const denied = deniedCommandMessage(t, code, 'commandBoardSettings.rawExec.dialog');
        if (denied !== null) {
          setExecError(denied);
          onComplete();
          return;
        }
        // Authorisation refusals must keep their own wording. Folding them into
        // 'internal' told an owner whose master switch is off that something broke
        // internally — a dead end that hides the one setting they need to change.
        const msgKey = [
          'digest_mismatch', 'not_found', 'action_in_flight', 'exec_failed',
          'timeout', 'forbidden_control_char', 'internal',
          'raw_exec_disabled', 'raw_exec_blocked', 'config_denied', 'unauthenticated',
          // 503 from the strict pre-spawn audit: the command did NOT run, and
          // saying "internal error" hid the one fact that makes that safe to know.
          'audit_unavailable',
        ].includes(code)
          ? code
          : 'internal';
        setExecError(
          t(`commandBoardSettings.rawExec.dialog.${msgKey}`, { defaultValue: code }),
        );
        if (invalidating.includes(code)) onComplete();
      }
    } catch {
      // The request may have run; neither health nor a dropped socket proves it.
      setOutcomeUnverified(true);
      setExecError(t('commandBoardSettings.rawExec.dialog.outcomeUnverified'));
      onComplete();
    } finally {
      setExecuting(false);
    }
  };

  // ── Derived display values ─────────────────────────────────────────────────

  const commandText = target?.command ?? '';
  const charCount = commandText.length;
  // Count visual lines (split on \n; the server bans \r so this is reliable).
  const lineCount = commandText ? commandText.split('\n').length : 0;
  const isMultiLine = lineCount > 1;
  // B-330 — how far the exit code's claim actually reaches. See execResultClassify.
  const outcome = result
    ? classifyExecResult({ exitCode: result.exitCode, command: commandText })
    : 'failed';

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto p-0"
        onPointerDownOutside={handleClose}
        aria-labelledby="raw-exec-dlg-title"
      >
        {/* sr-only title for screen readers */}
        <DialogTitle id="raw-exec-dlg-title" className="sr-only">
          {t('commandBoardSettings.rawExec.dialog.title', {
            defaultValue: 'Review command before executing',
          })}
        </DialogTitle>

        <div className="space-y-4 p-5">
          {/* Visible header */}
          <div>
            <p className="text-base font-semibold text-foreground" aria-hidden="true">
              {t('commandBoardSettings.rawExec.dialog.title', {
                defaultValue: 'Review command before executing',
              })}
            </p>
            <p className="mt-1 text-sm text-destructive">
              {t('commandBoardSettings.rawExec.dialog.subtitle', {
                defaultValue:
                  'These bytes will be executed verbatim on the server. This cannot be undone.',
              })}
            </p>
          </div>

          {/* ── Execution-target warning (safety-critical, always visible) ─── */}
          {/*
            Shown in BOTH the pre-execution and post-execution views.
            Code blocks in conversations are often directed at other machines
            (VMs, remote servers). This warning names the actual execution
            target so the owner cannot confuse it with a different host.
          */}
          <div
            className="flex items-start gap-2.5 rounded-lg border border-amber-400/60 bg-amber-50 px-3.5 py-3 dark:border-amber-500/40 dark:bg-amber-950/30"
            role="note"
            aria-label={t('commandBoardSettings.rawExec.dialog.executionTarget', {
              defaultValue: 'Execution target: local Nassaj server — service user «nassaj»',
            })}
          >
            <Monitor
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                {t('commandBoardSettings.rawExec.dialog.executionTarget', {
                  defaultValue: 'Execution target: local Nassaj server — service user «nassaj»',
                })}
              </p>
              <p className="text-xs text-warning">
                {t('commandBoardSettings.rawExec.dialog.executionTargetWarn', {
                  defaultValue:
                    'Commands written for another machine (e.g. a VM or remote server) must not be executed here.',
                })}
              </p>
            </div>
          </div>

          {/* ── Pre-execution view ─────────────────────────────────────────── */}
          {!result && (
            <>
              {/* Command display */}
              <div>
                <p className="mb-1.5 text-xs font-medium text-foreground">
                  {t('commandBoardSettings.rawExec.dialog.commandLabel', {
                    defaultValue: 'Command that will be executed',
                  })}
                </p>
                {/*
                  dir="ltr" + unicode-bidi: isolate:
                  In an RTL page the Unicode Bidi Algorithm could reorder visual
                  rendering of LTR content mixed with RTL characters. Without
                  explicit isolation a crafted command could display differently
                  from what runs. The server bans bidi override characters at
                  insert AND before exec — this CSS layer is defence-in-depth.
                */}
                <div
                  dir="ltr"
                  className="rounded-md border-2 border-border bg-muted/40 p-3"
                  style={{ unicodeBidi: 'isolate' }}
                >
                  <pre
                    className={cn(
                      'm-0 whitespace-pre-wrap break-all font-mono text-sm text-foreground',
                      // Scrollable for multi-line commands so all lines are
                      // visible without silent folding (task requirement).
                      isMultiLine && 'max-h-64 overflow-y-auto',
                    )}
                    style={{ unicodeBidi: 'isolate' }}
                  >
                    {commandText}
                  </pre>
                </div>

                {/* Length + line count + origin indicators */}
                <div className="mt-1.5 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
                  <span>
                    {t('commandBoardSettings.rawExec.dialog.lengthInfo', {
                      len: charCount,
                      defaultValue: `Length: ${charCount} characters`,
                    })}
                  </span>
                  {/* B-277 — WHO asked for this, stated at the moment of deciding.
                      The dialog's whole promise is that you know what you are
                      running; a row whose requester was never recorded is a gap
                      in that promise, and staying silent about it let the row
                      borrow the credibility of the ones that came through the
                      audited path. Only the observable fact is claimed here: the
                      requester is unrecorded. Why it is unrecorded is B-277. */}
                  {target?.requestedBy ? (
                    <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>
                      {t('commandBoardSettings.rawExec.dialog.requestedBy', {
                        name: target.requestedBy,
                        defaultValue: `Queued by: ${target.requestedBy}`,
                      })}
                    </span>
                  ) : (
                    <span className="font-medium text-amber-600 dark:text-amber-500">
                      {t('commandBoardSettings.rawExec.dialog.unattributed', {
                        defaultValue: 'Origin not recorded — no requester was logged for this command',
                      })}
                    </span>
                  )}
                  {isMultiLine && (
                    <span>
                      {t('commandBoardSettings.rawExec.dialog.lineInfo', {
                        count: lineCount,
                        defaultValue: `${lineCount} line(s)`,
                      })}
                    </span>
                  )}
                </div>
              </div>

              {/* Acknowledgment checkbox
                  Rule: NEVER pre-checked; NEVER remembered across dialog sessions.
                  The useEffect above resets `ack` to false on every new target. */}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-muted/20 p-3 transition-colors hover:bg-muted/30">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  disabled={executing}
                  className="mt-0.5 h-4 w-4 flex-shrink-0 accent-primary"
                  aria-describedby="exec-ack-desc"
                />
                <span id="exec-ack-desc" className="select-none text-sm leading-relaxed text-foreground">
                  {t('commandBoardSettings.rawExec.dialog.ackLabel', {
                    defaultValue:
                      'I have reviewed this command character by character and accept full responsibility for its execution',
                  })}
                </span>
              </label>

              {/* Digest mismatch warning */}
              {digestOk === false && (
                <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  {t('commandBoardSettings.rawExec.dialog.clientDigestMismatch', {
                    defaultValue:
                      'Digest mismatch — the displayed command does not match what is stored. Execution blocked.',
                  })}
                </p>
              )}

              {/* WebCrypto absent — the local check could not run. Say so plainly
                  rather than let the reviewer assume it passed. */}
              {digestOk === 'unavailable' && (
                <p className="flex items-start gap-1.5 text-sm text-amber-600 dark:text-amber-500" role="alert">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  {t('commandBoardSettings.rawExec.dialog.clientDigestUnavailable', {
                    defaultValue:
                      'The local integrity check could not run in this context (insecure origin). The server still binds the digest — read the command carefully.',
                  })}
                </p>
              )}

              {/* Pre-exec error banner */}
              {execError && (
                <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  {execError}
                </p>
              )}

              {/* Action row */}
              <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClose}
                  disabled={executing}
                  className="h-8 px-3 text-sm"
                >
                  {t('commandBoardSettings.rawExec.dialog.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => { void handleExecute(); }}
                  disabled={!ack || executing || outcomeUnverified || digestOk === false || digestOk === null}
                  className="h-8 px-4 text-sm"
                  aria-label={
                    digestOk === false
                      ? t('commandBoardSettings.rawExec.dialog.clientDigestMismatch', {
                          defaultValue: 'Digest mismatch — execution blocked',
                        })
                      : ack
                        ? t('commandBoardSettings.rawExec.dialog.execute', { defaultValue: 'Execute' })
                        : t('commandBoardSettings.rawExec.dialog.ackLabel', {
                            defaultValue: 'Check the acknowledgment first',
                          })
                  }
                >
                  {executing && (
                    <svg
                      className="me-1.5 h-3.5 w-3.5 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  )}
                  {executing
                    ? t('commandBoardSettings.rawExec.dialog.executing', { defaultValue: 'Executing…' })
                    : t('commandBoardSettings.rawExec.dialog.execute', { defaultValue: 'Execute' })}
                </Button>
              </div>
            </>
          )}

          {/* ── Post-execution result view ──────────────────────────────────── */}
          {result && (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('commandBoardSettings.rawExec.dialog.result.title', {
                    defaultValue: 'Execution result',
                  })}
                </p>
                {/*
                  B-330 — the exit code is the ONLY place a verdict belongs, and
                  even here it is graded. `bash -c` returns the status of the last
                  command, so a 0 out of a multi-line or piped command says
                  nothing about the lines before it. Green there would be the same
                  unearned claim, inverted, that painting stderr red was.
                */}
                <p
                  className={cn(
                    'mt-0.5 font-mono text-xs',
                    outcome === 'ok' && 'text-success',
                    outcome === 'partial' && 'text-warning',
                    outcome === 'failed' && 'text-destructive',
                  )}
                >
                  {t('commandBoardSettings.rawExec.dialog.result.exitCode', {
                    code: result.exitCode ?? '?',
                    defaultValue: `Exit code: ${result.exitCode ?? '?'}`,
                  })}
                </p>
                {/* A missing status is not a success — say what produced it. */}
                {result.exitCode === null && (
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t('commandBoardSettings.rawExec.dialog.result.signalKilled', {
                      defaultValue:
                        'The command was terminated by a signal and returned no status — a timeout or an external kill.',
                    })}
                  </p>
                )}
                {outcome === 'partial' && (
                  <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
                    <AlertCircle className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                    {t('commandBoardSettings.rawExec.dialog.result.partialExit', {
                      defaultValue:
                        'This ran several commands, and the exit code covers only the last of them — an earlier one may have failed. Read the output below.',
                    })}
                  </p>
                )}
              </div>

              {result.truncated && (
                <p className="flex items-center gap-1.5 text-xs text-warning">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                  {t('commandBoardSettings.rawExec.dialog.result.truncated', {
                    defaultValue: 'Output truncated — limit: 64 KB',
                  })}
                </p>
              )}

              {/* stdout */}
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t('commandBoardSettings.rawExec.dialog.result.stdout', { defaultValue: 'Output (stdout)' })}
                </p>
                {result.stdout ? (
                  <pre
                    dir="ltr"
                    className="max-h-48 overflow-auto rounded border border-border bg-muted/30 p-2.5 font-mono text-xs text-foreground"
                    style={{ unicodeBidi: 'isolate', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                  >
                    {result.stdout}
                  </pre>
                ) : (
                  <p className="text-xs italic text-muted-foreground">
                    {t('commandBoardSettings.rawExec.dialog.result.noOutput', { defaultValue: '(no output)' })}
                  </p>
                )}
              </div>

              {/* stderr — a CHANNEL, reported without a verdict.
                  git, curl, npm, ssh, rsync and sudo all write their ordinary
                  reports and prompts here; a successful `git push` prints its
                  «To <url> … main -> main» line to stderr and nowhere else.
                  Colouring this box by the exit code would only invert the
                  error: a multi-line script that failed on line 1 still exits 0,
                  and its real errors would then be greyed out. So the box stays
                  neutral in every case, and the verdict lives on the exit-code
                  line above. */}
              {result.stderr && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('commandBoardSettings.rawExec.dialog.result.stderrChannel', {
                      defaultValue: 'Diagnostic output (stderr)',
                    })}
                  </p>
                  <pre
                    dir="ltr"
                    className="max-h-48 overflow-auto rounded border border-border bg-muted/30 p-2.5 font-mono text-xs text-foreground"
                    style={{ unicodeBidi: 'isolate', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                  >
                    {result.stderr}
                  </pre>
                  {/* No latin tool names in this sentence on purpose: an island
                      like «git» followed by neutrals («—», parentheses) gets
                      reordered by the bidi algorithm inside an RTL paragraph,
                      and the fix for that (per-word isolation) is not worth
                      carrying through nine locales for an example list. */}
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t('commandBoardSettings.rawExec.dialog.result.stderrChannelHint', {
                      defaultValue:
                        'Many command-line tools write their normal progress and result reports to this channel. Judge the run by the exit code above, not by the presence of text here.',
                    })}
                  </p>
                </div>
              )}

              {/* Close row */}
              <div className="flex justify-end border-t border-border pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onClose()}
                  className="h-8 px-3 text-sm"
                >
                  {t('commandBoardSettings.rawExec.dialog.result.close', { defaultValue: 'Close' })}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
