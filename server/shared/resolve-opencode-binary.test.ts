/**
 * resolve-opencode-binary.test.ts — OC-06: resolveOpenCodeBinaryPath() knob.
 *
 * Order under test (T-1873 registry): absolute runnable OPENCODE_PATH server
 * override → ~/.opencode/bin/opencode → HarnessBinaryUnresolvedError (no PATH
 * fallback). A sandboxed $HOME (honored by
 * os.homedir on this platform) lets us control whether the default install path
 * exists. Runner: node:test + node:assert/strict (no vitest).
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-oc-bin-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENCODE_PATH = process.env.OPENCODE_PATH;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
delete process.env.OPENCODE_PATH;

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { resolveOpenCodeBinaryPath } = await import('./utils.js');
const { HarnessBinaryUnresolvedError } = await import('./harness-binaries.js');

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_OPENCODE_PATH === undefined) delete process.env.OPENCODE_PATH;
  else process.env.OPENCODE_PATH = ORIGINAL_OPENCODE_PATH;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('resolveOpenCodeBinaryPath (OC-06, T-1873 registry)', () => {
  it('prefers an absolute, runnable server OPENCODE_PATH override', () => {
    const custom = path.join(sandbox, 'custom', 'opencode');
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    fs.writeFileSync(custom, '#!/bin/sh\n', { mode: 0o755 });
    process.env.OPENCODE_PATH = custom;
    try {
      assert.equal(resolveOpenCodeBinaryPath(), custom);
    } finally {
      delete process.env.OPENCODE_PATH;
    }
  });

  it('refuses a missing override instead of falling back', () => {
    process.env.OPENCODE_PATH = '/custom/bin/opencode';
    try {
      assert.throws(() => resolveOpenCodeBinaryPath(), HarnessBinaryUnresolvedError);
    } finally {
      delete process.env.OPENCODE_PATH;
    }
  });

  it('resolves ~/.opencode/bin/opencode (whitespace-only override ignored)', () => {
    const binDir = path.join(sandboxHome, '.opencode', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'opencode');
    fs.writeFileSync(binPath, '#!/bin/sh\n', { mode: 0o755 });
    process.env.OPENCODE_PATH = '   ';
    try {
      assert.equal(resolveOpenCodeBinaryPath(), binPath);
    } finally {
      delete process.env.OPENCODE_PATH;
      fs.rmSync(binPath, { force: true });
    }
  });

  it('never falls back to a bare PATH lookup when nothing is installed', () => {
    assert.throws(() => resolveOpenCodeBinaryPath(), HarnessBinaryUnresolvedError);
  });
});
