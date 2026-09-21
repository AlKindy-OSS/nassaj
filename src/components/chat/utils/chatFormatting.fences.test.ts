import { describe, it, expect } from 'vitest';

import { normalizeInlineCodeFences } from './chatFormatting';
import syntheticFixtures from './__fixtures__/adjacent-code-fences.synthetic.json';

/**
 * B-101 — `normalizeInlineCodeFences` must not touch block code fences.
 *
 * The function exists for ONE narrow case: a provider that wrote a single-line
 * ```like this``` where it meant `inline code`. It runs unconditionally on every
 * assistant message body (Markdown.tsx), so its blast radius is every message in
 * the app, and the bug was that the separator class was `\s` — which matches
 * newlines. That let a match start at the end of one fenced block and finish at
 * the start of the next, collapsing two code blocks AND the prose between them
 * into a single inline span.
 *
 * The representative fixtures preserve the exact structural trigger: adjacent
 * fenced blocks separated by prose, and a quadruple-backtick wrapper around an
 * inert execution example. They contain no copied transcript material.
 */

const OLD_BROKEN_REGEX = /```\s*([^\n\r]+?)\s*```/g;
const applyOldBrokenRegex = (text: string) => text.replace(OLD_BROKEN_REGEX, '`$1`');

describe('normalizeInlineCodeFences — representative block messages (B-101)', () => {
  for (const testCase of syntheticFixtures.cases) {
    it(`leaves "${testCase.name}" byte-identical`, () => {
      expect(normalizeInlineCodeFences(testCase.text)).toBe(testCase.text);
    });

    /**
     * The mutation guard. Without it the assertion above is satisfied by any
     * implementation that does nothing at all, and it would also have passed on
     * a fixture that simply contained no fences. This proves the fixture is a
     * genuine trigger: the pre-fix regex really does corrupt THIS text.
     */
    it(`"${testCase.name}" is a structural trigger — the pre-fix regex corrupts it`, () => {
      expect(applyOldBrokenRegex(testCase.text)).not.toBe(testCase.text);
    });
  }

  it('does not swallow the prose sitting between two adjacent fenced blocks', () => {
    const { text } = syntheticFixtures.cases[0];
    const prose = 'The prose between both blocks must remain visible.';

    expect(text).toContain(prose);
    // The corruption signature: the sentence between the two blocks is absorbed
    // into an inline span, so the fence count collapses from 4 to 2.
    expect(applyOldBrokenRegex(text).match(/```/g) ?? []).toHaveLength(2);
    expect(normalizeInlineCodeFences(text).match(/```/g) ?? []).toHaveLength(4);
  });

  it('keeps a quad-backtick wrapper intact so a DEMONSTRATED exec fence stays inert', () => {
    // This one is not cosmetic. The message documents the nassaj-exec syntax by
    // wrapping it in ```` so it renders as an EXAMPLE. The old regex ate the
    // wrapper, promoting the example to a real ```nassaj-exec:safe-restart block
    // — i.e. a live "Execute" button for a server restart, rendered out of a
    // sentence that was only describing one.
    const { text } = syntheticFixtures.cases[1];

    expect(text).toContain('````');
    expect(normalizeInlineCodeFences(text)).toContain('````');
    expect(applyOldBrokenRegex(text)).not.toContain('````');
  });
});

describe('normalizeInlineCodeFences — the narrow case it exists for', () => {
  it('still converts a genuine single-line triple-backtick span to inline code', () => {
    expect(normalizeInlineCodeFences('run ```npm test``` now')).toBe('run `npm test` now');
  });

  it('trims only spaces and tabs around the span', () => {
    expect(normalizeInlineCodeFences('``` \tnpm test\t ```')).toBe('`npm test`');
  });

  it('leaves a normal fenced block with a language tag alone', () => {
    const block = '```js\nconst a = 1;\n```';
    expect(normalizeInlineCodeFences(block)).toBe(block);
  });

  it('leaves an empty fenced block alone', () => {
    const block = '```\n\n```';
    expect(normalizeInlineCodeFences(block)).toBe(block);
  });

  it('passes non-string and empty input through unchanged', () => {
    expect(normalizeInlineCodeFences('')).toBe('');
    expect(normalizeInlineCodeFences(null as never)).toBe(null);
    expect(normalizeInlineCodeFences(undefined as never)).toBe(undefined);
  });
});
