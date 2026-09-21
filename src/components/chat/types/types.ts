import type { Project, ProjectSession, LLMProvider } from '../../../types/app';

export type Provider = LLMProvider;

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

export interface ChatImage {
  data: string;
  name: string;
}

export interface ChatFile {
  name: string;
  path: string;
  relPath?: string;
  size?: number;
  mimeType?: string;
}

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface SubagentChildTool {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  timestamp: Date;
}

export interface ChatMessage {
  /** Untranslated server classification; rendered only through the safe formatter. */
  serverError?: { code?: unknown; error?: unknown };
  type: string;
  /**
   * The immutable UUID of this row in the provider transcript. Unlike a UI
   * message key, this is safe to send back to the server to pin a fork.
   */
  transcriptMessageId?: string;
  content?: string;
  displayText?: string;
  /**
   * Authenticated author (users.id) of a user message — same id as the
   * participants API. Absent = author unknown; renderers must fall back to a
   * neutral avatar, never the viewing user's.
   */
  userId?: number;
  /**
   * Coordinator attribution for an `assistant` message (server commit 9c61b60):
   * the users.id of the participant who launched the run that produced this
   * reply — same id space as the participants API. Stamped live and on
   * reloaded history. `null`/absent = unknown coordinator (legacy rows); the
   * renderer falls back to the session owner. User messages never carry it
   * (they use `userId`).
   */
  coordinatorId?: number | null;
  /**
   * Machine origin discriminator for a `type:'user'` message (server commit
   * 91b8b39). Absent = genuine human input (userId present).
   * Present = programmatic / machine-authored row with no userId:
   *   'coordinator' — coordinator prompting a sub-agent (Task/Agent tool).
   *   'peer'        — inter-agent peer message.
   *   'channel'     — broadcast channel injection.
   *   'task-notification' — automated task status update.
   * Rule: type:'user' + originKind present ⇒ machine-authored; absent ⇒ human.
   */
  originKind?: 'coordinator' | 'peer' | 'channel' | 'task-notification' | string;
  /**
   * The model that produced this assistant message, verbatim from the provider
   * (B-352). Present on assistant rows whenever any harness names the model,
   * live and on history alike; absent on user rows and on providers that expose
   * no per-turn model. Absent means "unknown", never "the session's
   * model": one conversation can hold turns from several models.
   */
  model?: string;
  /** Coordination level sealed to this user turn at send time. */
  coordinationLevel?: 'direct' | 'delegate' | 'delegate_review';
  timestamp: string | number | Date;
  /** Persisted server metric attached only to the durable final reply. */
  responseTurnMetric?: {
    /** Canonical duration; the client must not derive it from timestamps. */
    durationMs: number;
    startedAt: string;
    completedAt: string;
  };
  /** Exact user message that started this live run; absent on unlinked history. */
  responseToMessageId?: string;
  /** Duration from first model activity through final assistant completion. */
  turnDurationMs?: number;
  /** Prevents latency matching across session branches. */
  sessionId?: string;
  images?: ChatImage[];
  /** Images deliberately omitted by history safety limits. */
  imagesOmitted?: number;
  deferredPayload?: { schema?: number; revision?: string; fields: string[] };
  files?: ChatFile[];
  reasoning?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isInteractivePrompt?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  isSubagentContainer?: boolean;
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
  };
  /** Task notification fields (B-94). */
  isTaskNotification?: boolean;
  taskStatus?: string;
  /**
   * Workflow id extracted from the task-id field of a task notification, or
   * from a task_reconcile synthetic row. Used to match a reconcile card to its
   * paired stopped card so the UI can replace it in-place.
   */
  wfId?: string;
  /** True only on task_reconcile-derived cards; never on original notifications. */
  isReconcile?: boolean;
  [key: string]: unknown;
}

export interface ClaudeSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface ClaudePermissionSuggestion {
  toolName: string;
  entry: string;
  isAllowed: boolean;
}

export interface PermissionGrantResult {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export type SessionNavigationOptions = {
  replace?: boolean;
};

export interface ChatInterfaceProps {
  /** Header portal keeps conversation metrics owned by the mounted chat. */
  sessionHeaderTarget?: HTMLElement | null;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => { ok: boolean; reason?: string } | void;
  latestMessage: any;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  processingSessions?: Set<string>;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onShowSettings?: () => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  showToolCalls?: boolean;
  autoScrollToBottom?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  /** يُستدعى من تنبيه خمول الجلسة (ساعة بلا رسائل) ليبدأ محادثة جديدة. */
  onNewSession?: () => void;
  /** Immediately mirror a close/reopen into the app's selected-session state. */
  onSelectedSessionClosedChange?: (sessionId: string, closed: boolean) => void;
}
