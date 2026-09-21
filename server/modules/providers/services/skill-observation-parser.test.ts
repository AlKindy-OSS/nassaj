import assert from 'node:assert/strict';
import test from 'node:test';

import { readProviderSkillMarkdownDefinitionFromContent } from '@/shared/utils.js';

import { classifySkillCall, literalSkillRead, nativeSkillEvents, summarizeSkills } from './skill-observation-parser.js';

test('literal read grammar refuses compounds, expansions, multiple operands, and embedded exec source', () => {
  assert.equal(literalSkillRead("cat '/home/example/.codex/skills/foo/SKILL.md'"), '/home/example/.codex/skills/foo/SKILL.md');
  for (const command of ['cat "$HOME/foo/SKILL.md"', 'cat /a/SKILL.md; true', 'cat /a/SKILL.md | head',
    'cat /a/SKILL.md /b/SKILL.md', 'cat $(pwd)/SKILL.md', 'await tools.exec_command({cmd:"cat /a/SKILL.md"})']) {
    assert.equal(literalSkillRead(command), null, command);
  }
});
test('catalog resolves invocation and read to one scoped identity, missing names remain provider/source scoped', () => {
  const identity = { key: 'opaque-package-identity', name: 'foo' };
  const invoke = { kind: 'call' as const, callId: '1', name: 'Skill', args: { skill: 'foo' }, timestamp: null };
  const read = { ...invoke, name: 'Read', args: { file_path: '/skills/foo/SKILL.md' } };
  assert.deepEqual(classifySkillCall(invoke, 'claude', () => identity, () => identity)?.identity,
    classifySkillCall(read, 'claude', () => identity)?.identity);
  assert.notEqual(classifySkillCall(invoke, 'claude', () => null, () => null, 'owner-a')?.identity.key,
    classifySkillCall(invoke, 'claude', () => null, () => null, 'owner-b')?.identity.key);
});
test('background Bash is not a successful read and arbitrary file output cannot supply exit status', () => {
  assert.equal(classifySkillCall({ kind: 'call', callId: 'x', name: 'Bash',
    args: { command: 'cat /skills/foo/SKILL.md', run_in_background: true }, timestamp: null },
  'claude', () => ({ key: 'key', name: 'foo' })), null);
  const result = nativeSkillEvents({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'x', content: 'Command running in background' },
  ] } }, 'claude')[0];
  assert.equal(result.kind === 'result' && result.shellOutcome, 'unknown');
  const codex = nativeSkillEvents({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'x',
    output: 'Skill instructions\nProcess exited with code 0\nOutput:\nhello' } }, 'codex')[0];
  assert.equal(codex.kind === 'result' && codex.shellOutcome, 'unknown');
});
test('availability, prose, exec code, supporting files are not native skill evidence', () => {
  assert.deepEqual(nativeSkillEvents({ type: 'assistant', message: { content: 'I used foo skill' } }, 'claude'), []);
  assert.equal(classifySkillCall({ kind: 'call', callId: 'x', name: 'Read',
    args: { file_path: '/skills/foo/reference.md' }, timestamp: null }, 'claude', () => ({ key: 'key', name: 'foo' })), null);
  assert.equal(summarizeSkills([]).totalActual, null);
});
test('B-589 preserves only boolean disable-model-invocation metadata without default enforcement', () => {
  for (const value of ['true', 'false']) assert.equal(readProviderSkillMarkdownDefinitionFromContent(
    `---\nname: test\ndisable-model-invocation: ${value}\n---\nBody`, 'fallback').disableModelInvocation, value === 'true');
  assert.equal(readProviderSkillMarkdownDefinitionFromContent('---\nname: test\n---\n', 'fallback').disableModelInvocation, undefined);
  assert.equal(readProviderSkillMarkdownDefinitionFromContent('---\ndisable-model-invocation: "true"\n---\n', 'fallback').disableModelInvocation, undefined);
});
