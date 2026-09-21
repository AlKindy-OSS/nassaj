/**
 * opencode-config-material.test.ts — the governed per-user opencode.json material for
 * the GLM OpenCode carrier (GL-2, ADR-062). Pure filesystem unit test: no DB, no SDK,
 * no spawn, no opencode binary invoked.
 *
 * Proves:
 *  - the generated config carries EXACTLY the custom `glm` provider block: npm
 *    @ai-sdk/openai-compatible, baseURL = the vetted api.z.ai carrier constant (same
 *    HOST as the chat path — the property GL-3 allowlists), and the glm model catalog.
 *  - the provider id is `glm`, never `anthropic` (which would collide with the
 *    built-in provider — OCC-2).
 *  - materialize writes a real, read-only (0444) COPY — never a symlink — matching the
 *    canonical content; idempotent.
 *  - DRIFT (edited content) and a SYMLINK are both detected and rewritten to a real
 *    copy (the write-through-to-shared vector is closed).
 *  - materialize REFUSES to write THROUGH a symlinked config dir (pre-GL-5 shared
 *    operator symlink is never corrupted).
 *  - never throws; onError fires on a write failure and returns false.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OPENCODE_CONFIG_FILENAME,
  OPENCODE_CONFIG_FILE_MODE,
  OPENCODE_GLM_NPM,
  GLM_CARRIER_BASE_URL,
  GLM_CARRIER_MODELS,
  fingerprintOf,
  buildOpenCodeConfig,
  normalizeOpenCodeMcpOverlay,
  serializeOpenCodeConfig,
  openCodeConfigMatches,
  materializeOpenCodeConfig,
} from './opencode-config-material.js';
import { withOpenCodeConfigLock } from './opencode-config-lock.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-opencode-config-'));

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');

function freshDir(name: string): string {
  const dir = path.join(sandbox, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('opencode-config-material — generated glm provider block', () => {
  it('carries the custom glm provider: npm, vetted baseURL, model catalog', () => {
    const cfg = buildOpenCodeConfig();
    assert.ok(cfg.provider.glm, 'the provider id must be `glm`');
    assert.equal(
      // @ts-expect-error — `anthropic` must NOT be a key (collision with built-in)
      cfg.provider.anthropic,
      undefined,
      'must NOT define an `anthropic` provider (OCC-2 collision)',
    );
    assert.equal(cfg.provider.glm.npm, OPENCODE_GLM_NPM);
    // B-221: opencode 1.17.18 cannot drive @ai-sdk/anthropic — a turn bound to it ends
    // at `step-finish reason:"unknown"` with 0 input / 0 output tokens because the
    // request is never issued. Pinned so a revert to the "Anthropic-wire" SDK fails here.
    assert.equal(cfg.provider.glm.npm, '@ai-sdk/openai-compatible');
    assert.equal(cfg.provider.glm.options.baseURL, GLM_CARRIER_BASE_URL);
    assert.equal(
      new URL(cfg.provider.glm.options.baseURL).host,
      'api.z.ai',
      'baseURL host is the vetted z.ai carrier host — exactly what GL-3 allowlists',
    );
    assert.deepEqual(cfg.provider.glm.models, GLM_CARRIER_MODELS);
    assert.ok(Object.keys(cfg.provider.glm.models).length > 0, 'catalog must be non-empty');
    // B-220: bracketed variant ids are opencode notation, not wire ids — z.ai answers
    // `1211 Unknown Model`. None may be materialized into a real routing file.
    for (const id of Object.keys(cfg.provider.glm.models)) {
      assert.ok(!id.includes('['), `must not materialize a phantom variant id: ${id}`);
    }
  });

  it('accepts only a bounded MCP overlay while keeping the governed provider canonical', () => {
    const overlay = normalizeOpenCodeMcpOverlay({
      canary: { type: 'local', command: ['false'] },
      '': { type: 'local', command: ['must-drop'] },
      invalid: ['must-drop'],
      constructor: { type: 'local', command: ['must-drop'] },
    });
    assert.deepEqual(Object.keys(overlay), ['canary']);
    const config = buildOpenCodeConfig(overlay);
    assert.ok(config.provider.glm);
    assert.deepEqual(config.mcp, {
      canary: { type: 'local', command: ['false'] },
    });
  });

  it('serializes to stable 2-space JSON with a trailing newline (stable fingerprint)', () => {
    const s = serializeOpenCodeConfig();
    assert.equal(s.endsWith('\n'), true);
    assert.deepEqual(JSON.parse(s), buildOpenCodeConfig(), 'round-trips to the same object');
    assert.equal(serializeOpenCodeConfig(), s, 'deterministic across calls');
    assert.equal(fingerprintOf(s), sha256(s));
  });
});

describe('materializeOpenCodeConfig — happy path & idempotence', () => {
  it('creates a real, read-only (0444) opencode.json matching the canonical content', () => {
    const dir = freshDir('ok');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);

    assert.equal(materializeOpenCodeConfig(dir), true);
    const st = fs.lstatSync(target);
    assert.equal(st.isSymbolicLink(), false, 'must be a real file, never a symlink');
    assert.equal(st.isFile(), true);
    assert.equal(st.mode & 0o777, OPENCODE_CONFIG_FILE_MODE, 'must be read-only 0444');
    assert.equal(OPENCODE_CONFIG_FILE_MODE, 0o444);
    assert.equal(
      fs.readFileSync(target, 'utf8'),
      serializeOpenCodeConfig(),
      'on-disk content matches the canonical serialization',
    );
    assert.equal(openCodeConfigMatches(target), true);

    assert.equal(materializeOpenCodeConfig(dir), true, 'idempotent');
    assert.equal(openCodeConfigMatches(target), true);
  });

  it('honors a caller-supplied file mode', () => {
    const dir = freshDir('mode');
    assert.equal(materializeOpenCodeConfig(dir, { mode: 0o400 }), true);
    assert.equal(fs.statSync(path.join(dir, OPENCODE_CONFIG_FILENAME)).mode & 0o777, 0o400);
  });

  it('repairs permissive directory and file modes before the fingerprint fast path', () => {
    const dir = freshDir('mode-repair');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
    fs.writeFileSync(target, serializeOpenCodeConfig(), { mode: 0o666 });
    fs.chmodSync(dir, 0o777);
    fs.chmodSync(target, 0o666);

    assert.equal(materializeOpenCodeConfig(dir), true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(target).mode & 0o777, 0o444);
  });

  it('creates the config dir when absent (real per-user dir)', () => {
    const parent = freshDir('mkdir');
    const dir = path.join(parent, 'opencode');
    assert.equal(fs.existsSync(dir), false);
    assert.equal(materializeOpenCodeConfig(dir), true);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.equal(openCodeConfigMatches(path.join(dir, OPENCODE_CONFIG_FILENAME)), true);
  });

  it('preserves the MCP overlay across ordinary canonical regeneration', () => {
    const dir = freshDir('mcp-preserve');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
    const mcp = { canary: { type: 'local', command: ['false'], enabled: true } };
    assert.equal(materializeOpenCodeConfig(dir, { mcp }), true);
    assert.equal(materializeOpenCodeConfig(dir), true, 'provisioning without an override preserves MCP');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(parsed.mcp, mcp);
    assert.deepEqual(parsed.provider, buildOpenCodeConfig().provider);
    assert.equal(openCodeConfigMatches(target), true);
  });

  it('updates and cleans the MCP overlay through the same canonical writer', () => {
    const dir = freshDir('mcp-update-cleanup');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
    materializeOpenCodeConfig(dir, { mcp: { first: { type: 'local', command: ['false'] } } });
    materializeOpenCodeConfig(dir, { mcp: { second: { type: 'local', command: ['false'] } } });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(target, 'utf8')).mcp), ['second']);
    materializeOpenCodeConfig(dir, { mcp: {} });
    const cleaned = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(cleaned.mcp, undefined);
    assert.deepEqual(cleaned, buildOpenCodeConfig());
    assert.equal(fs.statSync(target).mode & 0o777, 0o444);
  });

  it('ordinary provisioning recovers an interrupted rename and preserves the legacy overlay', () => {
    const dir = freshDir('provision-recovery');
    const orphan = path.join(dir, 'opencode.jsonc.migrating-dead-process');
    fs.writeFileSync(orphan, `{
      // interrupted before the canonical write
      "mcp": {"legacy": {"type": "local", "command": ["false"],}},
    }\n`, { mode: 0o600 });

    assert.equal(materializeOpenCodeConfig(dir), true);
    const canonical = JSON.parse(fs.readFileSync(path.join(dir, OPENCODE_CONFIG_FILENAME), 'utf8'));
    assert.deepEqual(canonical.mcp, {
      legacy: { type: 'local', command: ['false'] },
    });
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.migrating-') || name.endsWith('.jsonc')),
      [],
    );
  });

  it('fails fast behind an async owner without blocking its release timer', async () => {
    const dir = freshDir('async-owner-vs-provision');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
    let releaseOwner = () => {};
    let markEntered = () => {};
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const owner = withOpenCodeConfigLock(target, async () => {
      markEntered();
      await new Promise<void>((resolve) => { releaseOwner = resolve; });
    });
    await entered;

    let timerProgressed = false;
    setTimeout(() => { timerProgressed = true; }, 20);
    const startedAt = Date.now();
    const errors: unknown[] = [];
    assert.equal(materializeOpenCodeConfig(dir, { onError: (error) => errors.push(error) }), false);
    assert.ok(Date.now() - startedAt < 250, 'sync provisioning must not wait for the async owner');
    assert.equal(errors.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(timerProgressed, true, 'the event-loop timer must progress while the owner is held');

    releaseOwner();
    await owner;
    assert.equal(materializeOpenCodeConfig(dir), true, 'a later provisioning pass repairs safely');
  });
});

describe('openCodeConfigMatches / materialize — security invariants', () => {
  it('rejects a SYMLINK opencode.json and replaces it with a real copy', () => {
    const dir = freshDir('symlink-file');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
    const shared = path.join(dir, 'shared-operator.json');
    fs.writeFileSync(shared, serializeOpenCodeConfig()); // same content, but a link
    fs.chmodSync(shared, 0o666);

    fs.symlinkSync(shared, target); // the write-through vector
    assert.equal(openCodeConfigMatches(target), false, 'a symlink is never governed');

    assert.equal(materializeOpenCodeConfig(dir), true, 'replaces the symlink');
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false, 'replacement is a real file');
    assert.equal(openCodeConfigMatches(target), true);
    assert.equal(fs.statSync(shared).mode & 0o777, 0o666, 'symlink target is never chmodded');
  });

  it('detects DRIFT (edited content) and rewrites it read-only', () => {
    const dir = freshDir('drift');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
    materializeOpenCodeConfig(dir);

    fs.chmodSync(target, 0o644);
    fs.writeFileSync(
      target,
      JSON.stringify({ provider: { glm: { options: { baseURL: 'https://evil.example/api' } } } }),
    );
    assert.equal(openCodeConfigMatches(target), false, 'drift fails the identity check');

    assert.equal(materializeOpenCodeConfig(dir), true, 'rewrites drift');
    assert.equal(fs.readFileSync(target, 'utf8'), serializeOpenCodeConfig());
    assert.equal(fs.statSync(target).mode & 0o777, 0o444, 'rewritten copy is read-only again');
  });

  it('treats an empty file as ungoverned', () => {
    const dir = freshDir('empty');
    const target = path.join(dir, OPENCODE_CONFIG_FILENAME);
    fs.writeFileSync(target, '');
    assert.equal(openCodeConfigMatches(target), false);
  });

  it('REFUSES to write THROUGH a symlinked config dir (never corrupts the shared source)', () => {
    const base = freshDir('symlink-dir');
    const realOperatorDir = path.join(base, 'operator-opencode');
    fs.mkdirSync(realOperatorDir, { recursive: true });
    const linkedConfigDir = path.join(base, 'user-config-opencode');
    fs.symlinkSync(realOperatorDir, linkedConfigDir); // the shared operator symlink

    assert.equal(
      materializeOpenCodeConfig(linkedConfigDir),
      false,
      'must refuse to materialize into a symlinked config dir',
    );
    assert.equal(
      fs.existsSync(path.join(realOperatorDir, OPENCODE_CONFIG_FILENAME)),
      false,
      'the shared operator dir must NOT have been written through',
    );
  });

  it('refuses a symlink in any ancestor before creating a descendant', () => {
    const base = freshDir('symlink-ancestor');
    const outside = path.join(base, 'outside');
    const linked = path.join(base, 'linked');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, linked);
    const nestedConfig = path.join(linked, 'member', 'opencode');
    assert.equal(materializeOpenCodeConfig(nestedConfig), false);
    assert.equal(fs.existsSync(path.join(outside, 'member')), false);
  });
});

describe('materializeOpenCodeConfig — error contract', () => {
  it('invokes onError and returns false on a write failure (never throws)', () => {
    // configDir is a FILE, so mkdirSync/writeFileSync inside it must throw → onError.
    const parent = freshDir('writefail');
    const dirFile = path.join(parent, 'not-a-dir');
    fs.writeFileSync(dirFile, 'x');

    const captured: unknown[] = [];
    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = materializeOpenCodeConfig(dirFile, { onError: (err) => captured.push(err) });
    });
    assert.equal(result, false, 'write failure ⇒ false');
    assert.equal(captured.length, 1, 'onError fires exactly once on write failure');
  });
});
