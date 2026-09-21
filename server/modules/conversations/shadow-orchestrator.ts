import type { AcceptedRunCommand, AcceptRunCommandInput } from './repository.js';

export const UNIVERSAL_CONVERSATION_SHADOW_FLAG = 'NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW';

export interface ShadowRunRepository {
  acceptRunCommand(input: AcceptRunCommandInput): AcceptedRunCommand;
}

export type ShadowAcceptance =
  | { enabled: false; recorded: false }
  | { enabled: true; recorded: true; command: AcceptedRunCommand };

/**
 * Phase-0 façade. It has no adapter registry and cannot dispatch a harness.
 * Legacy callers may eventually feed it accepted turns for comparison only.
 */
export class ShadowConversationOrchestrator {
  readonly enabled: boolean;

  constructor(
    private readonly repository: ShadowRunRepository,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.enabled = env[UNIVERSAL_CONVERSATION_SHADOW_FLAG] === '1';
  }

  recordAcceptedRun(input: AcceptRunCommandInput): ShadowAcceptance {
    if (!this.enabled) return { enabled: false, recorded: false };
    return {
      enabled: true,
      recorded: true,
      command: this.repository.acceptRunCommand(input),
    };
  }
}
