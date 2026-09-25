import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DOCUMENT_SHARING_INSTRUCTIONS, getRuntimeInstructions, stripRuntimeInstructionsPrefix,
  withRuntimeInstructions,
} from './documentSharingInstructions.js';
import { buildPublicPageInstructions } from './publicPageGuidance.js';

const PUBLISHER = '/opt/nassaj/dist-server/UPDATE_RUNTIME_BUNDLE/scripts/public-page-publish.mjs';
const ROOT = '/home/operator/.local/share/nassaj-dev/public-content';
const ORIGIN = 'https://nassaj.example.com';
const PLACE = { publisherPath: PUBLISHER, contentRoot: ROOT, origin: ORIGIN };

test('sharing guidance is always present without changing coordination semantics', () => {
  for (const level of ['direct', 'delegate', 'delegate_review', 'invalid', undefined]) {
    const instructions = getRuntimeInstructions(level);
    assert.equal(instructions.split(DOCUMENT_SHARING_INSTRUCTIONS).length, 2);
    if (level === 'direct' || level === 'invalid') assert.doesNotMatch(instructions, /Coordination level for this turn/);
  }
});

test('outbound prompt retains exact user bytes and does not repeat its own wrapper', () => {
  const command = '  عربي\n<coordination>literal</coordination>\n';
  for (const level of ['direct', 'delegate', 'delegate_review']) {
    const wrapped = withRuntimeInstructions(command, level, PLACE);
    assert.ok(wrapped.endsWith(`\n\n${command}`));
    assert.equal(withRuntimeInstructions(wrapped, level, PLACE), wrapped);
    assert.equal(wrapped.split(DOCUMENT_SHARING_INSTRUCTIONS).length, 2);
  }
});

test('all seven CLI launchers import the shared outbound wrapper', () => {
  for (const file of ['agy-cli', 'hermes-cli', 'opencode-cli', 'qwen-cli', 'kimi-agent-cli', 'cursor-cli']) {
    const source = readFileSync(new URL(`../server/${file}.js`, import.meta.url), 'utf8');
    assert.match(source, /withRuntimeInstructions as withCoordinationDirective.*runtime-instructions/);
    assert.match(source, /withCoordinationDirective\(/);
  }
});

test('native instruction channels carry guidance without rewriting the user command', () => {
  const channels = [
    ['../server/claude-sdk.js', /append: getRuntimeInstructions\(coordinationLevel\)/],
    ['../server/openai-codex.js', /developer_instructions: getRuntimeInstructions\(options\?\.coordinationLevel\)/],
    ['../server/modules/providers/shared/vendor/vendor-runtime.js', /getRuntimeInstructions\(options\?\.coordinationLevel\)/],
  ] as const;
  for (const [file, channel] of channels) assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), channel);
});

/**
 * T-1804 — إرشاد نشر الصفحات العامّة يركب القناة نفسها، فيصل كلّ مزوّد، بمسار
 * الناشر الفعليّ على هذا الجهاز لا بمسارٍ نسبيٍّ لا يعمل من cwd الوكيل.
 */
test('public page guidance rides the one channel that reaches every provider', () => {
  const guidance = buildPublicPageInstructions(PLACE);
  for (const level of ['direct', 'delegate', 'delegate_review', 'invalid', undefined]) {
    assert.equal(getRuntimeInstructions(level, PLACE).split(guidance).length, 2, String(level));
  }
  const wrapped = withRuntimeInstructions('اكتب لي صفحة', 'delegate', PLACE);
  assert.equal(wrapped.split(guidance).length, 2);
  assert.ok(wrapped.includes(`node ${PUBLISHER} publish`), 'الإرشاد بلا أمرٍ صالحٍ للتنفيذ بلا قيمة');
  assert.doesNotMatch(wrapped, /node scripts\//, 'مسارٌ نسبيّ لا يعمل من cwd الوكيل');
});

test('the injected command carries the SERVER-resolved content root', () => {
  // بيئة الطفل تحمل HOME/XDG_DATA_HOME مبدَّلين، فبلا `--root` ينشر الوكيل في
  // جذرٍ لا يقرؤه الخادم: «published» ثمّ 404.
  assert.ok(getRuntimeInstructions('direct', PLACE).includes(`--root ${ROOT}`));
});

test('a path with a space is quoted so the command stays runnable', () => {
  const spaced = '/opt/my nassaj/scripts/public-page-publish.mjs';
  assert.ok(getRuntimeInstructions('direct', { ...PLACE, publisherPath: spaced }).includes(`node '${spaced}' publish`));
});

test('no content root means the feature is off, so no command is promised', () => {
  const off = getRuntimeInstructions('delegate', { ...PLACE, contentRoot: null });
  assert.match(off, /Never write page, site or user content/);
  assert.doesNotMatch(off, /To publish one/);
});

test('with no publisher the injected guidance keeps the rule and drops the command', () => {
  const instructions = getRuntimeInstructions('delegate', { ...PLACE, publisherPath: null });
  assert.match(instructions, /Never write page, site or user content inside the Nassaj installation tree/);
  assert.doesNotMatch(instructions, /public-page-publish|To publish one/);
});

/**
 * الاختبارُ الأعمى (وكيل لا يعرف إلا الكتلة المحقونة) أعطى
 * «https://<نطاق-نسّاج>/…» لأنّه لا يعرف الأصل، وكتب ملفّات المصدر داخل جذر
 * المحتوى. هذان السطران يقفلان الدرسين.
 */
test('a trusted origin turns the result into an absolute URL', () => {
  assert.ok(getRuntimeInstructions('direct', PLACE).includes(`served at ${ORIGIN}/<id>/`));
});

test('without a trusted origin the text stays relative and invents no domain', () => {
  const text = getRuntimeInstructions('direct', { ...PLACE, origin: null });
  assert.ok(text.includes('served at /<id>/ on this Nassaj origin'));
  assert.doesNotMatch(text, /https?:\/\//, 'لا نطاقَ مُختلَقاً ولا مُستنتَجاً من الطلب');
});

test('the agent is told where the SOURCE files belong, not only where they must not go', () => {
  const text = getRuntimeInstructions('direct', PLACE);
  assert.ok(text.includes('write the page files in your own project directory (never under --root)'));
});

test('the public page block is distinguished from the document sharing block beside it', () => {
  const guidance = buildPublicPageInstructions(PLACE);
  assert.match(guidance, /not the members\/client document Share action/);
  // التمييز إشارةٌ لا إعادةُ شرح: لا يُنسخ سطرٌ من الكتلة المجاورة.
  for (const line of DOCUMENT_SHARING_INSTRUCTIONS.split('\n')) assert.ok(!guidance.includes(line), line);
});

/** الأشكال المخزّنة — بمسارٍ مغاير، أو بما قبل T-1804 — كلُّها تُقصّ بنيويّاً. */
test('the prefix is stripped structurally, whatever publisher path it was stored with', () => {
  const body = '<coordination>\nx\n</coordination>\n\nانشر لي صفحة';
  for (const stored of [PUBLISHER, '/somewhere/else/public-page-publish.mjs', null]) {
    assert.equal(stripRuntimeInstructionsPrefix(withRuntimeInstructions(body, 'direct', { ...PLACE, publisherPath: stored })), body, String(stored));
  }
});

test('stripping never removes user text that merely resembles the wrapper', () => {
  for (const content of [
    'plain user text',
    `<nassaj_public_pages>\nnot at the front\n</nassaj_public_pages>\n\nx`.slice(1),
    `${withRuntimeInstructions('hello', 'direct', PLACE)}\nextra`,
  ]) {
    const stripped = stripRuntimeInstructionsPrefix(content);
    assert.ok(content.endsWith(stripped), content.slice(0, 40));
  }
});

test('no launcher carries its own copy of the publish command', () => {
  const launchers = [
    'claude-sdk', 'openai-codex', 'agy-cli', 'hermes-cli',
    'opencode-cli', 'qwen-cli', 'kimi-agent-cli', 'cursor-cli',
  ];
  for (const file of launchers) {
    const source = readFileSync(new URL(`../server/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /public-page-publish\.mjs publish/, `${file}: نسخة ثانية من النصّ`);
  }
});
