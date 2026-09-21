/**
 * codex-agents-ingestion.test.ts — RUNTIME proof (2026-07-12 remediation, bug #3 +
 * bug #2) that the installed Codex CLI actually ingests $CODEX_HOME/AGENTS.md into
 * the model-visible context, and that project_doc_max_bytes=0 blocks a local
 * (project cwd) AGENTS.md governance-bypass while the global governance survives.
 *
 * Mechanism: `codex debug prompt-input` renders the exact model-visible prompt input
 * list as JSON — the same context assembly `codex exec` (what @openai/codex-sdk
 * spawns) hands the model — WITHOUT any auth, network or model quota. So this is a
 * real end-to-end ingestion assertion against the pinned codex binary, not a mock or
 * a synthetic fixture. The `-c project_doc_max_bytes=0` flag here is byte-for-byte
 * what the SDK emits from `new Codex({ config: { project_doc_max_bytes: 0 } })`
 * (serializeConfigOverrides → `--config project_doc_max_bytes=0`), which
 * server/openai-codex.js passes on every spawn.
 *
 * Empirically verified on codex-cli 0.144.1:
 *   default:                 GLOBAL governance present, LOCAL project doc present.
 *   project_doc_max_bytes=0: GLOBAL governance present, LOCAL project doc DROPPED.
 *
 * If the codex binary is unavailable on this node the cases SKIP with a documented
 * reason (they are runtime-only) rather than failing a code-only CI box.
 *
 * Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

/**
 * Resolves an invokable codex binary the same way the SDK does: prefer the vendored
 * platform binary under node_modules/@openai/codex-<platform>-<arch>, then fall back
 * to `codex` on PATH. Returns null when none runs.
 */
function resolveCodexBinary(): string | null {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  const arch = process.arch;
  const candidates = [
    path.join(
      REPO_ROOT,
      'node_modules',
      '@openai',
      `codex-${platform}-${arch}`,
      'vendor',
      'x86_64-unknown-linux-musl',
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    ),
    'codex',
  ];
  for (const bin of candidates) {
    try {
      const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (probe.status === 0) return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

const CODEX_BIN = resolveCodexBinary();
const skip = CODEX_BIN ? false : 'codex binary unavailable on this node (runtime-only ingestion test)';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-ingest-'));
const CODEX_HOME = path.join(sandbox, 'codex-home');
const PROJECT = path.join(sandbox, 'project');
fs.mkdirSync(CODEX_HOME, { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });

const GLOBAL_MARKER = 'NASSAJ_GLOBAL_GOVERNANCE_MARKER_7A1F';
const LOCAL_MARKER = 'PROJECT_LOCAL_AGENTS_MARKER_9C2E';

if (!skip) {
  fs.writeFileSync(path.join(CODEX_HOME, 'AGENTS.md'), `# governance\n${GLOBAL_MARKER}\n`);
  fs.writeFileSync(path.join(PROJECT, 'AGENTS.md'), `# local project doc\n${LOCAL_MARKER}\n`);
}

/** Runs `codex debug prompt-input` in the project cwd and returns rendered stdout. */
function promptInput(extraArgs: string[]): string {
  const res = spawnSync(
    CODEX_BIN as string,
    ['debug', 'prompt-input', ...extraArgs, 'probe'],
    {
      cwd: PROJECT,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, CODEX_HOME },
    },
  );
  assert.equal(res.status, 0, `codex debug prompt-input failed: ${res.stderr || res.error}`);
  return res.stdout;
}

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe('Codex runtime AGENTS.md ingestion (real codex binary)', () => {
  it(
    'ingests $CODEX_HOME/AGENTS.md governance into the model-visible prompt (default)',
    { skip },
    () => {
      const out = promptInput([]);
      assert.ok(
        out.includes(GLOBAL_MARKER),
        'the global $CODEX_HOME/AGENTS.md governance MUST reach the model-visible context',
      );
      // Baseline: by default a local project AGENTS.md is ALSO ingested — this is the
      // governance-bypass risk bug #2 closes.
      assert.ok(
        out.includes(LOCAL_MARKER),
        'a local project AGENTS.md is ingested by default (establishes the bypass risk)',
      );
    },
  );

  it(
    'project_doc_max_bytes=0 DROPS the local AGENTS.md while global governance survives',
    { skip },
    () => {
      const out = promptInput(['-c', 'project_doc_max_bytes=0']);
      assert.ok(
        out.includes(GLOBAL_MARKER),
        'global governance MUST still be ingested under project_doc_max_bytes=0',
      );
      assert.equal(
        out.includes(LOCAL_MARKER),
        false,
        'the local project AGENTS.md MUST be dropped — no governance bypass',
      );
    },
  );
});
