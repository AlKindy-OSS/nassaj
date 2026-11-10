/**
 * T-2098 stage 3b AC6 (ADR-194): the Claude local-model picker and permission code
 * names no model runtime and no model vendor. Labels come from the member's own
 * server rows, never from a hard-coded list.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const STAGE_3B_FILES = [
  'shared/localEngine.ts',
  'server/services/isolation/claude-local-overlay.js',
  'server/modules/providers/claude-local.routes.ts',
];

const FORBIDDEN = /\b(ollama|llama(?:\.cpp|-swap|cpp)?|lm ?studio|vllm|localai|koboldcpp|jan|gpt-oss|qwen\w*|gemma\w*|mistral|mixtral|phi-?\d|deepseek|kimi|moonshot|glm|z\.ai|openai|tailscale)\b/iu;

test('stage 3b code names no runtime or vendor', () => {
  for (const file of STAGE_3B_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      assert.equal(FORBIDDEN.test(line), false, `${file}:${index + 1} names a runtime or vendor: ${line.trim()}`);
    });
  }
});
