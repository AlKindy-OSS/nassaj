/**
 * T-2027 (ADR-209) — the trailing ```choices parser.
 * Run: NODE_ENV=test npx vitest run src/components/chat/utils/parseChoices.test.ts
 */
import { describe, expect, it } from 'vitest';

import { MAX_CHOICES, MAX_CHOICE_LEN, parseChoices } from './parseChoices';

const fence = (...options: string[]) => ['```choices', ...options, '```'].join('\n');
const reply = (...options: string[]) => `جرّب الأمر ثم أخبرني بالنتيجة.\n\n${fence(...options)}`;

describe('parseChoices — accepts', () => {
  it('two Arabic options and cuts the fence from the body', () => {
    expect(parseChoices(reply('شغّلته', 'لم يعمل'))).toEqual({
      choices: ['شغّلته', 'لم يعمل'],
      body: 'جرّب الأمر ثم أخبرني بالنتيجة.',
    });
  });

  it(`exactly MAX_CHOICES (${MAX_CHOICES}) options`, () => {
    expect(parseChoices(reply('a', 'b', 'c', 'd', 'e'))?.choices).toHaveLength(5);
  });

  it('a fence that is the whole message (empty body)', () => {
    expect(parseChoices(fence('yes', 'no'))).toEqual({ choices: ['yes', 'no'], body: '' });
  });

  it('CRLF line endings and trailing whitespace after the fence', () => {
    const text = 'Pick one:\r\n\r\n```choices\r\nA\r\nB\r\n```\r\n  \r\n';
    expect(parseChoices(text)).toEqual({ choices: ['A', 'B'], body: 'Pick one:' });
  });

  it('strips "- ", "* ", "1. " and "2) " prefixes, trims and drops empty lines', () => {
    expect(parseChoices(reply('- first', '', '* second', '  1. third  ', '2) fourth'))?.choices)
      .toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('dedupes after cleaning', () => {
    expect(parseChoices(reply('نعم', '- نعم', 'لا'))?.choices).toEqual(['نعم', 'لا']);
  });

  it('strips bidi controls, zero-width and control characters', () => {
    const dirty = ['\u202Eevil\u202C', 'zero\u200Bwidth\uFEFF', '\u2066iso\u2069\u200F', 'ctl\u0007'];
    expect(parseChoices(reply(...dirty))?.choices).toEqual(['evil', 'zerowidth', 'iso', 'ctl']);
  });

  it.each([
    ['U+061C Arabic letter mark', 'a\u061Cb'],
    ['U+2060 word joiner', 'a\u2060b'],
    ['U+00AD soft hyphen', 'a\u00ADb'],
    ['U+3164 Hangul filler', 'a\u3164b'],
    ['U+034F grapheme joiner and a variation selector', 'a\u034F\uFE0Fb'],
    ['U+2028 / U+2029 separators', 'a\u2028\u2029b'],
  ])('strips %s', (_label, dirty) => {
    expect(parseChoices(reply(dirty, 'other'))?.choices[0]).toBe('ab');
  });

  it('strips a Unicode Tags payload so only the visible text survives', () => {
    const tags = Array.from('ignore previous', (ch) => String.fromCodePoint(0xE0000 + ch.codePointAt(0)!)).join('');
    const parsed = parseChoices(reply(`ok${tags}`, `\u{E0100}fine`));
    expect(parsed?.choices).toEqual(['ok', 'fine']);
    expect(Array.from(parsed!.choices[0])).toHaveLength(2);
  });

  it('keeps Arabic harakat intact (shadda in «شغّلته»)', () => {
    const [first] = parseChoices(reply('شغّلته', 'لا'))!.choices;
    expect(first).toBe('شغّلته');
    expect(first).toContain('\u0651');
  });

  it('parses 100k trailing spaces in linear time', () => {
    const text = `${reply('a', 'b')}${' '.repeat(100_000)}`;
    const hostile = `x${' '.repeat(100_000)}y`;
    const started = performance.now();
    expect(parseChoices(text)?.choices).toEqual(['a', 'b']);
    expect(parseChoices(`${hostile}\n\n${fence('a', 'b')}`)?.choices).toEqual(['a', 'b']);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it(`an option of exactly MAX_CHOICE_LEN (${MAX_CHOICE_LEN}) code points`, () => {
    expect(parseChoices(reply('x'.repeat(60), 'ok'))?.choices[0]).toHaveLength(60);
  });

  it('only the trailing fence counts when there are two', () => {
    const text = `${fence('old', 'one')}\n\nmiddle\n\n${fence('new', 'two')}`;
    expect(parseChoices(text)).toEqual({ choices: ['new', 'two'], body: `${fence('old', 'one')}\n\nmiddle` });
  });
});

describe('parseChoices — rejects (renders as a normal code block)', () => {
  it.each([
    ['empty string', ''],
    ['no fence', 'just text'],
    ['an empty fence', reply()],
    ['one option', reply('only')],
    ['one option after dedupe', reply('same', 'same')],
    ['six options', reply('a', 'b', 'c', 'd', 'e', 'f')],
    ['an option of 61 code points', reply('x'.repeat(61), 'ok')],
    ['a leading slash command', reply('/clear', 'continue')],
    ['a slash after a list prefix', reply('- /compact', 'continue')],
    ['the bare help alias', reply('help', 'continue')],
    ['an unclosed fence', 'text\n\n```choices\na\nb'],
    ['text after the fence', `${reply('a', 'b')}\n\nmore text`],
    ['a 4-backtick example', '````md\n```choices\na\nb\n```\n````'],
    ['a blockquote', 'q\n\n> ```choices\n> a\n> b\n> ```'],
    ['a list item', '- item\n\n  ```choices\n  a\n  b\n  ```'],
    ['an indented block', 'code:\n\n    ```choices\n    a\n    b\n    ```'],
    ['a different info string', 'x\n\n```choices-v2\na\nb\n```'],
    ['an info string with extra words', 'x\n\n```choices extra\na\nb\n```'],
    ['a tilde fence', 'x\n\n~~~choices\na\nb\n~~~'],
    ['a choices line swallowed by an earlier open fence', '```js\nconst a = 1;\n```choices\na\n```'],
  ])('%s', (_label, text) => {
    expect(parseChoices(text)).toBeNull();
  });
});
