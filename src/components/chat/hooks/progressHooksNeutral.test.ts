/**
 * ADR-199 guard: the progress hooks read only the neutral `plan` / `subagent`
 * fields, so no provider id and no provider tool name may appear in them, in
 * code or comments. In useChatMessages (code lines) exactly one documented
 * exception remains: LEGACY_CONTAINER_TOOLS, which renders not-yet-migrated
 * containers and never feeds progress.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const HOOKS_DIR = path.resolve(process.cwd(), 'src/components/chat/hooks');
const read = (name: string) => readFileSync(path.join(HOOKS_DIR, name), 'utf8');

const PROVIDER_IDS = /\b(claude|codex|antigravity|agy|opencode|kimi|qwen|cursor|deepseek|glm|hermes|sakana)\b/i;
const TOOL_NAMES = /\b(TodoWrite|TodoRead|TaskCreate|TaskUpdate|TaskList|todowrite|SetTodoList|todo_list|update_plan|spawn_agent|invoke_subagent|collab_tool_call)\b|['"`](Task|Agent)['"`]/;
const TOOL_NAME_BRANCH = /toolName\s*[!=]==?/;

describe('progress hooks are provider-neutral (ADR-199)', () => {
  it.each(['useRunProgress.ts', 'declaredProgress.ts'])('%s names no provider and no tool', (file) => {
    const source = read(file);
    expect(source.match(PROVIDER_IDS)?.[0] ?? null).toBeNull();
    expect(source.match(TOOL_NAMES)?.[0] ?? null).toBeNull();
    expect(source.match(TOOL_NAME_BRANCH)?.[0] ?? null).toBeNull();
  });

  it('isSubagentContainer is decided by the neutral field, tool names only via the legacy set', () => {
    const source = read('useChatMessages.ts');
    expect(source).toMatch(/const isSubagentContainer = Boolean\(msg\.subagent\)\s*\n\s*\|\| LEGACY_CONTAINER_TOOLS\.has\(/);
    // Code lines only: this wide normalizer keeps historical prose in comments.
    const isComment = (line: string) => /^\s*(\/\/|\/?\*)/.test(line);
    const toolNameLines = source.split('\n').filter((line) => !isComment(line) && TOOL_NAMES.test(line));
    expect(toolNameLines).toEqual([
      "const LEGACY_CONTAINER_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);",
    ]);
    expect(source.match(TOOL_NAME_BRANCH)?.[0] ?? null).toBeNull();
  });
});
