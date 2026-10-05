/**
 * B-1541 — the workflow supervisor's resume turn re-runs the spawn guard at the
 * turn's project path; an Anthropic key in that project's local settings must
 * refuse an engine-pinned turn before any child is spawned.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

const realBinaries = await import('@/shared/harness-binaries.js');
mock.module('@/shared/harness-binaries.js', {
  namedExports: { ...realBinaries, resolveHarnessBinaryWithOverride: () => '/bin/true' },
});

const { defaultRunResumeTurn } = await import('../resume-turn-runner.js');

function fixture(): { root: string; project: string; configDir: string } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'b1541-resume-'));
  const project = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return { root, project, configDir };
}

test('engine-pinned resume turn refuses a key in <projectPath>/.claude/settings.local.json', async () => {
  const fx = fixture();
  try {
    fs.mkdirSync(path.join(fx.project, '.claude'));
    fs.writeFileSync(path.join(fx.project, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: [] }, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-FIXTURE' } }));
    const result = await defaultRunResumeTurn({
      userId: 7,
      conversationId: 'sess-1',
      projectPath: fx.project,
      prompt: 'p',
      systemFraming: 's',
      model: null,
      disallowedTools: [],
      env: {
        PATH: '/usr/bin',
        HOME: fx.configDir,
        CLAUDE_CONFIG_DIR: fx.configDir,
        ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'vendor-fixture',
      },
      engineHosts: new Set(['api.moonshot.ai']),
      maxHoldMs: 1_000,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /ENGINE_ANTHROPIC_CREDENTIAL_EXPOSED/);
    // A refused turn never started a child: no exit code, not timed out.
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
