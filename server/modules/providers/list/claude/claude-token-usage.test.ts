import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { latestClaudeTokenUsage, readClaudeTranscriptForSession } from './claude-token-usage.js';

describe('readClaudeTranscriptForSession', () => {
  const withClaudeTree = async (run: (root: string) => Promise<void>): Promise<void> => {
    const originalHome = process.env.HOME;
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const root = await mkdtemp(path.join('/var/tmp', 'claude-token-usage-'));
    process.env.HOME = root;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
    try {
      await mkdir(path.join(root, '.claude', 'projects', 'work'), { recursive: true });
      await run(root);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  };

  it('accepts a regular transcript with matching provider and project', async () => {
    await withClaudeTree(async (root) => {
      const transcript = path.join(root, '.claude', 'projects', 'work', 'session.jsonl');
      await writeFile(transcript, '{}\n');
      assert.equal(await readClaudeTranscriptForSession({
        session_id: 'session', provider: 'claude', project_path: '/workspace/app', jsonl_path: transcript,
      }, '/workspace/app', null), '{}\n');
    });
  });

  it('rejects a provider or project mismatch', async () => {
    const base = {
      session_id: 'session', project_path: '/workspace/app', jsonl_path: '/var/tmp/session.jsonl',
    };
    assert.equal(await readClaudeTranscriptForSession({ ...base, provider: 'codex' }, '/workspace/app', null), null);
    assert.equal(await readClaudeTranscriptForSession({ ...base, provider: 'claude' }, '/workspace/other', null), null);
  });

  it('never follows a transcript path swapped to a symlink outside the root', async () => {
    await withClaudeTree(async (root) => {
      const transcript = path.join(root, '.claude', 'projects', 'work', 'session.jsonl');
      const staged = path.join(root, '.claude', 'projects', 'work', 'staged-link');
      const outside = path.join(root, 'outside.jsonl');
      await writeFile(outside, 'outside-secret\n');

      const reads: Array<Promise<string | null>> = [];
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await rm(transcript, { force: true });
        await writeFile(transcript, 'authorized\n');
        await rm(staged, { force: true });
        await symlink(outside, staged);
        reads.push(readClaudeTranscriptForSession({
          session_id: 'session', provider: 'claude', project_path: '/workspace/app', jsonl_path: transcript,
        }, '/workspace/app', null));
        await rename(staged, transcript);
      }

      const results = await Promise.all(reads);
      assert.equal(results.includes('outside-secret\n'), false);
      assert.equal(results.every((value) => value === null || value === 'authorized\n'), true);
    });
  });
});

describe('latestClaudeTokenUsage', () => {
  it('includes cache reads and cache creation in occupied context', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { model: 'old', usage: { input_tokens: 1 } } }),
      '{truncated',
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 4_000,
            cache_creation_input_tokens: 300,
            output_tokens: 88,
          },
        },
      }),
    ].join('\n');

    const { cacheSnapshot, ...legacy } = latestClaudeTokenUsage(jsonl);
    assert.equal(cacheSnapshot?.cacheReadTokens, 4000);
    assert.deepEqual(legacy, {
      inputTokens: 4_312,
      outputTokens: 88,
      modelName: 'claude-sonnet-4-5',
      breakdown: { input: 4_312, output: 88, cacheRead: 4_000, cacheCreation: 300 },
    });
  });

  it('returns an empty snapshot when no assistant usage exists', () => {
    assert.equal(latestClaudeTokenUsage('{bad\n{"type":"user"}').inputTokens, 0);
  });
});
