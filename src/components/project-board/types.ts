/**
 * Project Board types — mirror of docs/project-state.json (schema v1 + 1.1
 * additions: `sprints` array and tasks[].sprint/kind/issue + 1.2 optional
 * sections: `schedule`/`deliverables` (waterfall) and `objectives`/`kpis`
 * (execution plan). Schema 1.3 adds the optional `visual_checks` section
 * (read-only owner visual checklist). All 1.1/1.2/1.3 fields are optional so
 * v1 files keep rendering unchanged.
 * Spec: ~/.claude/wiki/project-board.md
 */

export type PhaseStatus = 'pending' | 'current' | 'done' | 'cancelled';
export type SprintStatus = 'planned' | 'current' | 'done';
export type TaskStatus = 'open' | 'in_progress' | 'done';
export type TaskKind = 'feature' | 'bug' | 'chore' | 'spike';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IssueStatus = 'open' | 'fixed' | 'wontfix';
export type DeliverableStatus = 'pending' | 'in_progress' | 'delivered' | 'accepted' | 'rejected';
export type ObjectiveStatus = 'on_track' | 'at_risk' | 'off_track' | 'done';
export type KpiDirection = 'up' | 'down';
export type VisualCheckStatus = 'pending' | 'verified' | 'failed';

export type BoardPhase = {
  id: string;
  title: string;
  status: PhaseStatus;
  progress: number;
};

export type BoardSprint = {
  id: string;
  phase: string;
  goal: string;
  status: SprintStatus;
  started?: string | null;
  ended?: string | null;
};

export type BoardTask = {
  id: string;
  phase: string;
  /** Sprint id, or null/absent for backlog tasks (schema 1.1). */
  sprint?: string | null;
  /** Task kind badge (schema 1.1). */
  kind?: TaskKind;
  /** Linked issue id (e.g. "B-3") for kind="bug" tasks (schema 1.1). */
  issue?: string | null;
  title: string;
  status: TaskStatus;
  owner?: string;
  closed?: string | null;
};

export type BoardIssue = {
  id: string;
  title: string;
  severity: IssueSeverity;
  status: IssueStatus;
  fix?: string | null;
  found?: string;
};

export type BoardDecision = {
  id: string;
  title: string;
  link?: string;
};

/** Waterfall contractual deliverable (schema 1.2). */
export type BoardDeliverable = {
  id: string;
  phase?: string;
  title: string;
  /** Due date (YYYY-MM-DD) or null when not committed yet. */
  due?: string | null;
  status: DeliverableStatus;
  /** Measurable acceptance criterion. */
  acceptance?: string;
  owner?: string;
};

/** Waterfall Gantt/CPM schedule item (schema 1.2). */
export type BoardScheduleItem = {
  id: string;
  phase?: string;
  title: string;
  /** Planned start date (YYYY-MM-DD). */
  start?: string;
  /** Planned end date (YYYY-MM-DD). */
  end?: string;
  /** Ids of schedule items this one depends on (CPM edges). */
  depends?: string[];
  /** 0–100 completion of the item. */
  progress?: number;
  owner?: string;
  /** Milestones render as diamonds (zero duration). */
  milestone?: boolean;
  /** Linked deliverable id (e.g. "D-1") or null. */
  deliverable?: string | null;
};

/** OKR key result (schema 1.2). */
export type BoardKeyResult = {
  id: string;
  title: string;
  unit?: string;
  baseline?: number;
  target?: number;
  current?: number;
  /** Date the `current` value was last reviewed (YYYY-MM-DD). */
  updated?: string;
};

/** OKR objective card (schema 1.2). */
export type BoardObjective = {
  id: string;
  /** Time horizon, e.g. "2026-Q3". */
  horizon?: string;
  title: string;
  owner?: string;
  status: ObjectiveStatus;
  keyResults?: BoardKeyResult[];
};

/** Standalone KPI card (schema 1.2). */
export type BoardKpi = {
  id: string;
  name: string;
  unit?: string;
  target?: number;
  current?: number;
  /** Which way is "good": up → current below target is negative, down → the opposite. */
  direction?: KpiDirection;
  updated?: string;
  /** Linked objective/phase id (e.g. "O-1", "P1") or null. */
  linked?: string | null;
};

/**
 * Read-only visual-verification item (schema 1.3) — one row of the owner's
 * "visual checklist": a step + what the owner should see, linked back to the
 * task/sprint/issue that created it. Authored by an agent into
 * docs/project-state.json; the board only renders it.
 */
export type BoardVisualCheck = {
  id: string;
  /** Phase id this check belongs to (group key). */
  phase: string;
  /** Originating task id (e.g. "GATE-x"/"WI-x") or null. */
  task?: string | null;
  /** Linked issue id (e.g. "R-*"/"I-*") or null. */
  issue?: string | null;
  /** Originating sprint id or null. */
  sprint?: string | null;
  /** The step/route the owner performs. */
  step: string;
  /** What the owner should see for this step to pass. */
  expect: string;
  /** "Broken if…" hint shown as secondary amber text, or null. */
  warning?: string | null;
  status: VisualCheckStatus;
  /** Owner's note after verification, or null. */
  result?: string | null;
  created?: string;
  verified?: string | null;
};

export type ProjectBoardState = {
  $version: number;
  project: string;
  updated: string;
  phases: BoardPhase[];
  /** Schema 1.1 — absent in v1 files. */
  sprints?: BoardSprint[];
  tasks: BoardTask[];
  issues: BoardIssue[];
  decisions: BoardDecision[];
  /** Schema 1.2 waterfall sections — non-empty `schedule` shows the timeline tab. */
  schedule?: BoardScheduleItem[];
  deliverables?: BoardDeliverable[];
  /** Schema 1.2 execution-plan sections — non-empty shows the objectives tab. */
  objectives?: BoardObjective[];
  kpis?: BoardKpi[];
  /** Schema 1.3 read-only visual-checklist section — non-empty shows the tab. */
  visual_checks?: BoardVisualCheck[];
};

export type ProjectBoardResponse = {
  projectId: string;
  available: boolean;
  state: ProjectBoardState | null;
  stateError: boolean;
  architecture: {
    technical: string | null;
    simplified: string | null;
  };
};
