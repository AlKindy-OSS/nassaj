/**
 * ADR-218 (T-2070) — the card merges the server's agents registry with the
 * transcript rows: agents of earlier turns show, the registry decides liveness,
 * and a reconstructed state is marked «حالة تقديرية».
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import arChat from '../../../../i18n/locales/ar/chat.json';

function lookup(tree: unknown, key: string): string | undefined {
  const found = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof found === 'string' ? found : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => lookup(arChat, key) ?? opts?.defaultValue ?? key,
    i18n: { language: 'ar' },
  }),
}));

import type { RunAgent } from '../../hooks/useRunProgress';
import type { SessionAgentRow } from '../../hooks/useSessionAgents';
import { mergeSessionAgents, RECENTLY_ENDED_MS } from '../../hooks/mergeSessionAgents';

import AgentStatusCard from './AgentStatusCard';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const NOW = Date.now();

function registryRow(over: Partial<SessionAgentRow> = {}): SessionAgentRow {
  return {
    key: 'agent-1', sessionId: 's1', source: 'claude-subagent', agentId: 'agent-1',
    toolUseIds: ['toolu_1'], label: 'مراجعة الخادم', agentType: 'qa-critic', background: true,
    state: 'running', startedAt: NOW - 60_000, lastEventAt: NOW - 1_000, accuracy: 'live', ...over,
  };
}

const streamRow: RunAgent = {
  id: 'toolu_1', type: 'qa-critic', description: 'مراجعة الخادم', status: 'running',
  currentTool: 'Read', callCount: 3, startedAt: NOW - 60_000,
};

function renderCard(agents: RunAgent[], sessionAgents?: SessionAgentRow[], workflowAgents?: RunAgent[]) {
  return render(
    <AgentStatusCard
      agents={agents}
      sessionAgents={sessionAgents}
      workflowAgents={workflowAgents}
      status={null}
      isLoading={false}
      provider="claude"
      runStartedAt={null}
      progress={null}
    />,
  );
}

describe('AgentStatusCard + سجلّ وكلاء الجلسة (ADR-218)', () => {
  it('يعرض وكيل خلفية من السجلّ وحده حين لا صفوف بثّ', () => {
    const { container } = renderCard([], [registryRow()]);
    expect(container.textContent).toContain('qa-critic');
    expect(container.textContent).toContain(arChat.agentActivity.backgroundAgents);
  });

  it('بلا سجلّ (supported:false → صفر صفوف) لا يتغيّر شيء', () => {
    const { container } = renderCard([], []);
    expect(container.textContent).not.toContain('qa-critic');
    expect(screen.queryByTestId('agent-estimated-badge')).toBeNull();
  });

  it('يعلّم الحالة المُعادة البناء أو المجهولة بشارة «حالة تقديرية»', () => {
    renderCard([], [
      registryRow({ accuracy: 'reconstructed' }),
      registryRow({ key: 'agent-2', agentId: 'agent-2', toolUseIds: ['toolu_2'], state: 'unknown', endedAt: NOW }),
    ]);
    const badges = screen.getAllByTestId('agent-estimated-badge');
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toBe('حالة تقديرية');
  });
});

describe('mergeSessionAgents', () => {
  it('يدمج صفّ البثّ وصفّ السجلّ لنفس الوكيل في صفّ واحد بتفاصيل البثّ', () => {
    const merged = mergeSessionAgents([streamRow], [], [registryRow()], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'toolu_1', status: 'running', currentTool: 'Read', callCount: 3 });
  });

  it('يطابق بمعرّف الوكيل حين يغيب معرّف الأداة', () => {
    const merged = mergeSessionAgents([{ ...streamRow, id: 'agent-1' }], [], [registryRow({ toolUseIds: [] })], NOW);
    expect(merged).toHaveLength(1);
  });

  it('حالة السجلّ «done» تغلب «running» البائتة من البثّ', () => {
    const merged = mergeSessionAgents([streamRow], [], [registryRow({ state: 'done', endedAt: NOW })], NOW);
    expect(merged[0]).toMatchObject({ status: 'done', outcome: 'completed', currentTool: undefined });
  });

  it('يُخفي صفّ السجلّ المنتهي منذ زمن ويُبقي الحديث', () => {
    const old = registryRow({ key: 'old', agentId: 'old', toolUseIds: [], state: 'done', endedAt: NOW - RECENTLY_ENDED_MS - 1 });
    const fresh = registryRow({ key: 'fresh', agentId: 'fresh', toolUseIds: [], state: 'failed', endedAt: NOW - 1_000 });
    const merged = mergeSessionAgents([], [], [old, fresh], NOW);
    expect(merged.map((a) => a.id)).toEqual(['fresh']);
    expect(merged[0]).toMatchObject({ status: 'done', outcome: 'failed' });
  });

  it('لا يكرّر صفّ ورشة يعرضه /workflows/active', () => {
    const wf: RunAgent = { id: 'wf_9:a1', type: '', description: 'x', status: 'running', callCount: 0, startedAt: NOW };
    const merged = mergeSessionAgents([], [wf], [
      registryRow({ key: 'wf:wf_9:a1', source: 'workflow', agentId: 'a1', toolUseIds: [], accuracy: 'reconstructed' }),
    ], NOW);
    expect(merged.map((a) => a.id)).toEqual(['wf_9:a1']);
  });
});
