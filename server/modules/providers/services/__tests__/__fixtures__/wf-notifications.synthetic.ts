/** Synthetic rows preserving parser-relevant notification shapes only. */
const DISTANCE_FILLER = 'synthetic-result-body-'.repeat(180);

function notificationLine(
  type: 'queue-operation' | 'attachment' | 'user',
  status: 'completed' | 'failed' | 'killed',
  workflowId: string,
): string {
  return JSON.stringify({
    type,
    timestamp: '2000-01-01T00:00:00.000Z',
    sessionId: 'synthetic-session',
    content: [
      '<task-notification>',
      '<task-id>synthetic-task</task-id>',
      `<status>${status}</status>`,
      `<summary>${DISTANCE_FILLER} resumeFromRunId: "${workflowId}"</summary>`,
      '</task-notification>',
    ].join('\n'),
  });
}

export const SYNTHETIC_NOTIFICATION_LINES: Record<string, string> = {
  'queue-operation:completed': notificationLine('queue-operation', 'completed', 'wf_11111111-b0b'),
  'attachment:failed': notificationLine('attachment', 'failed', 'wf_22222222-cafe'),
  'user:killed': notificationLine('user', 'killed', 'wf_10000000-dead'),
};
