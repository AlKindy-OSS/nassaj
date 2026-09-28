/**
 * Test fixture for the harness registry (T-1873): installs an executable stub
 * at a harness's MEASURED path under a test HOME, so a launcher under test
 * resolves exactly as it does on a host with the official install.
 *
 * B-1349: a stub must NEVER land outside a test sandbox. Every write here
 * refuses the operator's real home, refuses any directory that does not
 * resolve (realpath) inside a temp root, and never writes THROUGH a symlink
 * (an existing `~/.local/bin/qwen` link would otherwise overwrite the real
 * package entry it points at).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HARNESS_BINARY_IDS, HARNESS_BINARY_SPECS, type HarnessBinaryId } from '../harness-binaries.js';

const STUB = '#!/bin/sh\nexit 0\n';

function realOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** Temp roots a stub may live under: os.tmpdir(), NASSAJ_TEST_TMP and /var/tmp. */
function sandboxRoots(): string[] {
  return [os.tmpdir(), process.env.NASSAJ_TEST_TMP, '/var/tmp']
    .filter((root): root is string => typeof root === 'string' && root.trim() !== '')
    .map(realOrSelf);
}

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Throws unless `dir` (after realpath) is a strict descendant of a temp root
 * and not the operator's real home or anything under it.
 */
export function assertTestSandbox(dir: string): void {
  const real = realOrSelf(dir);
  const operatorHome = realOrSelf(os.userInfo().homedir);
  if (real === operatorHome || isInside(real, operatorHome)) {
    throw new Error(`B-1349: refusing to write a harness stub under the real home (${real})`);
  }
  if (!sandboxRoots().some((root) => isInside(real, root))) {
    throw new Error(`B-1349: refusing to write a harness stub outside a temp sandbox (${real})`);
  }
}

/** The nearest existing ancestor of `target` (itself when it exists). */
function nearestExisting(target: string): string {
  let current = path.resolve(target);
  const present = (entry: string): boolean => {
    try {
      fs.lstatSync(entry);
      return true;
    } catch {
      return false;
    }
  };
  while (!present(current) && path.dirname(current) !== current) current = path.dirname(current);
  // A dangling link has no realpath to check; mkdir through it could land anywhere.
  if (fs.lstatSync(current).isSymbolicLink() && !fs.existsSync(current)) {
    throw new Error(`B-1349: refusing to write a harness stub through a dangling link (${current})`);
  }
  return current;
}

/** Replaces `file` with a fresh stub without following an existing link. */
function writeStub(file: string): void {
  // An intermediate dir may be a link out of the sandbox: check the existing
  // part of the chain BEFORE creating anything, and the full chain after.
  assertTestSandbox(nearestExisting(path.dirname(file)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertTestSandbox(path.dirname(file));
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, STUB, { flag: 'wx', mode: 0o755 });
}

/** Writes `#!/bin/sh exit 0` (mode 0755) at the measured path of `id` under a sandbox `home`. */
export function installFakeHarnessBinary(home: string, id: HarnessBinaryId): string {
  assertTestSandbox(home);
  const file = HARNESS_BINARY_SPECS[id].measured(home);
  writeStub(file);
  return file;
}

/**
 * Points every non-codex registry harness at an executable stub in the sandbox
 * `dir` through its SERVER override env (`KIMI_PATH`, …), so a test never
 * depends on what the host has installed. Returns a restore function.
 */
export function installFakeHarnessOverrides(dir: string): () => void {
  assertTestSandbox(dir);
  const previous = new Map<string, string | undefined>();
  // codex needs a real machine release layout (shared/tests/codex-release-fixture).
  for (const id of HARNESS_BINARY_IDS.filter((harness) => harness !== 'codex')) {
    const spec = HARNESS_BINARY_SPECS[id];
    const file = path.join(dir, id, spec.command);
    writeStub(file);
    previous.set(spec.overrideEnv, process.env[spec.overrideEnv]);
    process.env[spec.overrideEnv] = file;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
