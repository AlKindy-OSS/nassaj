import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __setAgyModelsRunnerForTests,
  parseAgyModelsOutput,
  readAntigravityModelsFromCli,
} from '@/modules/providers/list/antigravity/antigravity-models-cli.client.js';
import { ANTIGRAVITY_FALLBACK_MODELS } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';

// A verbatim capture of `agy models` (v1.1.1) stdout: one display LABEL per
// line — exactly what agy's `--model` flag accepts.
const AGY_MODELS_STDOUT = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
  '',
].join('\n');

// ---------------- parseAgyModelsOutput (pure) ----------------

test('parseAgyModelsOutput: one option per line, value === label, "auto" prepended', () => {
  const result = parseAgyModelsOutput(AGY_MODELS_STDOUT);

  assert.ok(result);
  assert.equal(result.OPTIONS[0].value, 'auto');
  assert.equal(result.OPTIONS[0].label, 'agy default');
  assert.equal(result.DEFAULT, ANTIGRAVITY_FALLBACK_MODELS.DEFAULT);

  // A real label survives as BOTH value and label (what agy --model wants).
  const opus = result.OPTIONS.find((o) => o.label === 'Claude Opus 4.6 (Thinking)');
  assert.ok(opus, 'the label is present');
  assert.equal(opus.value, opus.label, 'value equals label so pickAgyModelLabel resolves it');

  // 8 model lines + the prepended auto = 9 options, empty line dropped.
  assert.equal(result.OPTIONS.length, 9);
});

test('parseAgyModelsOutput: trims, dedupes, and skips a stray "auto" line', () => {
  const result = parseAgyModelsOutput('  Gemini 3 Pro  \nGemini 3 Pro\nauto\nAUTO\n');

  assert.ok(result);
  // Only one canonical auto (prepended), plus the single de-duplicated model.
  assert.deepEqual(
    result.OPTIONS.map((o) => o.label),
    ['agy default', 'Gemini 3 Pro'],
  );
});

test('parseAgyModelsOutput: returns null for empty / whitespace / non-string', () => {
  assert.equal(parseAgyModelsOutput(''), null);
  assert.equal(parseAgyModelsOutput('   \n\n  '), null);
  assert.equal(parseAgyModelsOutput(undefined), null);
  assert.equal(parseAgyModelsOutput(null), null);
  assert.equal(parseAgyModelsOutput(42), null);
});

// ---------------- readAntigravityModelsFromCli (injected runner) ----------------

test('readAntigravityModelsFromCli: parses the injected runner stdout', async () => {
  __setAgyModelsRunnerForTests(async () => AGY_MODELS_STDOUT);
  try {
    const result = await readAntigravityModelsFromCli();
    assert.ok(result);
    assert.ok(result.OPTIONS.some((o) => o.label === 'GPT-OSS 120B (Medium)'));
  } finally {
    __setAgyModelsRunnerForTests(null);
  }
});

test('readAntigravityModelsFromCli: returns null when the runner yields null (binary missing/timeout)', async () => {
  __setAgyModelsRunnerForTests(async () => null);
  try {
    assert.equal(await readAntigravityModelsFromCli(), null);
  } finally {
    __setAgyModelsRunnerForTests(null);
  }
});

test('readAntigravityModelsFromCli: never throws even if the runner rejects', async () => {
  __setAgyModelsRunnerForTests(async () => {
    throw new Error('spawn EACCES');
  });
  try {
    assert.equal(await readAntigravityModelsFromCli(), null);
  } finally {
    __setAgyModelsRunnerForTests(null);
  }
});
