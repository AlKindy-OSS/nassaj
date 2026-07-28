// Shared types for the session participants strip.
//
// The core of this UI is the agents/roles display (model + subagents) sourced
// from the transcript — it is independent of identity/multi-user and is what
// the bar primarily exists to show. The human "participants" piece is just a
// session owner/participants display layered on top; it degrades safely to a
// single user (or to nothing) when the identity layer is unavailable. The
// backend tables (session_participants, etc.) remain, but the UI does not
// depend on them to render.
//
// Mirrors the backend contract:
//   GET /api/sessions/:sessionId/participants
//   GET /api/sessions/:sessionId/agents
//   GET /api/projects/:projectId/participants

export type ParticipantRole = 'owner' | 'admin' | 'user' | string;

export type SessionParticipant = {
  // The backend returns a numeric primary key; we keep it loose and coerce to
  // string at the boundary for stable React keys and deterministic colours.
  userId: string | number;
  username: string;
  role: ParticipantRole;
  first_seen: string;
  last_seen: string;
  message_count: number;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) when the user
  // has uploaded an avatar; null/undefined falls back to the coloured initial.
  avatarUrl?: string | null;
};

export type AgentKind = 'model' | 'subagent';

export type SessionAgent = {
  agent_name: string;
  agent_kind: AgentKind;
  invocation_count: number;
  /** Resolved model string (e.g. 'claude-fable-5', 'claude-sonnet-4-6').
   * Available for the coordinator model and for subagents whose model was
   * recoverable from their sidecar JSONL transcript. Null otherwise. */
  agent_model?: string | null;
};

export type ProjectParticipants = {
  users: SessionParticipant[];
  agents: SessionAgent[];
};

export type AsyncResourceStatus = 'idle' | 'loading' | 'success' | 'error';
