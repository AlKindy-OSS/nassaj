import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openPinned } from '@/modules/providers/shared/pinned-fd.js';
import type { SessionTranscriptHandle } from '@/modules/providers/shared/session-transcript-reader.js';

/**
 * B-1564: history readers refuse transcripts outside their provider root, so
 * fixtures must live under the (sandbox) HOME's provider trees. These helpers
 * create a fresh directory there, and refuse to run when HOME is the real
 * account home (the passwd entry), so a direct `node --test` outside the
 * isolated runner can never write into live provider state.
 */
function sandboxHome(): string {
  const home = fs.realpathSync(os.homedir());
  if (home === fs.realpathSync(os.userInfo().homedir)) {
    throw new Error('provider-root-sandbox: HOME is the real account home; run under the isolated test runner');
  }
  return home;
}

function freshDirUnder(root: string, prefix: string): string {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

/** A fresh directory under `~/.codex/sessions` (the operator Codex history root). */
export function codexSessionsSandbox(prefix: string): string {
  return freshDirUnder(path.join(sandboxHome(), '.codex', 'sessions'), prefix);
}

/** A fresh directory under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects` (the Claude history root). */
export function claudeProjectsSandbox(prefix: string): string {
  const home = sandboxHome();
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  if (!fs.realpathSync(path.dirname(configDir)).startsWith(home)) {
    throw new Error('provider-root-sandbox: CLAUDE_CONFIG_DIR is outside the sandbox HOME');
  }
  return freshDirUnder(path.join(configDir, 'projects'), prefix);
}

/**
 * ADR-201 A1: what the history service hands a provider reader — `file` pinned
 * as `sessionId`'s transcript — for parser tests that drive a provider directly
 * with synthetic rows. Containment and id binding are not exercised here (the
 * session-transcript tests own them); the descriptor is closed after `read`.
 */
export async function withPinnedTranscript<T>(
  file: string,
  sessionId: string,
  provider: string,
  read: (transcript: SessionTranscriptHandle) => Promise<T>,
): Promise<T> {
  const { handle, realpath, stat } = await openPinned(fs.realpathSync(file), 'file');
  try {
    return await read({ fd: handle, realpath, stat, sessionId, provider });
  } finally {
    await handle.close();
  }
}

const SHARE_FIXTURES = path.join(import.meta.dirname, '..', '..', 'services', '__fixtures__', 'session-share');

/**
 * First record of the real Claude share fixture (B-1520 redacted) re-keyed to
 * `sessionId`: the id-bearing header the transcript reader binds (ADR-201 A1.4).
 */
export function claudeHeaderLine(sessionId: string): string {
  const [first] = fs.readFileSync(path.join(SHARE_FIXTURES, 'claude.jsonl'), 'utf8').split('\n');
  return JSON.stringify({ ...JSON.parse(first) as Record<string, unknown>, sessionId });
}

/** Real Codex rollout header (session-share fixture, B-1520 redacted), re-keyed to `sessionId`. */
export function codexSessionMetaLine(sessionId: string): string {
  const [first] = fs.readFileSync(path.join(SHARE_FIXTURES, 'codex.jsonl'), 'utf8').split('\n');
  const meta = JSON.parse(first) as { payload: Record<string, unknown> };
  meta.payload = { ...meta.payload, id: sessionId, session_id: sessionId };
  return JSON.stringify(meta);
}

/** `<dir>/rollout-<timestamp>-<sessionId>.jsonl`: the name Codex gives a rollout. */
export function codexRolloutPath(dir: string, sessionId: string): string {
  return path.join(dir, `rollout-2026-09-01T14-24-33-${sessionId}.jsonl`);
}

/**
 * Prepends the real `session_meta` header bound to `sessionId` (ADR-201 A1.4)
 * unless the file already starts with one; returns `file`.
 */
export function withCodexSessionMeta(file: string, sessionId: string): string {
  const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!body.startsWith('{"timestamp"') || !body.split('\n')[0].includes('"session_meta"')) {
    fs.writeFileSync(file, `${codexSessionMetaLine(sessionId)}\n${body}`);
  }
  return file;
}
