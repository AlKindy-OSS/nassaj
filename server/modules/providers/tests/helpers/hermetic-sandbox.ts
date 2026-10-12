/**
 * hermetic-sandbox.ts — B-1544. Import this FIRST (before any app module) in a
 * test that must stay safe when run directly with `node --test`, outside
 * `scripts/run-isolated-node-tests.mjs`. It never reads an inherited
 * HOME / CLAUDE_CONFIG_DIR / DATABASE_PATH: every path-bearing env var is
 * pointed into a private mkdtemp root, and `assertInsideSandbox` guards each
 * destructive filesystem call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const parent = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();

/** Private root of this test process; removed by `removeSandbox`. */
export const sandboxRoot = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'hermetic-test-')));
export const sandboxHome = path.join(sandboxRoot, 'home');
export const sandboxClaudeDir = path.join(sandboxHome, '.claude');
fs.mkdirSync(sandboxClaudeDir, { recursive: true });

const INHERITED_ROOT_KEYS = [
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'QWEN_HOME', 'KIMI_SHARE_DIR', 'HERMES_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
  'CURSOR_CONFIG_DIR', 'WORKFLOW_SUPERVISOR_STATE_DIR',
];
for (const key of INHERITED_ROOT_KEYS) delete process.env[key];
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLAUDE_CONFIG_DIR = sandboxClaudeDir;
process.env.CODEX_HOME = path.join(sandboxHome, '.codex');
process.env.DATABASE_PATH = path.join(sandboxRoot, 'auth.db');
process.env.NASSAJ_HARNESS_DATA_HOME = sandboxRoot;
process.env.WORKSPACES_ROOT = sandboxRoot;

/** Throws unless `target` resolves strictly inside the sandbox root. */
export function assertInsideSandbox(target: string): string {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(`${sandboxRoot}${path.sep}`)) {
    throw new Error(`refusing destructive fs call outside the sandbox: ${resolved}`);
  }
  return resolved;
}

/** Removes the whole sandbox (call from `after`). */
export function removeSandbox(): void {
  fs.rmSync(assertInsideSandbox(path.join(sandboxRoot, 'home')), { recursive: true, force: true });
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
}
