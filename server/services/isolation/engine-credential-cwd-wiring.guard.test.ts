/**
 * B-1541 source guard — the engine credential check reads project/local
 * settings at the child's cwd, so every caller of resolveClaudeRunProfileOrThrow
 * must hand it that cwd. A call without `cwd:` would silently check this
 * process's cwd instead of the project the child runs in.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const CALL = /resolveClaudeRunProfileOrThrow\)?\(\{/g;

/** Returns the argument-object text of every call in `source`. */
function callArguments(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(CALL)) {
    const start = match.index! + match[0].length - 1;
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      if (depth === 0) { calls.push(source.slice(start, i + 1)); break; }
    }
  }
  return calls;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('claude-sdk main run and /btw fork pass the spawn cwd to the run profile', () => {
  const calls = callArguments(read('server/claude-sdk.js'));
  assert.equal(calls.length, 2, 'expected exactly the main run and the /btw fork');
  assert.ok(calls.some((c) => /\bcwd: sdkOptions\.cwd \?\? null,/.test(c)), 'main run passes sdkOptions.cwd');
  assert.ok(
    calls.some((c) => /\bcwd: sdkOptions\.cwd \?\? projectRoot \?\? null,/.test(c)),
    '/btw fork passes its project root cwd',
  );
});

test('every other run-profile caller passes the child cwd', () => {
  const expected: Record<string, RegExp> = {
    'server/modules/workflow-supervisor/handoff-injector.ts': /\bcwd: input\.projectPath,/,
    'server/services/isolation/managed-claude-launcher.ts': /\bcwd: process\.cwd\(\),/,
    'server/services/isolation/managed-claude-launch-broker.ts': /\bcwd: record\.cwd,/,
  };
  for (const [file, pattern] of Object.entries(expected)) {
    const calls = callArguments(read(file));
    assert.ok(calls.length > 0, `${file} calls the run profile`);
    for (const call of calls) assert.match(call, pattern, file);
  }
  assert.match(read('server/modules/workflow-supervisor/resume-turn-runner.ts'), /\bcwd: params\.projectPath,/);
});
