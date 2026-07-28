/**
 * insertErrorCoverage.test.ts — B-260: a guard that fires must not report itself
 * as a malfunction.
 *
 * What the owner saw: pasting a Diwan repair command into a chat code block and
 * pressing Execute produced «Failed to add command to queue». Nothing had
 * failed. The command contained `pm2 delete`, and the raw denylist refused it on
 * purpose — that rule exists because pm2 lifecycle verbs wedged port 3004 and
 * took nassaj.example.com down for ~3 hours, twice (B-95).
 *
 * The refusal arrives as `denied_command:pm2_lifecycle`. Neither client resolver
 * matched the `denied_command:` prefix, so it fell through to the catch-all
 * 'internal', whose text describes a broken feature. The owner therefore got the
 * least useful reading of the most deliberate outcome: no reason, no rule, and
 * no hint that the fix is to run it in their own terminal.
 *
 * `forbidden_control_char` — the Trojan-Source scanner — was missing from the
 * chat map for the same reason and reported the same way.
 *
 * This test enumerates the refusal codes from the SERVER source rather than a
 * hand-written list, so a new deny rule or a new validation code cannot be added
 * without a message to go with it. That is the property that actually failed
 * here: not a wrong string, but a map that silently absorbed unknown codes.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import enChat from '../../i18n/locales/en/chat.json';
import enSettings from '../../i18n/locales/en/settings.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../..');

const rawSource = readFileSync(resolve(REPO, 'server/services/command-board-raw.js'), 'utf8');

/** Every `{ ok: false, error: '<code>' }` the insert path can return. */
function serverInsertCodes(): string[] {
  const codes = new Set<string>();
  for (const m of rawSource.matchAll(/ok: false, error: '([a-z_]+)'/g)) codes.add(m[1]);
  // Template form: `denied_command:${denied}` — collapsed to its prefix, which
  // is what the client matches on.
  if (/ok: false, error: `denied_command:/.test(rawSource)) codes.add('denied_command');
  return [...codes];
}

/** Every denylist rule code, so the {{rule}} placeholder has real values. */
function denyRuleCodes(): string[] {
  return [...rawSource.matchAll(/code: '([a-z0-9_]+)',\n\s*re: new RegExp/g)].map((m) => m[1]);
}

const chatMap = enChat.codeBlock.insertError as Record<string, string>;
const settingsMap =
  enSettings.commandBoardSettings.rawExec.queue.addError as Record<string, string>;

/** Codes produced only by the EXECUTE path; the insert box never shows them. */
const EXECUTE_ONLY = new Set(['not_found', 'digest_mismatch']);

describe('B-260 — every server refusal has its own message', () => {
  const codes = serverInsertCodes().filter((c) => !EXECUTE_ONLY.has(c));

  it('the server actually produces the codes this test guards', () => {
    // Fails loudly if the extraction regex stops matching, instead of passing an
    // empty set and proving nothing.
    expect(codes).toContain('denied_command');
    expect(codes).toContain('forbidden_control_char');
    expect(codes.length).toBeGreaterThanOrEqual(6);
  });

  it.each(['denied_command', 'forbidden_control_char'])(
    'the chat code block explains %s instead of falling back to internal',
    (code) => {
      expect(chatMap[code]).toBeTypeOf('string');
      expect(chatMap[code]).not.toBe(chatMap.internal);
    },
  );

  it('no insert refusal falls through to the generic failure text', () => {
    const unmapped = codes.filter((c) => c !== 'internal' && !chatMap[c]);
    expect(unmapped).toEqual([]);
  });

  it('the settings enqueue box explains a denied command too', () => {
    expect(settingsMap.denied_command).toBeTypeOf('string');
    expect(settingsMap.denied_command).not.toBe(settingsMap.internal);
  });

  it('both surfaces explain the same refusal the same way', () => {
    expect(settingsMap.denied_command).toBe(chatMap.denied_command);
  });
});

describe('B-260 — the message names the rule and the way out', () => {
  it('interpolates the rule that blocked the command', () => {
    expect(chatMap.denied_command).toContain('{{rule}}');
  });

  it('tells the owner where the command CAN be run', () => {
    // Without this the message is a dead end: correct, and still useless.
    expect(chatMap.denied_command.toLowerCase()).toContain('terminal');
  });

  it('pm2_lifecycle is still a real rule code, so {{rule}} is not decorative', () => {
    expect(denyRuleCodes()).toContain('pm2_lifecycle');
  });
});

// ── The EXECUTE path (B-276) ─────────────────────────────────────────────────
//
// B-260 mapped every refusal the INSERT route can answer. The execute route was
// left with the same hole, and it is the more dangerous of the two: it re-runs
// the denylist and the Trojan-Source scan, and it can refuse with 503
// audit_unavailable — the case where nothing ran BECAUSE the audit could not be
// written. All three landed on «Internal server error.»
//
// Worse, a command that restarts the server was reported the same way: the reply
// dies with the socket, the client's catch fires, and a restart that had just
// succeeded was announced as an internal fault. Measured on 2026-07-28: the
// audit holds exec_start at 16:19:47 and nassaj-dev came up in that same second.

describe('B-276 — the execute path explains its own refusals', () => {
  const dialog = readFileSync(
    resolve(REPO, 'src/components/command-board/ExecReviewDialog.tsx'),
    'utf8',
  );
  const dialogMap =
    enSettings.commandBoardSettings.rawExec.dialog as unknown as Record<string, string>;

  it('matches denied_command by prefix, like the insert surfaces do', () => {
    expect(dialog).toMatch(/startsWith\('denied_command:'\)/);
    expect(dialogMap.denied_command).toBeTypeOf('string');
    // One refusal, one wording, wherever the owner meets it.
    expect(dialogMap.denied_command).toBe(chatMap.denied_command);
  });

  it('explains a refused-because-unauditable execution', () => {
    // The distinguishing fact is that NOTHING ran; 'internal' implied the opposite.
    expect(dialog).toContain('audit_unavailable');
    expect(dialogMap.audit_unavailable).toBeTypeOf('string');
    expect(dialogMap.audit_unavailable).not.toBe(dialogMap.internal);
  });

  it('reads a dead socket after the POST as a restart, not a fault', () => {
    // The same reading useServerActions.execute and runActionByType already use.
    expect(dialog).toMatch(/startPolling\(\)/);
    expect(dialogMap.restarting).toBeTypeOf('string');
    expect(dialogMap.restartSuccess).toBeTypeOf('string');
  });

  it('no longer reports that silence as an internal error', () => {
    const tail = dialog.slice(dialog.indexOf('} catch {', dialog.indexOf('handleExecute')));
    const catchBlock = tail.slice(0, tail.indexOf('} finally'));
    expect(catchBlock).not.toMatch(/setExecError/);
  });

  it('B-278: also treats a codeless non-ok reply as a restart, not a fault', () => {
    // The owner reaches the app through a cloudflared tunnel, and a tunnel does
    // not drop the request when the origin dies — it ANSWERS it with a bare 502.
    // So fetch resolves rather than throwing, and the catch-based fix above never
    // runs. Every error THIS route produces carries a `code`; a non-ok reply
    // without one did not come from the route.
    expect(dialog).toMatch(/!res\.ok && typeof data\.code !== 'string'/);
  });

  it('B-278: the codeless check precedes the code-to-message mapping', () => {
    // Ordering is the whole fix: `String(data.code ?? 'internal')` turns a bodyless
    // 502 into the literal 'internal' code, after which it is indistinguishable
    // from a real server fault.
    const body = dialog.slice(dialog.indexOf('handleExecute'));
    const guard = body.indexOf("typeof data.code !== 'string'");
    const coalesce = body.indexOf("String(data.code ?? 'internal')");
    expect(guard).toBeGreaterThan(-1);
    expect(coalesce).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(coalesce);
  });

  it.each(['ar', 'de', 'en', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN'])(
    '%s carries all four dialog messages',
    (locale) => {
      const bundle = JSON.parse(
        readFileSync(resolve(REPO, `src/i18n/locales/${locale}/settings.json`), 'utf8'),
      );
      const d = bundle.commandBoardSettings.rawExec.dialog as Record<string, string>;
      for (const k of ['denied_command', 'audit_unavailable', 'restarting', 'restartSuccess']) {
        expect(d[k], `${locale}.${k}`).toBeTypeOf('string');
      }
      expect(d.denied_command).toContain('{{rule}}');
    },
  );
});

// ── Provenance (B-277) ───────────────────────────────────────────────────────
//
// A row reached the queue on 2026-07-27 with no matching `insert` entry in the
// audit log and no requester — written straight into app_config, around the
// denylist and around the mandatory audit. It is not a privilege escalation
// (whoever writes that file already holds the service uid), it is a TRUST gap:
// the reviewer rendered it exactly like a row that came through the vetted path,
// so it borrowed a credibility nothing had established.
//
// The chosen fix shows the gap rather than blocking the row — blocking would
// also kill legitimate scheduling. These guards keep the disclosure in place,
// and keep it claiming only what is observable: the requester is unrecorded.

describe('B-277 — an unattributed command says so', () => {
  const dialog = readFileSync(
    resolve(REPO, 'src/components/command-board/ExecReviewDialog.tsx'),
    'utf8',
  );
  const panel = readFileSync(
    resolve(REPO, 'src/components/sidebar/view/subcomponents/PendingActionsPanel.tsx'),
    'utf8',
  );

  it('the review dialog branches on requestedBy instead of hiding its absence', () => {
    // The old code rendered the requester only when present, so «unknown» and
    // «not shown» looked identical at the exact moment of deciding to execute.
    expect(dialog).toMatch(/target\?\.requestedBy \?/);
    expect(dialog).toContain('dialog.unattributed');
  });

  it('the queue row in the board flags it too', () => {
    expect(panel).toMatch(/cmd\.requestedBy \?/);
    expect(panel).toContain('pendingActions.rawUnattributed');
  });

  it.each(['ar', 'de', 'en', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN'])(
    '%s can render the disclosure in both places',
    (locale) => {
      const settings = JSON.parse(
        readFileSync(resolve(REPO, `src/i18n/locales/${locale}/settings.json`), 'utf8'),
      );
      const sidebar = JSON.parse(
        readFileSync(resolve(REPO, `src/i18n/locales/${locale}/sidebar.json`), 'utf8'),
      );
      const d = settings.commandBoardSettings.rawExec.dialog as Record<string, string>;
      expect(d.unattributed).toBeTypeOf('string');
      expect(d.requestedBy).toContain('{{name}}');
      expect(sidebar.pendingActions.rawUnattributed).toBeTypeOf('string');
    },
  );

  it('claims only that the requester is unrecorded, not how it got there', () => {
    // Why it is unrecorded is a hypothesis with evidence (B-277); the UI must not
    // assert a bypass it cannot observe from a single null field.
    const en = enSettings.commandBoardSettings.rawExec.dialog as unknown as Record<string, string>;
    expect(en.unattributed.toLowerCase()).toContain('recorded');
    expect(en.unattributed.toLowerCase()).not.toContain('bypass');
  });
});

describe('B-260 — both resolvers match the code by prefix', () => {
  it.each([
    ['src/components/chat/view/subcomponents/Markdown.tsx'],
    ['src/components/settings/view/tabs/CommandBoardSettingsTab.tsx'],
  ])('%s handles denied_command:<rule>', (file) => {
    const source = readFileSync(resolve(REPO, file), 'utf8');
    expect(source).toMatch(/startsWith\('denied_command:'\)/);
  });
});
