import type { NormalizedMessage } from '../../../../stores/useSessionStore';

/**
 * ADR-199 client fixtures, excerpted from the real server captures added in
 * 81020acef:
 *   server/modules/providers/list/claude/__tests__/__fixtures__/
 *     claude-progress-sdk-stream.real.json  (live SDK stream, Claude Code 2.1.289)
 *     claude-progress-history.real.json     (two real JSONL transcript calls)
 * Ids, timestamps, labels and statuses are copied verbatim; `plan` and
 * `subagent` are the exact values claude-progress.test.ts asserts the adapter
 * emits for those events. Tool names are kept only because the server sends
 * them; the progress hooks never read them.
 */

const SESSION = { sessionId: 'ses_adr199_fixture', provider: 'claude' as const };

/** Owner prompt that opens the reply (boundary for the progress scan). */
const PROMPT: NormalizedMessage = {
  ...SESSION, id: 'u_prompt', kind: 'text', role: 'user', content: 'go', userId: 1,
  timestamp: '2026-10-09T06:26:28.000Z',
} as NormalizedMessage;

const AGENT_LIVE = 'toolu_01WcE3ua1KLZd5XE3Etd6sPo';
const TODO_1 = 'toolu_01NQReCbsFjRsqPEtViRc7uM';
const TODO_2 = 'toolu_01VcqgxoL13SpjaZLK2GM8cZ';

/** Live SDK run, in stream order, as normalized rows. */
export const LIVE_STREAM_ROWS: NormalizedMessage[] = [
  PROMPT,
  {
    ...SESSION, id: 'e1', kind: 'tool_use', role: 'assistant', toolName: 'TodoWrite', toolId: TODO_1,
    toolInput: { todos: [
      { content: 'Say hello', status: 'in_progress', activeForm: 'Saying hello' },
      { content: 'Say bye', status: 'pending', activeForm: 'Saying bye' },
    ] },
    plan: { source: 'tool', items: [
      { id: '0', label: 'Say hello', status: 'in_progress' }, { id: '1', label: 'Say bye', status: 'pending' },
    ] },
    timestamp: '2026-10-09T06:26:29.044Z',
  },
  {
    ...SESSION, id: 'e2', kind: 'tool_result', role: 'user', toolId: TODO_1, content: '',
    timestamp: '2026-10-09T06:26:29.049Z',
  },
  {
    ...SESSION, id: 'e3', kind: 'tool_use', role: 'assistant', toolName: 'Agent', toolId: AGENT_LIVE,
    toolInput: { description: 'Reply OK', subagent_type: 'general-purpose', prompt: 'Reply with the single word OK and do nothing else.' },
    subagent: { id: AGENT_LIVE, parentId: null, label: 'Reply OK', state: 'started' },
    timestamp: '2026-10-09T06:26:29.412Z',
  },
  {
    ...SESSION, id: 'e4', kind: 'tool_result', role: 'user', toolId: AGENT_LIVE, content: '',
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a9254f52736edb186', description: 'Reply OK' },
    subagent: { id: AGENT_LIVE, parentId: null, label: 'Reply OK', state: 'running' },
    timestamp: '2026-10-09T06:26:29.474Z',
  },
  {
    ...SESSION, id: 'e5', kind: 'text', role: 'assistant', content: 'OK', parentToolUseId: AGENT_LIVE,
    isSidechain: true, timestamp: '2026-10-09T06:26:32.311Z',
  },
  {
    ...SESSION, id: 'e6', kind: 'tool_use', role: 'assistant', toolName: 'TodoWrite', toolId: TODO_2,
    toolInput: { todos: [
      { content: 'Say hello', status: 'completed', activeForm: 'Saying hello' },
      { content: 'Say bye', status: 'completed', activeForm: 'Saying bye' },
    ] },
    plan: { source: 'tool', items: [
      { id: '0', label: 'Say hello', status: 'completed' }, { id: '1', label: 'Say bye', status: 'completed' },
    ] },
    timestamp: '2026-10-09T06:26:35.009Z',
  },
  {
    ...SESSION, id: 'e7', kind: 'tool_result', role: 'user', toolId: TODO_2, content: '',
    timestamp: '2026-10-09T06:26:35.014Z',
  },
] as NormalizedMessage[];

const AGENT_DONE = 'toolu_01BgA1BUJYo1PBna6KtE9ifb';
const AGENT_DENIED = 'toolu_017bCT3ChGLe3dM2Z5GZAZJ8';

/** History load of the two recorded transcript calls (completed, then failed). */
export const HISTORY_ROWS: NormalizedMessage[] = [
  { ...PROMPT, timestamp: '2026-09-24T16:59:30.000Z' },
  {
    ...SESSION, id: 'h1', kind: 'tool_use', role: 'assistant', toolName: 'Agent', toolId: AGENT_DONE,
    toolInput: { subagent_type: 'devops', description: 'Diagnose send failure', run_in_background: false, prompt: '[scrubbed prompt]' },
    subagent: { id: AGENT_DONE, parentId: null, label: 'Diagnose send failure', state: 'started' },
    timestamp: '2026-09-24T16:59:35.947Z',
  },
  {
    ...SESSION, id: 'h2', kind: 'tool_result', role: 'user', toolId: AGENT_DONE, content: '[scrubbed subagent report]',
    toolUseResult: { status: 'completed', agentId: 'af3acf75cb5ff54d0', agentType: 'devops' },
    subagent: { id: AGENT_DONE, parentId: null, label: 'Diagnose send failure', state: 'completed' },
    timestamp: '2026-09-24T17:01:02.179Z',
  },
  {
    ...SESSION, id: 'h3', kind: 'tool_use', role: 'assistant', toolName: 'Agent', toolId: AGENT_DENIED,
    toolInput: { subagent_type: 'architect', description: 'Design activation change', run_in_background: true, prompt: '[scrubbed prompt]' },
    subagent: { id: AGENT_DENIED, parentId: null, label: 'Design activation change', state: 'started' },
    timestamp: '2026-10-06T11:55:10.262Z',
  },
  {
    ...SESSION, id: 'h4', kind: 'tool_result', role: 'user', toolId: AGENT_DENIED, isError: true,
    content: 'Not run: the response that made this tool call was stopped by a safety classifier.',
    subagent: { id: AGENT_DENIED, parentId: null, label: 'Design activation change', state: 'failed' },
    timestamp: '2026-10-06T11:55:10.277Z',
  },
] as NormalizedMessage[];

export const FIXTURE_IDS = { AGENT_LIVE, AGENT_DONE, AGENT_DENIED, TODO_1, TODO_2 };
