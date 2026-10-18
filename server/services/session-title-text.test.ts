/**
 * B-1668 item 3: the one session-title text pipeline. Phase 1 (blocks out)
 * runs before ADR-210 display masking and never edits inside a word; phase 2
 * (markdown out) runs on the masked text, so a known secret spelled with `__`
 * or `*` is still matched verbatim and never surfaces.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { configureDisplayMaskForTests, restoreMaskedLabel } from './display-secret-mask.js';
import {
  displaySearchText,
  displaySessionTitle,
  isPlaceholderSessionTitle,
  titleTextBeforeMask,
  toTitleText,
} from './session-title-text.js';

const IMAGES = '[Images provided at the following paths:]\n1. /home/user/.nassaj/chat-images/a.png\n2. /home/user/b.png';
// A member's known vendor key whose spelling contains markdown-looking runs.
const LITERAL = ['abc__def*ghi', 'jkl-0123456789ABCDEFGHIJ'].join('_');

const maskWithLiteral = () => configureDisplayMaskForTests({
  env: () => undefined, readSetting: () => null, serviceLiterals: () => [],
  allUserIds: () => [7], vendorLiterals: () => [LITERAL], sharedVendorLiterals: () => [],
});

afterEach(() => configureDisplayMaskForTests(null));

describe('toTitleText (phase 1)', () => {
  it('removes the image list, injected tags and their bodies', () => {
    assert.equal(toTitleText(`fix the sidebar\n\n${IMAGES}`), 'fix the sidebar');
    for (const tag of ['nassaj_document_sharing', 'nassaj_public_pages', 'coordination', 'environment_context']) {
      assert.equal(toTitleText(`<${tag}>\nrules\n</${tag}>\nreal text`), 'real text', tag);
    }
  });

  it('cuts at an injected opener whose closer was truncated away, and handles nesting', () => {
    assert.equal(toTitleText('ask <nassaj_document_sharing> Nassaj document sharing: when you'), 'ask');
    assert.equal(toTitleText('<nassaj_document_sharing> Nassaj documen'), '');
    assert.equal(toTitleText('<coordination><environment_context>x</environment_context></coordination> hi'), 'hi');
  });

  it('removes Codex\'s AGENTS.md envelope entirely', () => {
    const envelope = '# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>\n<environment_context><cwd>/w</cwd></environment_context>';
    assert.equal(toTitleText(envelope), '');
  });

  it('keeps Arabic text and emoji intact and does not touch markdown', () => {
    assert.equal(toTitleText('**أصلح** الخطأ 🚀 in `build`'), '**أصلح** الخطأ 🚀 in `build`');
  });

  it('stays linear on a large hostile input', () => {
    const hostile = `${'<coordination '.repeat(20_000)}${'**a'.repeat(50_000)}${'['.repeat(50_000)}`;
    const started = Date.now();
    displaySessionTitle(hostile);
    displaySearchText(hostile, (text) => text);
    assert.ok(Date.now() - started < 2_000, 'no backtracking blow-up');
  });
});

describe('displaySessionTitle', () => {
  it('strips markdown markers at word boundaries', () => {
    assert.equal(displaySessionTitle('## **Fix** the __sidebar__ `list` > now'), 'Fix the sidebar list > now');
    assert.equal(displaySessionTitle('- read [the docs](https://example.com/x) *now*'), 'read the docs now');
    assert.equal(displaySessionTitle('snake_case_name and a*b*c stay'), 'snake_case_name and a*b*c stay');
  });

  it('maps every provider placeholder to an empty title', () => {
    for (const placeholder of [
      'Untitled Claude Session', 'Untitled Codex Session', 'Untitled OpenCode Session',
      'New Antigravity Chat', 'New session - 2026-10-16T12:35:45.123Z',
    ]) {
      assert.equal(isPlaceholderSessionTitle(placeholder), true, placeholder);
      assert.equal(displaySessionTitle(placeholder), '', placeholder);
    }
    assert.equal(displaySessionTitle(null), '');
    assert.equal(displaySessionTitle(IMAGES), '');
  });

  it('is idempotent, so a rename round-trip is stable', () => {
    for (const sample of ['**a** __b__ `c`', '****x****', '# t', 'نص **عريض** 🚀', `x\n${IMAGES}`]) {
      const once = displaySessionTitle(sample);
      assert.equal(displaySessionTitle(once), once, sample);
    }
  });

  it('never shows a known secret spelled with markdown-looking runs', () => {
    maskWithLiteral();
    for (const raw of [`use ${LITERAL} now`, `**${LITERAL}**`, `<coordination>x</coordination> ${LITERAL}`]) {
      const shown = displaySessionTitle(raw);
      assert.ok(shown.includes('[masked:'), shown);
      assert.ok(!shown.includes('0123456789') && !shown.includes('abc') && !shown.includes('ghi'), shown);
    }
  });

  it('restores the stored secret when a renamed title keeps its marker', () => {
    maskWithLiteral();
    const stored = `<nassaj_document_sharing>g</nassaj_document_sharing> key ${LITERAL} here`;
    const shown = displaySessionTitle(stored);
    const edited = shown.replace('here', 'there');
    assert.equal(restoreMaskedLabel(edited, titleTextBeforeMask(stored)), `key ${LITERAL} there`);
  });
});

describe('displaySearchText', () => {
  it('masks before stripping markdown, and keeps the lines', () => {
    maskWithLiteral();
    const mask = (text: string) => text.replace(LITERAL, '[masked:known-secret]');
    const shown = displaySearchText(`# Title\n**bold** ${LITERAL}\n${IMAGES}`, mask);
    assert.equal(shown.includes(LITERAL), false);
    assert.match(shown, /^Title\nbold \[masked:known-secret\]/);
  });
});
