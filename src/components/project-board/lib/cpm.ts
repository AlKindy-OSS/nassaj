/**
 * Critical Path Method (CPM) over the waterfall `schedule` section of
 * docs/project-state.json — pure date/graph math, no React.
 * Spec: ~/.claude/wiki/project-board.md («شلال»).
 *
 * Algorithm (durations in days, derived from start/end dates):
 *   1. Drop dependency references to unknown items (flag `missingDeps`).
 *   2. Kahn topological sort — an unresolved remainder means a dependency
 *      cycle: CPM is skipped entirely and `cycle` is flagged (no crash).
 *   3. Forward pass: ES = max(planned start offset, max EF of dependencies),
 *      EF = ES + duration. The planned start anchors items so the critical
 *      path reflects the dates actually committed in the plan.
 *   4. Backward pass from the project end: LF = min LS of successors,
 *      LS = LF − duration. Zero slack (LS − ES) ⇒ on the critical path.
 */

import type { BoardScheduleItem } from '../types';

export type CpmWarning = 'cycle' | 'missingDeps';

export type CpmResult = {
  /** Ids of schedule items on the critical path (empty when CPM was skipped). */
  criticalIds: Set<string>;
  warnings: CpmWarning[];
};

export const DAY_MS = 86_400_000;

/** Parses a YYYY-MM-DD string into a UTC day index; null when missing/invalid. */
export function parseDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / DAY_MS);
}

/** Duration in days; milestones and invalid/missing dates count as zero. */
export function durationDays(item: BoardScheduleItem): number {
  if (item.milestone) return 0;
  const start = parseDay(item.start);
  const end = parseDay(item.end);
  if (start === null || end === null) return 0;
  return Math.max(0, end - start);
}

type CpmGraph = {
  byId: Map<string, BoardScheduleItem>;
  /** id → ids it depends on (unknown references already dropped). */
  deps: Map<string, string[]>;
  missingDeps: boolean;
};

function buildGraph(items: BoardScheduleItem[]): CpmGraph {
  const byId = new Map(items.filter((item) => item.id).map((item) => [item.id, item]));
  const deps = new Map<string, string[]>();
  let missingDeps = false;

  for (const item of byId.values()) {
    const valid = (item.depends ?? []).filter((dep) => {
      // Self-references survive so Kahn reports them as a cycle.
      if (byId.has(dep)) return true;
      missingDeps = true;
      return false;
    });
    deps.set(item.id, valid);
  }

  return { byId, deps, missingDeps };
}

/** Kahn topological order, or null when the dependency graph has a cycle. */
function topologicalOrder(graph: CpmGraph): string[] | null {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const [id, deps] of graph.deps) {
    inDegree.set(id, deps.length);
    for (const dep of deps) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), id]);
    }
  }

  const queue = [...inDegree.keys()].filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];

  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  return order.length === graph.byId.size ? order : null;
}

/**
 * Computes the critical path of the schedule. Cycles and unknown dependency
 * references never throw: they degrade to warnings (cycle additionally
 * disables the computation), so a malformed file cannot break the board.
 */
export function computeCriticalPath(items: BoardScheduleItem[]): CpmResult {
  const graph = buildGraph(items);
  const warnings: CpmWarning[] = graph.missingDeps ? ['missingDeps'] : [];

  const order = topologicalOrder(graph);
  if (order === null) {
    return { criticalIds: new Set(), warnings: [...warnings, 'cycle'] };
  }
  if (!order.length) {
    return { criticalIds: new Set(), warnings };
  }

  // Planned start offsets, normalized so the earliest item starts at day 0.
  const starts = [...graph.byId.values()]
    .map((item) => parseDay(item.start))
    .filter((day): day is number => day !== null);
  const baseDay = starts.length ? Math.min(...starts) : 0;

  // Forward pass.
  const earliestFinish = new Map<string, number>();
  const earliestStart = new Map<string, number>();
  for (const id of order) {
    const item = graph.byId.get(id) as BoardScheduleItem;
    const planned = parseDay(item.start);
    const depsFinish = (graph.deps.get(id) ?? []).map((dep) => earliestFinish.get(dep) ?? 0);
    const es = Math.max(planned === null ? 0 : planned - baseDay, ...depsFinish, 0);
    earliestStart.set(id, es);
    earliestFinish.set(id, es + durationDays(item));
  }
  const projectEnd = Math.max(...earliestFinish.values());

  // Backward pass (successor lists derive from the dependency map).
  const successors = new Map<string, string[]>();
  for (const [id, deps] of graph.deps) {
    for (const dep of deps) {
      successors.set(dep, [...(successors.get(dep) ?? []), id]);
    }
  }
  const latestStart = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const succStarts = (successors.get(id) ?? []).map((succ) => latestStart.get(succ) ?? projectEnd);
    const lf = succStarts.length ? Math.min(...succStarts) : projectEnd;
    latestStart.set(id, lf - durationDays(graph.byId.get(id) as BoardScheduleItem));
  }

  const criticalIds = new Set(
    order.filter((id) => (latestStart.get(id) ?? 0) - (earliestStart.get(id) ?? 0) <= 0),
  );
  return { criticalIds, warnings };
}
