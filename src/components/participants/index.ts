export { default as ParticipantAvatar } from './ParticipantAvatar';
export { default as ParticipantAvatarStack } from './ParticipantAvatarStack';
export { default as AgentChip } from './AgentChip';
export { default as AgentChipRow } from './AgentChipRow';
export { default as SessionParticipantsRow } from './SessionParticipantsRow';
export { default as SessionParticipantsBar } from './SessionParticipantsBar';
export { default as ProjectParticipantsSummary } from './ProjectParticipantsSummary';
export { useSessionParticipants, useProjectParticipants } from './hooks';
export type {
  SessionParticipant,
  SessionAgent,
  ProjectParticipants,
  ParticipantRole,
  AgentKind,
} from './types';
