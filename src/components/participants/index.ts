export { default as ParticipantAvatar } from './ParticipantAvatar';
export { default as ParticipantAvatarStack } from './ParticipantAvatarStack';
// AgentChip / AgentChipRow / SessionParticipantsRow were removed with B-410.
// They were the pre-collapse inline roster: exported here, imported by nothing
// since SessionAgentsChip replaced them in the bar. Their one live idea — the
// distinct-agents + total-calls summary — now lives in `summarizeAgents`
// (utils.ts) with a single consumer, so it cannot fork into two counts again.
export { default as SessionParticipantsBar } from './SessionParticipantsBar';
export { default as ProjectParticipantsSummary } from './ProjectParticipantsSummary';
export { default as ManageProjectMembersButton } from './ManageProjectMembersDialog';
export { useSessionParticipants, useProjectParticipants } from './hooks';
export type {
  SessionParticipant,
  SessionAgent,
  ProjectParticipants,
  ParticipantRole,
  AgentKind,
} from './types';
