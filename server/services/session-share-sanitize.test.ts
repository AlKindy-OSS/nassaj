/**
 * ADR-196 / T-1970 stage 3: text sanitizer for public session snapshots.
 * Adversarial inputs: harness tags (closed, unclosed, stray, hook variants),
 * governance injections, image forms, run-button fences, secrets and paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DOCUMENT_SHARING_INSTRUCTIONS, runtimeInstructionsPrefix } from '../../shared/documentSharingInstructions.js';

import {
  normalizeParts,
  redactImages,
  rewriteFences,
  sanitizeShareText,
  stripGovernanceText,
  stripHarnessTags,
  type SharePart,
  type ShareTextCounts,
} from './session-share-sanitize.js';

const counts = (): ShareTextCounts => ({ system: 0, image: 0, secret: 0, path: 0, network: 0 });
const flat = (parts: SharePart[]): string => parts
  .map((part) => (part.t === 'text' ? part.text : `[${part.cat}${part.text ? `:${part.text}` : ''}]`)).join('');

test('closed harness tags go with their body and leave one system marker', () => {
  const c = counts();
  const parts = stripHarnessTags('before <system-reminder>\nsecret plan\n</system-reminder> after', c);
  assert.equal(flat(parts), 'before [system] after');
  assert.equal(c.system, 1);
});

test('an unclosed tag loses only its marker and the user text survives', () => {
  const c = counts();
  const parts = stripHarnessTags('<system-reminder>\nmy real question stays', c);
  assert.equal(flat(parts), '[system]\nmy real question stays');
  assert.equal(c.system, 1);
});

test('stray closers, hook variants, attributes and upper case are all stripped', () => {
  const c = counts();
  const text = 'a</command-args>b<pre-tool-use-hook>x</pre-tool-use-hook>c<INSTRUCTIONS>y</INSTRUCTIONS>'
    + 'd<permissions instructions>z</permissions>e';
  assert.equal(flat(stripHarnessTags(text, c)), 'a[system]b[system]c[system]d[system]e');
  assert.equal(c.system, 4);
});

test('closers with attributes, *_instructions/*_context tags and the AGENTS.md heading are stripped', () => {
  const c = counts();
  const text = '<permissions instructions>\nsandbox\n</permissions instructions>A<skills_instructions>s</skills_instructions>'
    + 'B<environment_context><cwd>/x</cwd></environment_context>C';
  assert.equal(flat(stripHarnessTags(text, c)), '[system]A[system]B[system]C');
  const agents = '# AGENTS.md instructions for /srv/p\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>';
  assert.deepEqual(sanitizeShareText(agents, {}, c), []);
  assert.equal(sanitizeShareText('# AGENTS.md instructions are useful', {}, c).length, 1, 'a plain heading stays');
});

test('unknown tags and plain angle brackets are kept verbatim', () => {
  const c = counts();
  const text = 'if a < b then <div>ok</div> and <not a tag';
  assert.equal(flat(stripHarnessTags(text, c)), text);
  assert.equal(c.system, 0);
});

test('a slash command transcript row reduces to markers only', () => {
  const c = counts();
  const parts = sanitizeShareText(
    '<command-name>/compact</command-name>\n  <command-message>compact</command-message>\n  <command-args></command-args>',
    {}, c,
  );
  assert.deepEqual(parts, []);
  assert.equal(c.system, 3);
});

test('many unclosed openers stay linear (memoized missing closer)', () => {
  const c = counts();
  const text = '<system-reminder>x'.repeat(50_000);
  const started = Date.now();
  const parts = stripHarnessTags(text, c);
  assert.ok(Date.now() - started < 2000);
  assert.equal(c.system, 50_000);
  assert.equal(parts.filter((part) => part.t === 'text').length, 50_000);
});

test('the runtime instruction prefix and literal sharing guidance are removed', () => {
  const c = counts();
  const prefixed = `${runtimeInstructionsPrefix({ publisherPath: null, contentRoot: null, origin: null })}\n\nhello`;
  assert.equal(stripGovernanceText(prefixed, c), 'hello');
  assert.equal(c.system, 1);
  const pasted = `x ${DOCUMENT_SHARING_INSTRUCTIONS} y ${DOCUMENT_SHARING_INSTRUCTIONS}`;
  assert.equal(stripGovernanceText(pasted, c), 'x  y ');
  assert.equal(c.system, 3);
});

test('image fences become one marker; an unclosed image fence fails closed to the end', () => {
  const c = counts();
  const closed = rewriteFences('see\n```image\n/home/user/shot.png\ncaption\n```\nafter', c);
  assert.equal(flat(closed), 'see[image]after');
  const unclosed = rewriteFences('see\n~~~~image\n/home/user/shot.png\nmore', c);
  assert.equal(flat(unclosed), 'see[image]');
  assert.equal(c.image, 2);
});

test('nassaj-run fences become plain bash fences; other fences are untouched', () => {
  const c = counts();
  const text = '```bash nassaj-run\nnpm test\n```\n```js\nx()\n```';
  assert.equal(flat(rewriteFences(text, c)), '```bash\nnpm test\n```\n```js\nx()\n```');
  assert.equal(c.image, 0);
});

test('markdown images, html images, data URIs and image-store URLs become markers', () => {
  const c = counts();
  const text = [
    'a ![shot](https://x.example/p.png "t") b',
    '<img src="/api/assistant-images/abc.png" alt="x">',
    'data:image/png;base64,iVBORw0KGgo=',
    'link /api/chat-images/u1/abc.png?token=zzz end',
    'https://host.example/api/assistant-images/9/f.webp',
  ].join('\n');
  const out = flat(redactImages(text, c));
  assert.equal(out, 'a [image] b\n[image]\n[image]\nlink [image] end\n[image]');
  assert.equal(c.image, 5);
});

test('the Claude attachment path list is redacted as images', () => {
  const c = counts();
  const text = 'how?\n\n[Images provided at the following paths:]\n1. /home/user/.local/share/x/chat-images/a/image_0.png';
  assert.equal(flat(redactImages(text, c)), 'how?\n\n[image]');
  assert.equal(c.image, 1);
});

test('nested markdown image in a link and adversarial bracket runs stay linear', () => {
  const c = counts();
  assert.equal(flat(redactImages('[![a](i.png)](https://l.example)', c)), '[[image]](https://l.example)');
  const started = Date.now();
  redactImages('![['.repeat(200_000), c);
  redactImages('![](![](('.repeat(100_000), c);
  assert.ok(Date.now() - started < 3000);
});

test('secrets, paths and network locations are redacted with typed markers', () => {
  const c = counts();
  const key = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
  const parts = sanitizeShareText(
    `key ${key} in /srv/proj/src/a.ts and ~ is /home/demo/x via 100.64.1.2`,
    { projectRoot: '/srv/proj', home: '/home/demo' }, c,
  );
  const text = flat(parts);
  assert.ok(!text.includes(key));
  assert.ok(!text.includes('/srv/proj'));
  assert.ok(!text.includes('/home/demo'));
  assert.ok(text.includes('[path:<project>]/src/a.ts'));
  assert.ok(text.includes('[path:~]/x'));
  assert.equal(c.secret, 1);
  assert.equal(c.path, 2);
  assert.equal(c.network, 1);
  assert.ok(!text.includes('100.64.1.2'));
});

test('full pipeline order: tags, then fences, then images, then secrets', () => {
  const c = counts();
  const parts = sanitizeShareText(
    '<system-reminder>x</system-reminder>\n```bash nassaj-run\nls /srv/p\n```\n![i](/api/chat-images/1.png)',
    { projectRoot: '/srv/p' }, c,
  );
  assert.equal(flat(parts), '[system]\n```bash\nls [path:<project>]\n```\n[image]');
});

test('normalizeParts merges text, collapses repeated markers and trims edges', () => {
  const parts: SharePart[] = [
    { t: 'text', text: '  a' }, { t: 'text', text: 'b' },
    { t: 'redacted', cat: 'system' }, { t: 'redacted', cat: 'system' },
    { t: 'redacted', cat: 'path', text: '~' }, { t: 'redacted', cat: 'path', text: '<project>' },
    { t: 'text', text: '  ' },
  ];
  assert.deepEqual(normalizeParts(parts), [
    { t: 'text', text: 'ab' }, { t: 'redacted', cat: 'system' },
    { t: 'redacted', cat: 'path', text: '~' }, { t: 'redacted', cat: 'path', text: '<project>' },
  ]);
});

test('a message that is only an image or only markers yields no parts', () => {
  const c = counts();
  assert.deepEqual(sanitizeShareText('![x](/api/chat-images/1.png)', {}, c), []);
  assert.deepEqual(sanitizeShareText('', {}, c), []);
});

/** Wall time of one full sanitization, in milliseconds. */
function timeSanitize(text: string): number {
  const started = performance.now();
  sanitizeShareText(text, { projectRoot: '/home/user/p', home: '/home/user' }, counts());
  return performance.now() - started;
}

test('trailing and inner blank runs are linear: 500k spaces + x under 200 ms', () => {
  for (const text of [' '.repeat(500_000) + 'x', `a${' '.repeat(500_000)}x`, `a${' '.repeat(500_000)}x${' '.repeat(10)}`]) {
    const elapsed = timeSanitize(text);
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(0)} ms`);
  }
  assert.deepEqual(normalizeParts([{ t: 'text', text: ` \n a b \t\n ` }]), [{ t: 'text', text: 'a b' }]);
});

test('pathological shapes across the whole pipeline stay linear and stack-safe', () => {
  const MiB = 1024 * 1024;
  const shapes: Record<string, string> = {
    blankRunsBeforeText: `x${`${' '.repeat(1000)}x\n`.repeat(1000)}`,
    jwtRun: 'eyJ-'.repeat(MiB / 4),
    tableBlankCells: `| password | x${' '.repeat(4000)}\n`.repeat(256),
    imageListLines: '[Images provided at the following paths:]\n1. '.repeat(MiB / 44),
    unclosedTags: '<system-reminder'.repeat(MiB / 16),
    longBase64: 'A'.repeat(8 * MiB),
  };
  for (const [name, text] of Object.entries(shapes)) {
    const elapsed = timeSanitize(text);
    assert.ok(elapsed < 600, `${name} took ${elapsed.toFixed(0)} ms`);
  }
});
