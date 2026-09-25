import type { SessionBucketProvider, SessionBuckets } from '../../shared/sessionBuckets';

/**
 * Every provider nassaj can run a conversation on — including the hosted vendor
 * providers of ADR-036 (kimi, deepseek, glm, hermes, sakana), each its own
 * provider over server/modules/providers, surfacing in the model picker /
 * auth-status the moment its API key is configured (ADR-030 behavior).
 *
 * Aliased to the shared list rather than restated: that list also decides which
 * session buckets the project payload carries, and the two drifting apart is
 * exactly how hermes/kimi/glm conversations became invisible (B-598).
 */
export type LLMProvider = SessionBucketProvider;

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
  /**
   * B-437: صحيح حين يكون المعروض الاحتياطي المضمَّن لا كتالوج المزوّد الحيّ —
   * الخادم يرسله منذ البداية والعميل كان يُسقطه من النوع فلا يقرؤه أحد. الفرق
   * ليس تجميلياً: كتالوج حيّ يثبت أن مفتاح المزوّد يعمل، والاحتياطي لا يثبت شيئاً.
   */
  degraded?: boolean;
};

export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

// 'terminal' is the standalone-terminals surface (T-939): a project-independent
// full-area view driven from the sidebar's Terminals section, not the per-project
// tab switcher.
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'board' | 'preview' | 'wiki' | 'terminal';

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

// One human on a session row (T-1194). Slimmer than the participants-bar shape:
// the sidebar stack needs identity, ordering (owner first) and recency only.
export interface SessionRowParticipant {
  userId: number;
  username: string;
  avatarUrl?: string | null;
  role: 'owner' | 'participant';
  lastSeen?: string;
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
  // EVERY human recorded on this session, owner first. Server-stamped on the
  // sessions listing. Absent/empty for legacy sessions with no participant
  // rows; the sidebar then draws no avatars rather than guessing.
  participants?: SessionRowParticipant[];
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
  /**
   * ‏T-1340 — حكمُ آخر جولة، وحالة قراءته العالمية.
   *
   * ‏`outcome` و`outcomeSeen` متطابقان لكل الأعضاء. وبهما يُعرف هل لـ«تحديد كغير مقروء» أثرٌ:
   * بلا حكمٍ قائم
   * لا شيء يُعاد، وعرضُ فعلٍ لا أثر له ربكةٌ لا داعي لها.
   */
  outcome?: 'question' | 'error' | 'done' | null;
  outcomeAt?: string | null;
  outcomeSeen?: boolean;
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
/**
 * `Partial<SessionBuckets<…>>` supplies one session bucket per provider
 * (`sessions`, `cursorSessions`, …) instead of a hand-written list: optional
 * because a partial merge or an older payload may omit a bucket, and shared
 * with the server so neither side can quietly stop at `opencode` — which is how
 * hermes/kimi/glm conversations went missing (B-598).
 */
export interface Project extends Partial<SessionBuckets<ProjectSession>> {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  /** null/undefined = لم يُفحص بعد؛ لا يجوز عرضه كأن المجلد مفقود. */
  dirExists?: boolean | null;
  /** وقت آخر فحص موثوق لبيانات المشروع؛ null/undefined = لم تجهز اللقطة بعد. */
  metadataCheckedAt?: string | null;
  isStarred?: boolean;
  // Server-relative URL of the project's custom logo (cache-busted), or null
  // when it has none (T-1403). Shared state, like the display name.
  logoUrl?: string | null;
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
  /** Server-authoritative access decision for this viewer. */
  canAccess?: boolean;
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
