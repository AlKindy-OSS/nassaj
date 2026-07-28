/**
 * codex-governance-material.regression.test.ts — SL-1 (ADR-062) equivalence proof.
 *
 * SL-1 refactored the Codex governance primitives to delegate to the vendor-neutral
 * vendor-cli-governance-material.js. This test PROVES the live Codex path is
 * unchanged: the single-arg Codex facade produces byte-for-byte identical results to
 * the generic primitive bound with Codex's own (filename=AGENTS.md, source=
 * ~/.claude/AGENTS.md) parameters — same match verdicts, same materialized bytes,
 * same 0444 mode, same read-null semantics. Pure filesystem; no spawn, no vendor CLI.
 *
 * (The pre-existing codex-governance-material.test.ts remains unchanged and is the
 * behavioral regression baseline; this file adds the direct facade≡primitive proof.)
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-gov-regression-'));
const ORIGINAL_HOME = process.env.HOME;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
process.env.HOME = sandboxHome;

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const SOURCE = path.join(sandboxHome, '.claude', 'AGENTS.md');
const NEUTRAL = '# AGENTS.md — neutral nassaj governance\nplatform-agnostic instructions.\n';

const codex = await import('./codex-governance-material.js');
const generic = await import('./vendor-cli-governance-material.js');

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');

function freshHome(name: string): string {
  const home = path.join(sandbox, name);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function setSource(content: string | null): void {
  if (content === null) fs.rmSync(SOURCE, { force: true });
  else fs.writeFileSync(SOURCE, content);
}

beforeEach(() => {
  setSource(NEUTRAL);
});

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('SL-1 regression — Codex facade ≡ neutral primitive bound to Codex params', () => {
  it('neutralGovernanceSource + filename are the Codex bindings', () => {
    assert.equal(codex.CODEX_AGENTS_FILENAME, 'AGENTS.md');
    assert.equal(codex.neutralGovernanceSource(), SOURCE);
  });

  it('readNeutralGovernance ≡ generic readNeutralSource(codexSource)', () => {
    const viaFacade = codex.readNeutralGovernance();
    const viaGeneric = generic.readNeutralSource(codex.neutralGovernanceSource());
    assert.ok(viaFacade && viaGeneric);
    assert.equal(viaFacade.fingerprint, viaGeneric.fingerprint);
    assert.equal(viaFacade.fingerprint, sha256(NEUTRAL));
    assert.deepEqual(viaFacade.content, viaGeneric.content);

    // With no operator source the facade resolves to the bundled default (T-1078);
    // the equivalence still holds because it holds against the RESOLVED source.
    setSource(null);
    assert.equal(codex.neutralGovernanceSource(), codex.bundledGovernanceSource());
    const fallbackFacade = codex.readNeutralGovernance();
    const fallbackGeneric = generic.readNeutralSource(codex.neutralGovernanceSource());
    assert.ok(fallbackFacade && fallbackGeneric);
    assert.equal(fallbackFacade.fingerprint, fallbackGeneric.fingerprint);
  });

  it('materializeGovernanceCopy(codexHome) ≡ generic materialize(home, AGENTS.md, source)', () => {
    // Facade path.
    const homeA = freshHome('codex-facade');
    assert.equal(codex.materializeGovernanceCopy(homeA), true);
    const govA = path.join(homeA, 'AGENTS.md');

    // Generic path with the exact Codex bindings.
    const homeB = freshHome('generic-bound');
    assert.equal(
      generic.materializeGovernanceCopy(homeB, codex.CODEX_AGENTS_FILENAME, codex.neutralGovernanceSource()),
      true,
    );
    const govB = path.join(homeB, 'AGENTS.md');

    // Byte-for-byte identical output & mode.
    assert.equal(sha256(fs.readFileSync(govA)), sha256(fs.readFileSync(govB)));
    assert.equal(fs.statSync(govA).mode & 0o777, 0o444, 'facade copy is 0444');
    assert.equal(fs.statSync(govB).mode & 0o777, 0o444, 'generic copy is 0444');
    assert.equal(fs.lstatSync(govA).isSymbolicLink(), false);

    // Match verdicts agree.
    assert.equal(codex.governanceMatchesSource(govA), true);
    assert.equal(generic.governanceMatchesSource(govA, codex.neutralGovernanceSource()), true);
  });

  it('facade governanceMatchesSource verdict tracks the generic primitive across states', () => {
    const home = freshHome('codex-verdict');
    const gov = path.join(home, 'AGENTS.md');

    // ungoverned (nothing there)
    assert.equal(codex.governanceMatchesSource(gov), false);
    assert.equal(generic.governanceMatchesSource(gov, SOURCE), false);

    // symlink → rejected by both
    fs.symlinkSync(SOURCE, gov);
    assert.equal(codex.governanceMatchesSource(gov), false);
    assert.equal(generic.governanceMatchesSource(gov, SOURCE), false);

    // materialized → governed by both
    codex.materializeGovernanceCopy(home);
    assert.equal(codex.governanceMatchesSource(gov), true);
    assert.equal(generic.governanceMatchesSource(gov, SOURCE), true);

    // no OPERATOR source → the facade re-binds to the bundled default and stays
    // equivalent to the generic primitive bound to that same resolved source; the
    // generic bound to the (now absent) operator path still fails closed.
    setSource(null);
    assert.equal(generic.governanceMatchesSource(gov, SOURCE), false, 'absent path ⇒ ungoverned');
    assert.equal(
      codex.governanceMatchesSource(gov),
      generic.governanceMatchesSource(gov, codex.neutralGovernanceSource()),
      'facade verdict ≡ generic verdict against the RESOLVED source',
    );
    const nosrcHome = freshHome('codex-nosrc');
    assert.equal(codex.materializeGovernanceCopy(nosrcHome), true, 'bundled default governs');
    assert.equal(
      generic.materializeGovernanceCopy(nosrcHome, 'AGENTS.md', SOURCE),
      false,
      'the generic primitive itself keeps its no-source fail-closed contract',
    );
  });

  it('persona facade delegates identically (best-effort, distinct source)', () => {
    const personaSrcDir = path.join(sandboxHome, '.claude', '.agents');
    fs.mkdirSync(personaSrcDir, { recursive: true });
    const personaSrc = path.join(personaSrcDir, 'agents.md');
    fs.writeFileSync(personaSrc, '# personas\nbody.\n');

    assert.equal(codex.neutralPersonaSource(), personaSrc);
    const home = freshHome('codex-persona');
    assert.equal(codex.materializePersonaCopy(home), true);
    const persona = path.join(home, '.agents', 'agents.md');
    assert.equal(codex.personaMatchesSource(persona), true);
    assert.equal(
      generic.governanceMatchesSource(persona, codex.neutralPersonaSource()),
      true,
      'persona copy matches via the generic primitive too',
    );
    assert.equal(fs.statSync(persona).mode & 0o777, 0o444);
  });
});
