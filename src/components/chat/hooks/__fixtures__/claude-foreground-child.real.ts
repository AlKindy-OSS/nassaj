import type { NormalizedMessage } from '../../../../stores/useSessionStore';

/**
 * Scrubbed normalized rows from a real 2026-09-24 Claude foreground task.
 * The parent call/result are from claude-progress-history.real.json; the child
 * Bash event and message metadata are from agent-af3acf75cb5ff54d0.jsonl.
 */
const SESSION = { sessionId: 'ses_fixture_foreground', provider: 'claude' as const };
export const FOREGROUND_AGENT = 'toolu_01BgA1BUJYo1PBna6KtE9ifb';

export const FOREGROUND_ROWS: NormalizedMessage[] = [
  {
    ...SESSION, id: 'prompt', kind: 'text', role: 'user', content: 'Check the service.',
    userId: 1, timestamp: '2026-09-24T16:59:30.000Z',
  } as NormalizedMessage,
  {
    ...SESSION, id: 'call', kind: 'tool_use', role: 'assistant', toolName: 'Agent',
    toolId: FOREGROUND_AGENT,
    toolInput: {
      subagent_type: 'devops', description: 'Diagnose send failure',
      run_in_background: false, prompt: '[scrubbed]',
    },
    subagent: {
      id: FOREGROUND_AGENT, parentId: null, label: 'Diagnose send failure',
      state: 'started',
    },
    subagentTools: [{
      toolId: 'toolu_01NcnrUv24kqoVLwDiCo7366',
      toolName: 'Bash',
      toolInput: { command: '[scrubbed]', description: '[scrubbed]' },
      toolResult: { content: '[scrubbed]', isError: false },
      timestamp: '2026-09-24T16:59:38.871Z',
    }],
    timestamp: '2026-09-24T16:59:35.947Z',
  } as NormalizedMessage,
  {
    ...SESSION, id: 'child_snapshot', kind: 'status',
    subagent: {
      id: FOREGROUND_AGENT, parentId: null, label: 'Diagnose send failure',
      state: 'running', model: 'claude-opus-5-5', effort: 'medium',
      tools: [{ name: 'Bash', status: 'done' }],
    },
    timestamp: '2026-09-24T16:59:38.871Z',
  } as NormalizedMessage,
  {
    ...SESSION, id: 'result', kind: 'tool_result', role: 'user',
    toolId: FOREGROUND_AGENT, content: '[scrubbed result]',
    toolUseResult: { status: 'completed', agentId: 'af3acf75cb5ff54d0', agentType: 'devops' },
    subagent: {
      id: FOREGROUND_AGENT, parentId: null, label: 'Diagnose send failure',
      state: 'completed',
    },
    timestamp: '2026-09-24T17:01:02.179Z',
  } as NormalizedMessage,
];
