/**
 * resolve-opencode-binary.test.ts — OC-06: resolveOpenCodeBinaryPath() knob.
 *
 * Order under test: OPENCODE_PATH override → ~/.opencode/bin/opencode when it
 * exists on disk → bare 'opencode' PATH fallback. A sandboxed $HOME (honored by
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

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_OPENCODE_PATH === undefined) delete process.env.OPENCODE_PATH;
  else process.env.OPENCODE_PATH = ORIGINAL_OPENCODE_PATH;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('resolveOpenCodeBinaryPath (OC-06)', () => {
  it('prefers the explicit OPENCODE_PATH override', () => {
    process.env.OPENCODE_PATH = '/custom/bin/opencode';
    try {
      assert.equal(resolveOpenCodeBinaryPath(), '/custom/bin/opencode');
    } finally {
      delete process.env.OPENCODE_PATH;
    }
  });

  it('trims whitespace-only OPENCODE_PATH and ignores it', () => {
    process.env.OPENCODE_PATH = '   ';
    try {
      // No override, no default install in sandbox → bare PATH fallback.
      assert.equal(resolveOpenCodeBinaryPath(), 'opencode');
    } finally {
      delete process.env.OPENCODE_PATH;
    }
  });

  it('falls back to ~/.opencode/bin/opencode when it exists', () => {
    const binDir = path.join(sandboxHome, '.opencode', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'opencode');
    fs.writeFileSync(binPath, '#!/bin/sh\n');
    try {
      assert.equal(resolveOpenCodeBinaryPath(), binPath);
    } finally {
      fs.rmSync(binPath, { force: true });
    }
  });

  it('falls back to bare "opencode" when no override and no default install', () => {
    assert.equal(resolveOpenCodeBinaryPath(), 'opencode');
  });
});
