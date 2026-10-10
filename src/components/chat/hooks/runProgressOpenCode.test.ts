/**
 * ADR-199 Addendum B (Decisions 16–18) on the client: OpenCode's plan is live
 * and its sub-agents are `turn` (shown only once settled). Rows are what the
 * server's OpenCode adapter emits live for the scrubbed real capture
 * (__fixtures__/opencode-progress-live.real.json, see its `_provenance`).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { describe, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { getProviderCapabilities } from '../constants/providerCapabilities';

import capture from './__fixtures__/opencode-progress-live.real.json';
import { resolveOverallPercent } from './declaredProgress';
import { normalizedToChatMessages } from './useChatMessages';
import {
  computeRunProgress,
  gateComputedProgress,
  gateTurnSubagents,
  useRunProgress,
  type RunProgress,
} from './useRunProgress';

const ROWS = capture.rows as unknown as NormalizedMessage[];
const CAPABILITY = getProviderCapabilities('opencode').progress;
const OPTIONS = { keepPlanAfterStop: CAPABILITY.plan === 'turn', statusSubagents: CAPABILITY.subagents === 'turn' };

/** The chain ChatInterface runs, over the first `count` rows of the live stream. */
function liveProgress(count = ROWS.length): RunProgress {
  const chat = normalizedToChatMessages(ROWS.slice(0, count));
  const scanned = renderHook(() => useRunProgress(chat, true, OPTIONS)).result.current;
  return gateTurnSubagents(gateComputedProgress(scanned, CAPABILITY.plan), CAPABILITY.subagents);
}

const firstIndex = (predicate: (m: NormalizedMessage) => boolean) => ROWS.findIndex(predicate) + 1;

describe('OpenCode live progress (real capture)', () => {
  it('declares plan live and subagents turn', () => {
    assert.deepEqual(CAPABILITY, { plan: 'live', subagents: 'turn' });
  });

  it('shows the plan as soon as the first todowrite settles: 0 of 2, one in progress', () => {
    const progress = liveProgress(firstIndex((m) => Boolean(m.plan)));
    assert.deepEqual([progress.done, progress.inProgress, progress.total], [0, 1, 2]);
    assert.equal(progress.agents.length, 0);
  });

  it('the latest snapshot wins: 2 of 2 → 100%', () => {
    const progress = liveProgress();
    assert.deepEqual([progress.done, progress.total], [2, 2]);
    assert.deepEqual(resolveOverallPercent(progress), { percent: 100, source: 'tasks' });
  });

  it('the settled delegation appears finished, with no active agent', () => {
    const progress = liveProgress();
    assert.equal(progress.subagentsWhenFinished, true);
    assert.equal(progress.activeSubagent, null);
    assert.deepEqual(progress.agents.map((a) => [a.description, a.status]), [['Read a.txt content', 'done']]);
    assert.deepEqual([progress.agentsDone, progress.agentsTotal], [1, 1]);
  });
});

describe('gateTurnSubagents', () => {
  const running: RunProgress = {
    done: 0,
    total: 0,
    inProgress: 0,
    agentsTotal: 2,
    agentsDone: 1,
    activeSubagent: { callCount: 0 },
    agents: [
      { id: 'a', type: '', description: 'finished', status: 'done', callCount: 0, startedAt: 1 },
      { id: 'b', type: '', description: 'still going', status: 'running', callCount: 0, startedAt: 2 },
    ],
    declaredPercent: null,
  };

  it('turn: drops running rows, the active chip and the running count', () => {
    const gated = gateTurnSubagents(running, 'turn');
    assert.deepEqual(gated.agents.map((a) => a.id), ['a']);
    assert.equal(gated.activeSubagent, null);
    assert.deepEqual([gated.agentsDone, gated.agentsTotal], [1, 1]);
    assert.equal(gated.subagentsWhenFinished, true);
  });

  it('turn: drops stale rows too, so the counter matches the rows shown', () => {
    const withStale: RunProgress = {
      ...running,
      agentsTotal: 3,
      agents: [
        ...running.agents,
        { id: 'c', type: '', description: 'went silent', status: 'stale', callCount: 0, startedAt: 3 },
      ],
    };
    const gated = gateTurnSubagents(withStale, 'turn');
    assert.deepEqual(gated.agents.map((a) => a.id), ['a']);
    assert.equal(gated.agentsTotal, gated.agents.length);
    assert.equal(gated.agentsDone, gated.agents.length);
  });

  it.each(['live', 'history', 'none'])('%s: passes the snapshot through unchanged', (timing) => {
    assert.equal(gateTurnSubagents(running, timing), running);
  });
});

describe('computeRunProgress', () => {
  it('equals the hook result', () => {
    const chat = normalizedToChatMessages(ROWS);
    const fromHook = renderHook(() => useRunProgress(chat, true, OPTIONS)).result.current;
    assert.deepEqual(computeRunProgress(chat, true, OPTIONS), fromHook);
  });
});
