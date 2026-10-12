/**
 * ADR-201 A-P4 fixtures: transcript header SHAPES taken from observed transcripts on
 * this host (2026-10-12, operator home only, read-only), with every value
 * replaced. Only key names, key order and the `type`/`source`/`originator`
 * enums were kept; no text, path, id or timestamp of any real file was copied.
 *
 * Observed on the host (last 60 Claude files, newest Codex rollout, 11 agy
 * brains, vendor kimi/qwen/hermes):
 *   - Claude: the first id-bearing record is `ai-title` (52/60) or
 *     `queue-operation` (8/60) and carries `sessionId` but no `cwd`; the first
 *     record with both is a `user` record with the key set below.
 *   - Codex: line 1 is `session_meta` with `payload.id` and `payload.session_id`.
 *   - agy: line 1 is `USER_INPUT` (no id; the brain directory is the id).
 *   - vendor: line 1 is `{"type":"meta","projectPath","sessionName"}`.
 */

const TS = '2026-10-12T00:00:00.000Z';

/** Claude `ai-title` header (the most common first id-bearing record). */
export function claudeAiTitle(sessionId: string, title = 'sandbox title'): Record<string, unknown> {
  return { type: 'ai-title', aiTitle: title, sessionId };
}

/** Claude `queue-operation` header (the other first id-bearing record seen). */
export function claudeQueueOperation(sessionId: string): Record<string, unknown> {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: TS, sessionId, content: 'queued' };
}

/** Claude `user` record with the real key set (first record carrying both `sessionId` and `cwd`). */
export function claudeUserRecord(sessionId: string, cwd: string, text: string): Record<string, unknown> {
  return {
    parentUuid: null, isSidechain: false, promptId: `${sessionId}-p`, type: 'user',
    message: { role: 'user', content: text }, uuid: `${sessionId}-u`, timestamp: TS,
    permissionMode: 'default', promptSource: 'sdk', turnOrigin: 'sdk', userType: 'external',
    entrypoint: 'sdk-ts', cwd, sessionId, version: '0.0.0', gitBranch: 'main',
  };
}

/** Claude assistant reply bound to `sessionId`. */
export function claudeAssistantRecord(sessionId: string, text: string, model = 'claude-sandbox-model'): Record<string, unknown> {
  return {
    type: 'assistant', sessionId, uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`, timestamp: TS,
    message: { id: `msg-${sessionId}`, role: 'assistant', model, content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 } },
  };
}

/**
 * A Claude transcript as the CLI writes it: real-shaped header, then a user
 * prompt and a reply carrying `marker`. `headerId` is the id in every record
 * (a forged file uses the victim's id here).
 */
export function claudeTranscript(headerId: string, cwd: string, marker: string, first: 'ai-title' | 'queue' = 'ai-title'): string {
  const header = first === 'ai-title' ? claudeAiTitle(headerId) : claudeQueueOperation(headerId);
  return [header, claudeUserRecord(headerId, cwd, `prompt ${marker}`), claudeAssistantRecord(headerId, `reply ${marker}`)]
    .map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/** Codex rollout: real-shaped `session_meta` (payload key set from the host) and one user message. */
export function codexRollout(sessionId: string, cwd: string, marker: string): string {
  const meta = {
    timestamp: TS, type: 'session_meta', ordinal: 0,
    payload: {
      id: sessionId, session_id: sessionId, timestamp: TS, cwd, originator: 'codex-tui', cli_version: '0.0.0',
      source: 'cli', thread_source: 'user', model_provider: 'openai', history_mode: 'full',
      base_instructions: { text: 'sandbox', provenance: {} }, context_window: { window_id: 'w' },
      runtime_workspace_roots: [cwd], git: { branch: 'main', commit_hash: '0', repository_url: '' },
    },
  };
  const message = { timestamp: TS, type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] } };
  return `${JSON.stringify(meta)}\n${JSON.stringify(message)}\n`;
}

/** agy brain transcript: real-shaped `USER_INPUT` first record. */
export function agyTranscript(marker: string): string {
  return `${JSON.stringify({
    type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', step_index: 0, created_at: TS,
    truncated_fields: [], content: `<USER_REQUEST>${marker}</USER_REQUEST>`,
  })}\n`;
}
