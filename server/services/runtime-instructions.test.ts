/**
 * T-1804 — كلُّ مُشعِلٍ يمرّ بالواجهة التي تحلّ مسار الناشر، لا بالوحدة النقيّة.
 *
 * العطبُ الذي يقفله هذا الملفّ ليس منطقيّاً بل «تسرُّبُ استيراد»: مُشعِلٌ واحد
 * يستورد `shared/documentSharingInstructions.js` مباشرةً يستقبل المُعامل
 * الافتراضي `null`، فيُحقن في جولاته سطرُ المنع بلا أمرٍ بديل بينما تحصل بقيّة
 * المزوّدات على الأمر — فرقٌ صامتٌ لا يكشفه اختبارُ نصٍّ ولا typecheck.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { QUICK_REPLY_TAG, stripRuntimeInstructionsPrefix } from '../../shared/documentSharingInstructions.js';
import {
  CODEX_HELPERS_OFF_REASONS, codexTurnDeveloperInstructions,
} from '../modules/providers/list/codex/codex-helpers-switch.js';

import {
  getRuntimeInstructions, quickReplyGuidanceEnabled, withRuntimeInstructions,
} from './runtime-instructions.js';
import { resolvePublicPagePublisher } from './public-page-agent-guidance.js';

/** المُشعِلات، بمسارها من جذر المستودع. */
const LAUNCHERS = [
  'server/claude-sdk.js', 'server/openai-codex.js', 'server/agy-cli.js',
  'server/opencode-cli.js', 'server/qwen-cli.js', 'server/kimi-agent-cli.js', 'server/cursor-cli.js',
  'server/modules/providers/shared/vendor/vendor-runtime.js',
];

test('every launcher imports the resolving facade, and none the pure module directly', () => {
  for (const launcher of LAUNCHERS) {
    const source = readFileSync(new URL(`../../${launcher}`, import.meta.url), 'utf8');
    assert.match(source, /RuntimeInstructions[^\n]*from '[^']*runtime-instructions\.js'/, launcher);
    assert.doesNotMatch(source, /from '[^']*documentSharingInstructions\.js'/, `${launcher}: تجاوزَ الحلّ`);
  }
});

test('the facade injects this host’s resolved publisher, not a relative path', () => {
  const resolved = resolvePublicPagePublisher();
  const instructions = getRuntimeInstructions('delegate');
  assert.doesNotMatch(instructions, /node scripts\//, 'مسارٌ نسبيّ لا يعمل من cwd الوكيل');
  if (resolved) {
    assert.ok(instructions.includes(`node ${resolved} publish`), 'الأمر المحقون ليس مسار هذا الجهاز');
    assert.ok(withRuntimeInstructions('مرحبا', 'direct').includes(resolved), 'قناة المطالبة تخلّفت عن القناة الأصيلة');
  } else {
    assert.doesNotMatch(instructions, /public-page-publish/, 'وعدٌ بأداةٍ غائبة');
  }
});

/* ---------------------------------------------------------------------------
 * T-2027 / ADR-209 — quick-reply guidance: operator flag and per-channel delivery.
 * ------------------------------------------------------------------------- */

const OPEN = `<${QUICK_REPLY_TAG}>`;
const tagCount = (text: string): number => text.split(OPEN).length - 1;

/** Runs `fn` with NASSAJ_QUICK_REPLY_GUIDANCE set to `value` (undefined = unset). */
function withFlag<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.NASSAJ_QUICK_REPLY_GUIDANCE;
  if (value === undefined) delete process.env.NASSAJ_QUICK_REPLY_GUIDANCE;
  else process.env.NASSAJ_QUICK_REPLY_GUIDANCE = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.NASSAJ_QUICK_REPLY_GUIDANCE;
    else process.env.NASSAJ_QUICK_REPLY_GUIDANCE = saved;
  }
}

test('flag: unset and "1" keep it ON; only strict "0" and "off" turn it OFF', () => {
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, true], ['1', true], ['', true], ['on', true], ['false', true],
    ['0', false], ['off', false], [' OFF ', false],
  ];
  for (const [value, on] of cases) {
    assert.equal(quickReplyGuidanceEnabled(value === undefined ? {} : { NASSAJ_QUICK_REPLY_GUIDANCE: value }), on, String(value));
    withFlag(value, () => {
      assert.equal(tagCount(getRuntimeInstructions('delegate')), on ? 1 : 0, `native ${String(value)}`);
      assert.equal(tagCount(withRuntimeInstructions('hi', 'delegate')), on ? 1 : 0, `prefix ${String(value)}`);
    });
  }
});

/** Each channel and the exact call that carries the facade output to the engine. */
const CHANNEL_SOURCES: Array<[string, RegExp]> = [
  ['server/claude-sdk.js', /append: getRuntimeInstructions\(coordinationLevel\)/],
  ['server/openai-codex.js', /codexTurnDeveloperInstructions\(\s*options\?\.coordinationLevel, helpersDecision, getRuntimeInstructions,/],
  ['server/modules/providers/shared/vendor/vendor-runtime.js', /system: coordinationDirective/],
  ['server/agy-cli.js', /commandToSend = withCoordinationDirective\(commandToSend, opts\.coordinationLevel\)/],
  ['server/cursor-cli.js', /'-p', withCoordinationDirective\(command, options\.coordinationLevel\)/],
  ['server/opencode-cli.js', /promptToSend = withCoordinationDirective\(/],
  ['server/kimi-agent-cli.js', /command: withCoordinationDirective\(command, coordinationLevel\)/],
  ['server/qwen-cli.js', /'--prompt', withCoordinationDirective\(command, options\?\.coordinationLevel\)/],
];

test('every delivery channel still routes through the facade at its launch site', () => {
  for (const [file, call] of CHANNEL_SOURCES) {
    assert.match(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), call, file);
  }
});

test('native channels (Claude append, vendor system field) carry the tag exactly once', () => {
  withFlag(undefined, () => {
    for (const level of ['direct', 'delegate', 'delegate_review', undefined]) {
      assert.equal(tagCount(getRuntimeInstructions(level)), 1, String(level));
    }
  });
});

test('Codex developer_instructions carry the tag exactly once on B = 1 and on every B = 0 reason', () => {
  withFlag(undefined, () => {
    const on = { helpers: true, reason: null, cpu: null };
    assert.equal(tagCount(codexTurnDeveloperInstructions('delegate', on, getRuntimeInstructions)), 1);
    for (const reason of CODEX_HELPERS_OFF_REASONS) {
      const off = { helpers: false, reason, cpu: null };
      assert.equal(tagCount(codexTurnDeveloperInstructions('delegate', off, getRuntimeInstructions)), 1, reason);
    }
  });
});

test('prefix providers carry the tag exactly once every turn, and the visible text is clean', () => {
  withFlag(undefined, () => {
    for (const turn of ['first turn', 'second turn', '']) {
      const sent = withRuntimeInstructions(turn, 'delegate');
      assert.equal(tagCount(sent), 1, turn);
      assert.equal(tagCount(withRuntimeInstructions(sent, 'delegate')), 1, `${turn}: re-wrap`);
      assert.equal(tagCount(stripRuntimeInstructionsPrefix(sent)), 0, `${turn}: visible`);
      assert.ok(stripRuntimeInstructionsPrefix(sent).endsWith(turn));
    }
  });
});
