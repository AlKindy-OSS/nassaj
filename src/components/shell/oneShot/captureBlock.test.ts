/**
 * T-2037 [qa high-6] — attached output cannot break out of its fence and
 * carries no bidi or control characters.
 * Run: NODE_ENV=test npx vitest run src/components/shell/oneShot/captureBlock.test.ts
 */
import { describe, expect, it } from 'vitest';

import { buildCaptureBlock, fenceFor, foldCarriageReturns, sanitizeCapturedText } from './captureBlock';

const labels = { header: 'exit code 0', truncatedNote: '(truncated)' };

describe('captureBlock', () => {
  it('wraps command and output in a text fence under a header', () => {
    const block = buildCaptureBlock({ command: 'ls', text: 'a\nb\n', exitCode: 0, truncated: false }, labels);
    expect(block).toBe('exit code 0\n```text\n$ ls\na\nb\n```');
  });

  it('uses a fence longer than any backtick run in the content', () => {
    const text = 'x ``` y\n`````\nz';
    const block = buildCaptureBlock({ command: 'cat f', text, exitCode: 0, truncated: false }, labels);
    const lines = block.split('\n');
    expect(lines[1]).toBe('``````text');
    expect(lines.at(-1)).toBe('``````');
    // No inner line equals the fence (so it cannot close early).
    expect(lines.slice(2, -1).some((line) => line.trim() === '``````')).toBe(false);
    expect(fenceFor('no ticks')).toBe('```');
  });

  it('strips bidi overrides/isolates and control bytes, keeps \\n and \\t', () => {
    const dirty = 'a‮evil‬\tb⁦c⁩\u0007\u0000d‏\u009b';
    expect(sanitizeCapturedText(dirty)).toBe('aevil\tbcd');
  });

  it('strips every format char and line/paragraph separator', () => {
    expect(sanitizeCapturedText('a\u200Bb\u00ADc\u2028d\u2029e\uFEFFf')).toBe('abcdef');
  });

  it('removes ANSI escapes whole, not just ESC', () => {
    expect(sanitizeCapturedText('\u001b[31mred\u001b[0m')).toBe('red');
  });

  it('folds CR like a terminal (CRLF → LF, progress keeps last draw)', () => {
    expect(foldCarriageReturns('a\r\nb')).toBe('a\nb');
    expect(foldCarriageReturns('10%\r50%\r100%\ndone')).toBe('100%\ndone');
  });

  it('sanitizes the command and keeps it on one line inside the fence', () => {
    const block = buildCaptureBlock(
      { command: 'echo ‮hi\nrm', text: '', exitCode: 1, truncated: true },
      labels,
    );
    expect(block).toBe('exit code 0\n```text\n$ echo hi rm\n```\n(truncated)');
  });
});
