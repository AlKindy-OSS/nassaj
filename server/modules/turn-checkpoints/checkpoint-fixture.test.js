/** Shared fixtures for T-2095 checkpoint tests: real repositories under /var/tmp. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { bindSessionWorkspace, createSessionWorkspace } from '../session-workspaces/index.js';

/** Runs git in `repo` and returns trimmed stdout. */
export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** Creates a committed repository holding `files` (relative path -> text). */
export function makeRepository(files = { 'a.ts': 'export const a = 1;\n' }) {
  const repo = fs.realpathSync(fs.mkdtempSync('/var/tmp/nassaj-turn-checkpoint-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Checkpoint Unit');
  git(repo, 'config', 'user.email', 'checkpoint-unit@example.test');
  for (const [relative, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'chore: baseline');
  return repo;
}

/** Creates and binds an overlay owned by `principalId`. */
export function makeOverlay(repo, { principalId = 7, sessionId = `session-${Math.random().toString(16).slice(2)}` } = {}) {
  const launchKey = `launch-${sessionId}`;
  createSessionWorkspace({ projectPath: repo, launchKey, principalId });
  return bindSessionWorkspace({ projectPath: repo, launchKey, sessionId, principalId });
}

/** Removes the repository and its overlays. */
export function removeRepository(repo) {
  try { git(repo, 'worktree', 'prune'); } catch { /* best effort */ }
  fs.rmSync(repo, { recursive: true, force: true });
}

/** A writer that records frames; `closed` makes send() throw like a dead socket. */
export function recordingWriter({ closed = false } = {}) {
  const frames = [];
  return {
    frames,
    send(frame) {
      if (closed) throw new Error('socket closed');
      frames.push(frame);
    },
    checkpoint() { return frames.find((frame) => frame.kind === 'turn_checkpoint'); },
  };
}

/** Builds a turn context for withTurnCheckpoint. */
export function turnContext(binding, writer, principalId = 7) {
  return { sessionWorkspace: binding, principalId, provider: 'codex', clientMsgId: 'cm-1', writer };
}
