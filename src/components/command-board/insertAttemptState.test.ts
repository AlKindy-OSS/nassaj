/**
 * insertAttemptState.test.ts — B-261: a refusal is an attempt record, not a
 * system state.
 *
 * The incident, in the audit log: the owner clicked Execute on a Diwan repair
 * command at 04:04:48, 04:05:18 and 04:06:01. Between the second and third click
 * they fixed the problem from their own terminal (the pm2 processes came up at
 * 04:05:04). The red line under the code block never changed through any of it,
 * and they read it as «my fix did not work».
 *
 * Two separate defects produced that reading, and a fix for either alone leaves
 * it standing:
 *
 *   1. The state was a bare string. Re-setting the same string to the same value
 *      renders identically — a landed click and a frozen screen look the same.
 *      Clearing on content change does NOT help here: the block text never
 *      changed, so that effect never fires on a repeat click.
 *   2. A deliberate refusal was painted in the same red, with the same
 *      role="alert", as an actual malfunction — so a guard doing its job
 *      announced itself in the visual language of a breakage.
 *
 * These tests cover the pure logic behind both. The rendering that consumes it
 * is pinned by source guards at the bottom, because reproducing it live needs a
 * ChatActions context, an armed board and a raw tier — the same combination that
 * kept this path untested while two bugs accumulated in it.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isMalfunction, nextInsertError, type InsertErrorState } from './rawInsertResponse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../..');

const DENIED = 'denied_command:pm2_lifecycle';
const MSG = 'Blocked: this command disrupts a live service (rule: pm2_lifecycle).';

describe('B-261 — a repeated click is visible even when nothing else changes', () => {
  it('counts the second identical refusal instead of re-rendering the same thing', () => {
    const first = nextInsertError(null, DENIED, MSG, 1_000);
    const second = nextInsertError(first, DENIED, MSG, 2_000);

    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    // The text is identical by definition here — the count is the only signal
    // that distinguishes «your click landed» from «the screen is stuck».
    expect(second.message).toBe(first.message);
  });

  it('reproduces the three clicks of the incident as 1 → 2 → 3', () => {
    let state: InsertErrorState | null = null;
    for (const at of [1_000, 2_000, 3_000]) state = nextInsertError(state, DENIED, MSG, at);
    expect(state?.attempt).toBe(3);
  });

  it('dates each attempt to its own click', () => {
    const first = nextInsertError(null, DENIED, MSG, 1_000);
    const second = nextInsertError(first, DENIED, MSG, 2_000);
    // Without this the line cannot say WHICH moment it describes, which is what
    // let a refusal from a minute earlier read as the current system state.
    expect(second.at).toBe(2_000);
    expect(second.at).not.toBe(first.at);
  });

  it('starts over when the verdict changes — a new code is not a repetition', () => {
    const denied = nextInsertError(null, DENIED, MSG, 1_000);
    const tooLong = nextInsertError(denied, 'command_too_long', 'Command too long', 2_000);

    expect(tooLong.attempt).toBe(1);
    expect(tooLong.code).toBe('command_too_long');
  });

  it('treats two different deny rules as different verdicts', () => {
    const pm2 = nextInsertError(null, 'denied_command:pm2_lifecycle', MSG, 1_000);
    const systemd = nextInsertError(pm2, 'denied_command:systemctl_lifecycle', MSG, 2_000);
    expect(systemd.attempt).toBe(1);
  });

  it('carries an updated message forward under the same code', () => {
    const first = nextInsertError(null, 'internal', 'old', 1_000);
    const second = nextInsertError(first, 'internal', 'new', 2_000);
    expect(second.message).toBe('new');
    expect(second.attempt).toBe(2);
  });
});

describe('B-261 — only a malfunction is styled as an error', () => {
  it('classifies internal as a malfunction', () => {
    expect(isMalfunction('internal')).toBe(true);
  });

  it.each([
    'denied_command:pm2_lifecycle',
    'forbidden_control_char',
    'carriage_return_forbidden',
    'too_many_lines',
    'command_too_long',
    'too_many_commands',
    'raw_exec_disabled',
    'config_denied',
    'empty_command',
  ])('does NOT classify the deliberate refusal %s as a malfunction', (code) => {
    // Every one of these is the server working as designed. B-260 fixed the
    // wording; this keeps the colour and the ARIA role honest too.
    expect(isMalfunction(code)).toBe(false);
  });
});

describe('B-261 source guards — the code block renders the attempt record', () => {
  const markdown = readFileSync(
    resolve(REPO, 'src/components/chat/view/subcomponents/Markdown.tsx'),
    'utf8',
  );

  it('picks the ARIA role from the classification, not a constant', () => {
    expect(markdown).toMatch(/role=\{isMalfunction\(insertError\.code\) \? 'alert' : 'status'\}/);
  });

  it('offers a way to dismiss the line', () => {
    expect(markdown).toMatch(/onClick=\{\(\) => setInsertError\(null\)\}/);
    expect(markdown).toMatch(/insertError\.dismiss/);
  });

  it('shows the repeat stamp once the attempt count passes one', () => {
    expect(markdown).toMatch(/insertError\.attempt > 1/);
    expect(markdown).toMatch(/insertError\.stampRepeat/);
  });

  it('clears the line when the block content changes', () => {
    expect(markdown).toMatch(/setInsertError\(null\);\n\s*\}, \[raw\]\)/);
  });

  it('no longer wipes the line at the start of the next attempt', () => {
    // Clearing there made an about-to-repeat refusal blink out and back with
    // nothing changed — motion that carries no information.
    const handler = markdown.slice(markdown.indexOf('const handleRawExec'));
    const beforeFetch = handler.slice(0, handler.indexOf('authenticatedFetch'));
    expect(beforeFetch).not.toMatch(/setInsertError\(null\)/);
  });
});

describe('B-261 — every locale can render the stamp', () => {
  const LOCALES = ['ar', 'de', 'en', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN'];

  it.each(LOCALES)('%s has stamp, stampRepeat and dismiss', (locale) => {
    const bundle = JSON.parse(
      readFileSync(resolve(REPO, `src/i18n/locales/${locale}/chat.json`), 'utf8'),
    );
    const box = bundle.codeBlock.insertError as Record<string, string>;

    expect(box.stamp).toBeTypeOf('string');
    expect(box.stampRepeat).toBeTypeOf('string');
    expect(box.dismiss).toBeTypeOf('string');
    // A stamp without its placeholders would silently drop the very facts the
    // line exists to carry.
    expect(box.stamp).toContain('{{time}}');
    expect(box.stampRepeat).toContain('{{time}}');
    expect(box.stampRepeat).toContain('{{count}}');
  });
});
