/**
 * classifyExecResult — how much a raw-exec result actually claims.
 *
 * B-330. The result view used to make two claims it could not back:
 *
 *   1. Anything on stderr is a failure. It is not: git, curl, npm, ssh, rsync
 *      and sudo all write their normal reports and prompts to stderr. A
 *      successful `git push` prints «To <url> … main -> main» there, and the
 *      dialog painted it destructive-red under the heading «Errors».
 *   2. `Exit code: 0` is a success. Also not: the command runs as
 *      `bash -c <verbatim text>` with no `set -e` and no `pipefail` (injecting
 *      either would rewrite the reviewed bytes and break the WYSIWYG guarantee
 *      the dialog exists for). bash therefore returns the status of the LAST
 *      command only — so `git fetch && …` on line 1 can fail while `echo done`
 *      on line 3 makes the whole run report 0. Same for any pipeline: in
 *      `git push | tee log`, the 0 belongs to tee.
 *
 * Fixing (1) by tying stderr's colour to the exit code would just move the lie:
 * a multi-line script that failed early still exits 0, and the real errors would
 * then be greyed out under «not necessarily an error». So stderr is reported as
 * a channel, with no verdict attached, and the verdict lives on the exit-code
 * line alone — where 'partial' says plainly what a 0 does and does not cover.
 *
 * `null` (killed by a signal) stays in 'failed': it is the opposite of a claim
 * of success.
 */

export type ExecOutcome =
  /** exit 0 from a single simple command — the status covers the whole run */
  | 'ok'
  /** exit 0, but the shell only reported the last command of a composite one */
  | 'partial'
  /** non-zero, or killed by a signal (exitCode null) */
  | 'failed';

/**
 * Does the text run more than one command, so that bash's status covers only
 * part of it? Matches newline, `;`, `|` (covers `||`), and `&` (covers `&&`).
 *
 * Deliberately syntax-blind: a `;` inside a quoted string counts too. The cost
 * of a false positive is a caution line on a run that was in fact wholly
 * successful; the cost of a false negative is a green «Exit code: 0» over a
 * failed deploy. Only one of those is acceptable.
 */
function isComposite(command: string): boolean {
  return /[\n;|&]/.test(command);
}

export function classifyExecResult(input: {
  exitCode: number | null;
  command: string;
}): ExecOutcome {
  if (input.exitCode !== 0) return 'failed';
  return isComposite(input.command) ? 'partial' : 'ok';
}
