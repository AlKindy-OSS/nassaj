/**
 * ADR-173 P4 (H2): a Claude run records its sender as a shared writer exactly
 * when the server marked the launch `sharedResume` (always server-written in
 * dispatchOptions, so the value is the server's computation, never the client's).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeParticipantContext } from '../claude-participant-context.js';

test('a server-marked shared resume records a shared writer', () => {
  assert.deepEqual(claudeParticipantContext({ cwd: '/w/overlay', sharedResume: true }, '/fallback'), {
    provider: 'claude', projectPath: '/w/overlay', sharedWriter: true,
  });
});

test('anything but the boolean true is an ordinary spawn', () => {
  for (const sharedResume of [false, undefined, 'true', 1]) {
    assert.equal(claudeParticipantContext({ cwd: '/w', sharedResume }, '/fallback').sharedWriter, false);
  }
});

test('project path falls back from cwd to projectPath to the process cwd', () => {
  assert.equal(claudeParticipantContext({ projectPath: '/w/project' }, '/fallback').projectPath, '/w/project');
  assert.equal(claudeParticipantContext({}, '/fallback').projectPath, '/fallback');
});

test('R3: a server-marked sharedParticipant records the sender as a participant, never owner', () => {
  assert.equal(claudeParticipantContext({ cwd: '/w', sharedParticipant: true }, '/f').sharedWriter, true);
  assert.equal(claudeParticipantContext({ cwd: '/w', sharedParticipant: 'true' }, '/f').sharedWriter, false);
});
