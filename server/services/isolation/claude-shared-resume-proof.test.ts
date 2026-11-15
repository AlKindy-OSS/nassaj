/**
 * ADR-173 rev.3 P0 (qa M5): a shared-writer resume through a linked transcript is
 * admitted per CLI version and per link mode, only after the live proof
 * (scripts/prove-claude-shared-resume.mjs) passed every required check for it.
 * Fails closed: corrupt registry, unknown mode, a missing or non-pass check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  SHARED_RESUME_CHECKS, SHARED_RESUME_MODES, SHARED_RESUME_REQUIRED_CHECKS, isSharedResumeModeProven, readSharedResumeProven,
  recordSharedResumeProof,
} from './claude-shared-resume-proof.js';

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'adr173-p0-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const allPass = () => Object.fromEntries(SHARED_RESUME_CHECKS.map((check) => [check, 'pass']));

test('modes and required checks are the ADR-173 P0 matrix', () => {
  assert.deepEqual([...SHARED_RESUME_MODES], ['file_link', 'dir_link']);
  for (const check of ['three_turns', 'compaction', 'subagent', 'tool_result', 'inode_stable', 'link_preserved', 'cleanup_safe']) {
    assert.ok(SHARED_RESUME_CHECKS.includes(check), check);
  }
});

test('a mode is proven only when every required check passed for that version', () => {
  const file = path.join(root, 'proven.json');
  assert.equal(isSharedResumeModeProven('2.1.325', 'file_link', file), false, 'absent registry proves nothing');
  recordSharedResumeProof('2.1.325', {
    file_link: allPass(),
    dir_link: { ...allPass(), compaction: 'unproven' },
  }, { method: 'unit' }, file);
  assert.equal(isSharedResumeModeProven('2.1.325', 'file_link', file), true);
  assert.equal(isSharedResumeModeProven('2.1.325', 'dir_link', file), false, 'an unproven check fails the mode');
  assert.equal(isSharedResumeModeProven('2.1.326', 'file_link', file), false, 'another version is not proven');
  assert.equal(isSharedResumeModeProven('2.1.325', 'hard_link', file), false, 'unknown mode');
  assert.equal(isSharedResumeModeProven(null, 'file_link', file), false);
  assert.equal(readSharedResumeProven(file)['2.1.325'].evidence.method, 'unit');
});

test('a recorded entry missing a check, or a corrupt registry, proves nothing', () => {
  const file = path.join(root, 'partial.json');
  const { cleanup_safe: _dropped, ...partial } = allPass();
  recordSharedResumeProof('2.1.325', { file_link: partial, dir_link: allPass() }, {}, file);
  assert.equal(isSharedResumeModeProven('2.1.325', 'file_link', file), false);
  assert.equal(isSharedResumeModeProven('2.1.325', 'dir_link', file), true);
  fs.writeFileSync(file, '{not json');
  assert.equal(isSharedResumeModeProven('2.1.325', 'dir_link', file), false);
  assert.throws(() => recordSharedResumeProof('latest', { file_link: allPass() }, {}, file));
});

test('owner decision 2026-11-15: tool_result is recorded but not required to admit a mode', () => {
  assert.ok(SHARED_RESUME_CHECKS.includes('tool_result'), 'still probed and recorded');
  assert.ok(!SHARED_RESUME_REQUIRED_CHECKS.includes('tool_result'));
  assert.deepEqual(SHARED_RESUME_REQUIRED_CHECKS, SHARED_RESUME_CHECKS.filter((check) => check !== 'tool_result'));
  const file = path.join(root, 'tool-result.json');
  recordSharedResumeProof('2.1.325', {
    file_link: { ...allPass(), tool_result: 'fail' },
    dir_link: { ...allPass(), tool_result: 'fail', compaction: 'fail' },
  }, {}, file);
  assert.equal(isSharedResumeModeProven('2.1.325', 'file_link', file), true, 'inline truncation accepted');
  assert.equal(isSharedResumeModeProven('2.1.325', 'dir_link', file), false, 'a required check still fails the mode');
  assert.equal(readSharedResumeProven(file)['2.1.325'].modes.file_link.tool_result, 'fail', 'the FAIL stays as data');
});

test('CLI 2.1.325 is proven for both link modes in the shipped registry, its tool_result FAIL kept', () => {
  for (const mode of SHARED_RESUME_MODES) {
    assert.equal(isSharedResumeModeProven('2.1.325', mode), true, mode);
    assert.equal(readSharedResumeProven()['2.1.325'].modes[mode].tool_result, 'fail', mode);
  }
});

test('the shipped registry holds only well-formed versions with both modes recorded', () => {
  for (const [version, entry] of Object.entries(readSharedResumeProven())) {
    assert.match(version, /^\d+\.\d+\.\d+$/u);
    for (const mode of SHARED_RESUME_MODES) assert.ok(entry.modes[mode], `${version} ${mode}`);
  }
});
