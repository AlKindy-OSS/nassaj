import type { NormalizedMessage } from '../../../../stores/useSessionStore';

const timestamp = (index: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString();
const agentTypes = ['backend-dev', 'frontend-dev', 'qa-critic'] as const;

/**
 * A compact, synthetic active-run window. Its last twenty rows intentionally
 * contain neither the human boundary nor Agent containers, while the expanded
 * window contains nine completed agents with one child tool each.
 */
export const SYNTHETIC_RUN_WINDOW: NormalizedMessage[] = [
  {
    id: 'msg_synthetic_boundary',
    sessionId: 'ses_synthetic_run_window',
    timestamp: timestamp(0),
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'نفّذ المهام التمثيلية.',
  } as NormalizedMessage,
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `msg_synthetic_agent_${index}`,
    sessionId: 'ses_synthetic_run_window',
    timestamp: timestamp(index + 1),
    provider: 'claude',
    kind: 'tool_use',
    role: 'assistant',
    toolName: 'Agent',
    toolId: `toolu_synthetic_agent_${index}`,
    toolInput: {
      description: `Synthetic task ${index + 1}`,
      subagent_type: agentTypes[index % agentTypes.length],
    },
    subagentTools: [{
      toolId: `toolu_synthetic_child_${index}`,
      toolName: 'Read',
      toolInput: { file_path: `/workspace/fixture-${index}.ts` },
      toolResult: { content: 'ok' },
      timestamp: timestamp(index + 1),
    }],
  } as NormalizedMessage)),
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `msg_synthetic_result_${index}`,
    sessionId: 'ses_synthetic_run_window',
    timestamp: timestamp(index + 10),
    provider: 'claude',
    kind: 'tool_result',
    role: 'user',
    toolId: `toolu_synthetic_agent_${index}`,
    content: 'completed',
  } as NormalizedMessage)),
  ...Array.from({ length: 30 }, (_, index) => ({
    id: `msg_synthetic_tail_${index}`,
    sessionId: 'ses_synthetic_run_window',
    timestamp: timestamp(index + 19),
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: `Synthetic tail row ${index + 1}`,
    originKind: 'system',
  } as NormalizedMessage)),
];
