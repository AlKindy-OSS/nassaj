/**
 * Test layout for cost readers that bind a transcript to its session
 * (ADR-201 A-P2c): files live in the sandbox provider roots the reader
 * confines to, are named after their id, and start with an id-bearing header.
 *
 * Header shapes come from observed transcripts, with every value redacted:
 *   - Claude: the CLI's first record `{"type":"ai-title","aiTitle":…,"sessionId":…}`
 *     (keys measured on this host 2026-10-12). Usage accounting ignores it.
 *   - Codex: `session_meta` as in services/__fixtures__/session-share/codex.jsonl
 *     (B-1520 redacted), reduced to the identity fields.
 *
 * The test file must import '@/shared/__tests__/sandbox-home.js' FIRST, so
 * `os.homedir()` is the sandbox before any root is computed. No content of
 * any user's session is copied here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Encoded project directory of the redacted share fixtures. */
export const CLAUDE_PROJECT_DIR = '-home-operator-Project-General';

/** `<home>` of the operator (null) or of member tree `<n>` under the sandbox HOME. */
function treeHome(member: string | null): string {
  return member === null ? os.homedir() : path.join(os.homedir(), '.nassaj-users', member);
}

/** Claude provider root of a tree. */
export function claudeProjectsRoot(member: string | null = null): string {
  return path.join(treeHome(member), '.claude', 'projects');
}

/** Codex provider root of a tree. */
export function codexSessionsRoot(member: string | null = null): string {
  return path.join(treeHome(member), '.codex', 'sessions');
}

/** Where Claude writes the transcript of `sessionId` in a tree. */
export function claudeTranscriptPath(sessionId: string, member: string | null = null, project = CLAUDE_PROJECT_DIR): string {
  return path.join(claudeProjectsRoot(member), project, `${sessionId}.jsonl`);
}

/** Where Codex writes the rollout of `threadId` in a tree (`YYYY/MM/DD/rollout-<stamp>-<id>.jsonl`). */
export function codexRolloutPath(threadId: string, member: string | null = null, stamp = '2026-07-26T04-12-29'): string {
  const [year, month, day] = stamp.slice(0, 10).split('-');
  return path.join(codexSessionsRoot(member), year, month, day, `rollout-${stamp}-${threadId}.jsonl`);
}

/** Claude header record carrying `sessionId`. */
export function claudeHeaderLine(sessionId: string): string {
  return `${JSON.stringify({ type: 'ai-title', aiTitle: 'fixture title', sessionId })}\n`;
}

export type CodexHeader = {
  sessionId?: string; parentThreadId?: string; threadSource?: string; agentPath?: string; cwd?: string; timestamp?: string;
};

/** Codex `session_meta` of thread `threadId` (a root by default: `session_id` = id, `thread_source` user). */
export function codexHeaderLine(threadId: string, header: CodexHeader = {}): string {
  const timestamp = header.timestamp ?? '2026-07-26T04:12:29.000Z';
  return `${JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: {
      session_id: header.sessionId ?? threadId,
      id: threadId,
      timestamp,
      ...(header.cwd ? { cwd: header.cwd } : {}),
      originator: 'codex_sdk_ts',
      cli_version: '0.144.1',
      thread_source: header.threadSource ?? 'user',
      ...(header.parentThreadId ? { parent_thread_id: header.parentThreadId } : {}),
      ...(header.agentPath ? { agent_path: header.agentPath } : {}),
    },
  })}\n`;
}

/** Writes `text` at `target`, creating its directories. */
export function writeTranscript(target: string, text: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

let counter = 0;

/** A fresh UUID-shaped id (`prefix` is 8 hex chars), unique in this process. */
export function nextSessionId(prefix = '0000c0a7'): string {
  counter += 1;
  return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}
