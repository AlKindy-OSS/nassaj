/** recordSpawn context for one Claude run (see participantsDb.recordSpawn). */
export type ClaudeParticipantContext = { provider: 'claude'; projectPath: string; sharedWriter: boolean };

/**
 * ADR-173 (H2, R3): the sender is recorded participant/shared_write exactly when the
 * server marked the launch `sharedResume` or `sharedParticipant`. The chat boundary
 * always writes both after the client's options, so only the `true` it computed qualifies.
 */
export function claudeParticipantContext(
  options: { cwd?: unknown; projectPath?: unknown; sharedResume?: unknown; sharedParticipant?: unknown },
  fallbackCwd: string,
): ClaudeParticipantContext {
  const projectPath = [options.cwd, options.projectPath]
    .find((value): value is string => typeof value === 'string' && value !== '');
  const sharedWriter = options.sharedResume === true || options.sharedParticipant === true;
  return { provider: 'claude', projectPath: projectPath ?? fallbackCwd, sharedWriter };
}
