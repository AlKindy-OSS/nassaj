export type LLMProvider =
  | 'claude'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'opencode'
  // Hosted vendor providers (ADR-036, internal single-user). Each is its own
  // provider over server/modules/providers and surfaces in the model picker /
  // auth-status the moment its API key is configured (ADR-030 behavior).
  | 'kimi'
  | 'deepseek'
  | 'glm'
  | 'hermes'
  | 'sakana';

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

// 'terminal' is the standalone-terminals surface (T-939): a project-independent
// full-area view driven from the sidebar's Terminals section, not the per-project
// tab switcher.
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'board' | 'preview' | 'wiki' | 'terminal' | `plugin:${string}`;

// Owner attribution for a session (B-MU-UX-API). Resolved server-side from the
// session_participants row flagged 'owner'. `null` for legacy / pre-multi-user
// sessions with no participant row — the UI falls back to a neutral state.
export interface SessionOwner {
  userId: number;
  username: string;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) when the
  // owner has uploaded one; null/undefined falls back to the coloured initial.
  avatarUrl?: string | null;
}

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  // Owning human of this session, or null for legacy sessions (B-MU-UX-API).
  owner?: SessionOwner | null;
  // Per-user favourite flag for the current user (server-stamped on session
  // list responses). Starred sessions sort to the top within their project.
  starred?: boolean;
  // Closure state (cost settlement): a closed conversation is finished — its
  // cost is final and no new turns are expected. Optional because legacy
  // payloads (and any provider list built before the feature) omit all three;
  // absent must read as "not closed", never as an unknown third state.
  closed?: boolean;
  closedAt?: string | null;
  closedBy?: number | null;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  // True when the requesting user participates in >=1 session of this project
  // (B-MU-UX-PROJ-FILTER). Informational only — the server never filters the
  // project list; the frontend "My Projects / All" toggle uses this flag.
  isMember?: boolean;
  // Creator attribution for the sidebar "My projects / Team / All" filter.
  // `ownerId` is the creator's user id (null for legacy/orphan projects);
  // `isOwner` is stamped per-user by the server (creator or an owner-role
  // project member). View-filter inputs only — never an access decision.
  ownerId?: number | null;
  isOwner?: boolean;
  // Project privacy (C-PRIV-6). The server removes private projects the user
  // cannot see from the list entirely — these flags only drive UI affordances.
  visibility?: 'public' | 'private';
  // True when the user may flip visibility / manage members (project creator,
  // an owner-role member, or the platform owner). Set by the server.
  canManageVisibility?: boolean;
  sessions?: ProjectSession[];
  cursorSessions?: ProjectSession[];
  codexSessions?: ProjectSession[];
  geminiSessions?: ProjectSession[];
  antigravitySessions?: ProjectSession[];
  opencodeSessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  [key: string]: unknown;
}

export interface LoadingProgress {
  type?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}

export interface ProjectsUpdatedMessage {
  type: 'projects_updated';
  projects: Project[];
  updatedSessionId?: string;
  updatedSessionIds?: string[];
  watchProvider?: LLMProvider;
  watchProviders?: LLMProvider[];
  changeType?: 'add' | 'change' | 'unlink';
  changeTypes?: Array<'add' | 'change' | 'unlink'>;
  batched?: boolean;
  [key: string]: unknown;
}

export interface LoadingProgressMessage extends LoadingProgress {
  type: 'loading_progress';
}

export type AppSocketMessage =
  | LoadingProgressMessage
  | ProjectsUpdatedMessage
  | { type?: string;[key: string]: unknown };
