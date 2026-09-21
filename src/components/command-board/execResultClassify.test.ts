/**
 * execResultClassify.test.ts — B-330: stderr is a channel, not a verdict.
 *
 * The report: the owner ran `git push` from the command board. Exit code 0,
 * stdout empty, and stderr holding git's ordinary success line
 * («To https://github.com/… eba04e9..cec730b main -> main»). The dialog showed
 * it under «Errors (stderr)» in destructive red, so a completed push read as a
 * failure.
 *
 * The obvious fix — grey the stderr box out whenever the exit code is 0 — was
 * rejected in review, because it makes the opposite error on the case this
 * board is actually used for: a multi-line script. Commands run as
 * `bash -c <text>` with no `set -e`, so exit 0 means «the last line succeeded»
 * and nothing more. Greying stderr on a 0 would hide a first-line `git fetch`
 * failure behind «not necessarily an error».
 *
 * So the classifier below never looks at stderr at all. It grades the exit
 * code's OWN reach, and the view reports stderr neutrally in every case.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { classifyExecResult } from './execResultClassify';

describe('classifyExecResult', () => {
  it('grades a simple successful command as fully ok', () => {
    expect(classifyExecResult({ exitCode: 0, command: 'git push' })).toBe('ok');
    expect(classifyExecResult({ exitCode: 0, command: 'npm run build:client' })).toBe('ok');
  });

  it('grades exit 0 from a MULTI-LINE script as partial, not success', () => {
    // The incident shape: the failure is on line 1, the 0 belongs to line 3.
    const script = 'git fetch origin\ngit rebase origin/main\necho done';
    expect(classifyExecResult({ exitCode: 0, command: script })).toBe('partial');
  });

  it('grades exit 0 through a pipeline as partial (the 0 belongs to the last stage)', () => {
    expect(classifyExecResult({ exitCode: 0, command: 'git push 2>&1 | tee /tmp/log' })).toBe('partial');
  });

  it('grades every chaining operator as partial', () => {
    for (const command of [
      'a && b',
      'a || b',
      'a ; b',
      'a & wait',
      'a | b',
    ]) {
      expect(classifyExecResult({ exitCode: 0, command })).toBe('partial');
    }
  });

  it('grades a non-zero exit as failed regardless of how simple the command is', () => {
    expect(classifyExecResult({ exitCode: 1, command: 'git push' })).toBe('failed');
    expect(classifyExecResult({ exitCode: 128, command: 'a && b' })).toBe('failed');
  });

  it('grades a signal kill (exitCode null) as failed, never as ok', () => {
    // The server sends exitCode: null when bash was killed by a signal — the
    // timeout tree-kill among them. Absence of a status is not a success.
    expect(classifyExecResult({ exitCode: null, command: 'sleep 999' })).toBe('failed');
    expect(classifyExecResult({ exitCode: null, command: 'a && b' })).toBe('failed');
  });
});

/**
 * Source guards. Rendering the result view live needs an armed board, a raw
 * tier and a completed round-trip — the combination that kept this path
 * untested while the wrong claim sat in it. These pin the two properties the
 * fix rests on, straight from the file.
 */
describe('ExecReviewDialog result view (source guards)', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'ExecReviewDialog.tsx'),
    'utf8',
  );
  // The stderr block: from its heading to the closing tag of its <pre>.
  const stderrBlock = source.slice(
    source.indexOf('{/* stderr'),
    source.indexOf('{/* Close row'),
  );

  it('extracts the stderr block it is guarding', () => {
    expect(stderrBlock.length).toBeGreaterThan(200);
    expect(stderrBlock).toContain('result.stderr');
  });

  it('paints stderr neutrally — no destructive colour on the channel itself', () => {
    expect(stderrBlock).not.toMatch(/destructive/);
  });

  it('does not call stderr "errors" — the heading key carries the meaning, not the colour', () => {
    // Meaning must never live in colour alone (a11y), so the heading changed
    // together with it. The old key must be gone from this block.
    expect(stderrBlock).not.toMatch(/result\.stderr'/);
    expect(stderrBlock).toContain('result.stderrChannel');
  });

  it('routes the verdict through the classifier instead of re-deriving it inline', () => {
    expect(source).toContain('classifyExecResult');
    expect(source).toContain("outcome === 'partial'");
  });
});
