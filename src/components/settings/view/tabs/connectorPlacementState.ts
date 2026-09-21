import type {
  ConnectorPlacementAggregate,
  ConnectorTargetStatus,
} from '../../../../stores/connectorsStore';

export type ConnectorStateTone = 'success' | 'warning' | 'danger';

export type ConnectorStatePresentation = {
  key: string;
  tone: ConnectorStateTone;
};

/**
 * Presents the aggregate exactly as reported by the server.
 *
 * `healthy` alone is deliberately insufficient: only the server's explicit
 * `availableNextSession` truth may produce the green availability claim.
 */
export function placementPresentation(
  status: ConnectorPlacementAggregate,
  availableNextSession: boolean,
): ConnectorStatePresentation {
  if (status === 'healthy' && availableNextSession) {
    return { key: 'available', tone: 'success' };
  }

  const presentations: Record<ConnectorPlacementAggregate, ConnectorStatePresentation> = {
    not_configured: { key: 'notConfigured', tone: 'warning' },
    paused: { key: 'paused', tone: 'warning' },
    untracked: { key: 'untracked', tone: 'warning' },
    pending: { key: 'pending', tone: 'warning' },
    reconciling: { key: 'reconciling', tone: 'warning' },
    partial: { key: 'partial', tone: 'warning' },
    degraded: { key: 'degraded', tone: 'danger' },
    blocked: { key: 'blocked', tone: 'danger' },
    // Fail closed if two server fields ever disagree.
    healthy: { key: 'degraded', tone: 'danger' },
  };
  return presentations[status];
}

/** Public per-engine status; no client-side inference from generations/errors. */
export function targetPresentation(target: ConnectorTargetStatus): ConnectorStatePresentation {
  if (target.state === 'healthy' && target.healthy) {
    return { key: 'healthy', tone: 'success' };
  }
  if (target.state === 'blocked') return { key: 'blocked', tone: 'danger' };
  if (target.state === 'degraded') return { key: 'degraded', tone: 'danger' };
  if (target.state === 'applying' || target.state === 'removing') {
    return { key: 'working', tone: 'warning' };
  }
  if (target.state === 'untracked') return { key: 'untracked', tone: 'warning' };
  return { key: 'pending', tone: 'warning' };
}
