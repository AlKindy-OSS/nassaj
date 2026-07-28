import assert from 'node:assert/strict';
import test from 'node:test';

import { extractLastLabel } from '@/modules/providers/services/antigravity-active-model.service.js';

const OVERRIDE = (label: string): string =>
  `I0527 04:04:33.078175 32270 model_config_manager.go:157] Propagating selected model override to backend: label="${label}"`;

test('extractLastLabel: returns null when no override line is present', () => {
  const contents = [
    'I0527 04:04:30.000000 32270 startup.go:10] booting',
    'I0527 04:04:31.000000 32270 model_config_manager.go:1] unrelated line',
  ].join('\n');

  assert.equal(extractLastLabel(contents), null);
});

test('extractLastLabel: returns null for empty input', () => {
  assert.equal(extractLastLabel(''), null);
});

test('extractLastLabel: returns the label from a single match', () => {
  const contents = OVERRIDE('Gemini 3.5 Flash (Medium)');
  assert.equal(extractLastLabel(contents), 'Gemini 3.5 Flash (Medium)');
});

test('extractLastLabel: returns the LAST label when multiple matches exist', () => {
  const contents = [
    OVERRIDE('Gemini 2.0 Pro'),
    'I0527 04:04:32.000000 32270 model_config_manager.go:157] some other log',
    OVERRIDE('Gemini 3.5 Flash (Low)'),
    OVERRIDE('Gemini 3.5 Flash (Medium)'),
  ].join('\n');

  assert.equal(extractLastLabel(contents), 'Gemini 3.5 Flash (Medium)');
});

test('extractLastLabel: empty label string yields null', () => {
  const contents = OVERRIDE('');
  assert.equal(extractLastLabel(contents), null);
});

test('extractLastLabel: whitespace-only label yields null', () => {
  const contents = OVERRIDE('    ');
  assert.equal(extractLastLabel(contents), null);
});

test('extractLastLabel: trims surrounding whitespace from the label', () => {
  const contents = OVERRIDE('  Gemini 3.5 Flash (Medium)  ');
  assert.equal(extractLastLabel(contents), 'Gemini 3.5 Flash (Medium)');
});

test('extractLastLabel: preserves inner spacing and parentheses in the label', () => {
  const contents = OVERRIDE('Gemini 3.5  Flash  (High)');
  assert.equal(extractLastLabel(contents), 'Gemini 3.5  Flash  (High)');
});

test('extractLastLabel: ignores trailing non-matching lines after the last match', () => {
  const contents = [
    OVERRIDE('Gemini 3.5 Flash (Medium)'),
    'I0527 04:05:00.000000 32270 shutdown.go:42] flushing',
    '',
  ].join('\n');

  assert.equal(extractLastLabel(contents), 'Gemini 3.5 Flash (Medium)');
});

test('extractLastLabel: is stateless across repeated calls (no shared regex lastIndex)', () => {
  const contents = OVERRIDE('Gemini 3.5 Flash (Medium)');
  // Calling twice must return the same result; a module-scoped /g regex with a
  // shared lastIndex would make the second call miss the match.
  assert.equal(extractLastLabel(contents), 'Gemini 3.5 Flash (Medium)');
  assert.equal(extractLastLabel(contents), 'Gemini 3.5 Flash (Medium)');
});
