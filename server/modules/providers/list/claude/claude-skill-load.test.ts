import assert from 'node:assert/strict';
import test from 'node:test';

import { detectClaudeSkillLoad, skillNameFromBaseDir } from './claude-skill-load.js';
import { ClaudeSessionsProvider } from './claude-sessions.provider.js';

const BODY = 'Base directory for this skill: /home/example/.claude/skills/project-manager\n\n# PM\nbody';
const row = (patch: Record<string, unknown> = {}, text = BODY) => ({
  type: 'user', uuid: 'u1', sessionId: 's', timestamp: '2026-10-05T00:00:00Z',
  message: { role: 'user', content: [{ type: 'text', text }] }, ...patch,
});
const provider = new ClaudeSessionsProvider();

test('detects the persisted meta row with sourceToolUseID', () => {
  const hit = detectClaudeSkillLoad(row({ isMeta: true, sourceToolUseID: 'toolu_1' }));
  assert.equal(hit?.name, 'project-manager');
  assert.equal(hit?.body, BODY);
});

test('live SDK frame (isSynthetic, no isMeta/sourceToolUseID) is detected', () => {
  assert.equal(detectClaudeSkillLoad(row({ isSynthetic: true }))?.name, 'project-manager');
});

test('typed text with the prefix and a skills path but no machine marker stays a user row', () => {
  assert.equal(detectClaudeSkillLoad(row()), null);
  const out = provider.normalizeMessage(row(), 's');
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].isSkillLoad, undefined);
});

test('a mixed [tool_result, text] row is not a skill load and keeps its tool_result', () => {
  const mixed = row({ isMeta: true }, BODY);
  mixed.message.content = [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }, { type: 'text', text: BODY }];
  assert.equal(detectClaudeSkillLoad(mixed), null);
  const noMeta = { ...mixed, isMeta: undefined, isSynthetic: true };
  assert.ok(provider.normalizeMessage(noMeta, 's').some(m => m.kind === 'tool_result'));
});

test('accepts string content and Windows-style paths', () => {
  const raw = { type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: C:\\x\\skills\\a-b' } };
  assert.equal(detectClaudeSkillLoad(raw)?.name, 'a-b');
  assert.equal(skillNameFromBaseDir('/a/b/skills/c/'), 'c');
});

test('ordinary and non-skill meta messages are not skill loads', () => {
  assert.equal(detectClaudeSkillLoad(row({}, 'hello there')), null);
  assert.equal(detectClaudeSkillLoad(row({ isMeta: true }, '<local-command-caveat>x</local-command-caveat>')), null);
  assert.equal(detectClaudeSkillLoad(row({}, 'Base directory for this skill: /tmp/notes')), null);
});

test('normalizeMessage emits one compact assistant-side row for a skill load', () => {
  const out = provider.normalizeMessage(row({ isMeta: true, sourceToolUseID: 't' }), 's');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'text');
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].isSkillLoad, true);
  assert.equal(out[0].skillName, 'project-manager');
  assert.equal(out[0].content, BODY);
});

test('other isMeta rows stay hidden and normal user text stays a user row', () => {
  assert.deepEqual(provider.normalizeMessage(row({ isMeta: true }, 'caveat'), 's'), []);
  const normal = provider.normalizeMessage(row({}, 'hi'), 's');
  assert.equal(normal[0].role, 'user');
  assert.equal(normal[0].isSkillLoad, undefined);
});
