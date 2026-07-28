/**
 * opencode-governance.gate.test.ts — GL-5 (ADR-062).
 *
 * Focused unit test for the opencode carrier governance gate. Deterministic: it
 * overrides $HOME to a temp tree (Node's os.homedir() honors $HOME on POSIX) so the
 * neutral source (~/.claude/AGENTS.md) and the per-user copy (~/.config/opencode/
 * AGENTS.md) both resolve INSIDE the temp dir — the real operator home is never read
 * or written. No DB (userId=null short-circuits resolveProviderEnv before any DB call).
 *
 * Proves:
 *  - the pure resolvers (config-home for an anonymous id, neutral source, filename).
 *  - ensureOpenCodeGovernance MATERIALIZES a real, read-only (0444) COPY — never a
 *    symlink — of the neutral source into the opencode config-home, and is idempotent.
 *  - it is FAIL-CLOSED: with NO neutral source it THROWS VendorGovernanceMissingError
 *    (code `governance_missing`), so a launcher that does not catch it cannot spawn an
 *    ungoverned carrier turn.
 */

import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  GOVERNANCE_MISSING_CODE,
  OPENCODE_AGENTS_FILENAME,
  VendorGovernanceMissingError,
  ensureOpenCodeGovernance,
  neutralOpenCodeGovernanceSource,
  resolveOpenCodeConfigHomeForUser,
} from './opencode-governance.js';

const GOVERNANCE_TEXT = '# nassaj neutral governance (test)\n\nrules...\n';

let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(path.join(os.tmpdir(), 'oc-gov-home-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

/** Writes ~/.claude/AGENTS.md inside the temp home. */
function seedNeutralSource(): string {
  const claudeDir = path.join(tempHome, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const source = path.join(claudeDir, OPENCODE_AGENTS_FILENAME);
  writeFileSync(source, GOVERNANCE_TEXT, 'utf8');
  return source;
}

describe('GL-5 — pure resolvers', () => {
  it('resolves the anonymous config-home to ~/.config/opencode', () => {
    assert.equal(resolveOpenCodeConfigHomeForUser(null), path.join(tempHome, '.config', 'opencode'));
  });

  it('resolves the neutral source to ~/.claude/AGENTS.md and filename AGENTS.md', () => {
    assert.equal(neutralOpenCodeGovernanceSource(), path.join(tempHome, '.claude', 'AGENTS.md'));
    assert.equal(OPENCODE_AGENTS_FILENAME, 'AGENTS.md');
  });
});

describe('GL-5 — ensureOpenCodeGovernance materializes a governed COPY', () => {
  it('writes a real, read-only 0444 copy matching the neutral source (idempotent)', () => {
    seedNeutralSource();

    const result = ensureOpenCodeGovernance(null);
    assert.equal(result.ok, true);

    const copyPath = path.join(tempHome, '.config', 'opencode', OPENCODE_AGENTS_FILENAME);
    const st = lstatSync(copyPath);
    assert.ok(st.isFile(), 'materialized governance must be a real file');
    assert.ok(!st.isSymbolicLink(), 'governance must be a COPY, never a symlink');
    assert.equal(st.mode & 0o777, 0o444, 'governance copy must be read-only 0444');
    assert.equal(readFileSync(copyPath, 'utf8'), GOVERNANCE_TEXT);

    // Idempotent: a second call is a no-op fast path (already authentic).
    const again = ensureOpenCodeGovernance(null);
    assert.equal(again.ok, true);
    assert.equal(readFileSync(copyPath, 'utf8'), GOVERNANCE_TEXT);
  });
});

describe('GL-5 — fail-closed', () => {
  it('THROWS VendorGovernanceMissingError when no neutral source exists', () => {
    // No ~/.claude/AGENTS.md seeded → cannot govern → fail-closed.
    let caught: unknown;
    try {
      ensureOpenCodeGovernance(null);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof VendorGovernanceMissingError, 'must be the typed governance error');
    assert.equal(caught.code, GOVERNANCE_MISSING_CODE);
    assert.equal(caught.vendorId, 'opencode');
  });
});
