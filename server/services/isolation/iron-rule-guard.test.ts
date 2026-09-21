/**
 * iron-rule-guard.test.ts — static enforcement of the iron rule for the hosted
 * vendor seam (C-VR-7, part 2).
 *
 * The iron rule: the kimi/deepseek/glm execution path must be a fully independent
 * client that can never route a Claude client to a competitor. We assert this two
 * ways, by reading the seam source (no network calls, deterministic):
 *
 *  1. NO Anthropic SDK / Claude path: none of the vendor seam files import
 *     `@anthropic-ai/...` or route through `claude-sdk.js`.
 *  2. NO env var under the ANTHROPIC or CLAUDE namespace: the seam never reads or
 *     writes ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, or any ANTHROPIC_/CLAUDE_
 *     env var (the only credential is the provider-specific KEY var).
 *
 * This is the positive counterpart to the negative claude-path guard test — it
 * proves the boundary at the vendor seam itself, not just on the Claude side.
 *
 * Runner: node:test + node:assert/strict (no vitest).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..', '..');

/** The complete set of source files that make up the hosted vendor run seam. */
const SEAM_FILES: string[] = [
  // Run seam (CLI entrypoints + shared HTTP runtime).
  path.join(serverRoot, 'kimi-cli.js'),
  path.join(serverRoot, 'deepseek-cli.js'),
  path.join(serverRoot, 'glm-cli.js'),
  path.join(serverRoot, 'modules', 'providers', 'shared', 'vendor', 'vendor-runtime.js'),
  // Provider/catalog/sessions/config that the seam pulls in.
  path.join(serverRoot, 'modules', 'providers', 'shared', 'vendor', 'vendor-catalog.client.ts'),
  path.join(serverRoot, 'modules', 'providers', 'shared', 'vendor', 'vendor-config.ts'),
  path.join(serverRoot, 'modules', 'providers', 'shared', 'vendor', 'vendor-sessions.provider.ts'),
  path.join(serverRoot, 'modules', 'providers', 'shared', 'vendor', 'vendor-models.provider.ts'),
  path.join(serverRoot, 'modules', 'providers', 'shared', 'vendor', 'vendor-auth.provider.ts'),
  path.join(serverRoot, 'modules', 'providers', 'shared', 'vendor', 'vendor-transcript.ts'),
  path.join(serverRoot, 'modules', 'providers', 'list', 'kimi', 'kimi.provider.ts'),
  path.join(serverRoot, 'modules', 'providers', 'list', 'deepseek', 'deepseek.provider.ts'),
  path.join(serverRoot, 'modules', 'providers', 'list', 'glm', 'glm.provider.ts'),
];

/** Strips // line comments and block comments so matches reflect real code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readSeamCode(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  return stripComments(raw);
}

test('iron rule: vendor seam imports no @anthropic-ai SDK', () => {
  for (const file of SEAM_FILES) {
    const code = readSeamCode(file);
    assert.ok(
      !/@anthropic-ai\//.test(code),
      `${path.basename(file)} must not import any @anthropic-ai package`,
    );
  }
});

test('iron rule: vendor seam does not route through claude-sdk.js', () => {
  for (const file of SEAM_FILES) {
    const code = readSeamCode(file);
    assert.ok(
      !/claude-sdk/.test(code),
      `${path.basename(file)} must not import or reference claude-sdk`,
    );
  }
});

test('iron rule: vendor seam never reads/writes an ANTHROPIC_*/CLAUDE_* env var', () => {
  for (const file of SEAM_FILES) {
    const code = readSeamCode(file);
    const anthropicEnv = code.match(/ANTHROPIC_[A-Z_]+/g) ?? [];
    const claudeEnv = code.match(/CLAUDE_[A-Z_]+/g) ?? [];
    assert.deepEqual(
      anthropicEnv,
      [],
      `${path.basename(file)} references ANTHROPIC_* in code: ${anthropicEnv.join(', ')}`,
    );
    assert.deepEqual(
      claudeEnv,
      [],
      `${path.basename(file)} references CLAUDE_* in code: ${claudeEnv.join(', ')}`,
    );
  }
});

test('iron rule: every seam file exists (guard list stays in sync with the seam)', () => {
  for (const file of SEAM_FILES) {
    assert.ok(fs.existsSync(file), `expected seam file missing: ${file}`);
  }
});
