/**
 * ADR-199 P5 on the client: a provider that emits its plan once per turn puts
 * it on a text-less `status` row at turn end. Rows are what the server's agy
 * history path really emits (__fixtures__/agy-progress-history.real.json, see
 * its `_provenance`).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { describe, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { getProviderCapabilities } from '../constants/providerCapabilities';

import capture from './__fixtures__/agy-progress-history.real.json';
import { resolveOverallPercent } from './declaredProgress';
import { normalizedToChatMessages } from './useChatMessages';
import { gateComputedProgress, useRunProgress } from './useRunProgress';

const ROWS = capture.rows as unknown as NormalizedMessage[];
const PLAN_ROW = ROWS.find((m) => m.kind === 'status' && m.plan)!;

function progressOf(rows: NormalizedMessage[]) {
  const chat = normalizedToChatMessages(rows);
  return renderHook(() => useRunProgress(chat, true)).result.current;
}

describe('turn-end plan on a status row', () => {
  it('the fixture carries the plan on a status row with counts', () => {
    assert.ok(PLAN_ROW);
    assert.deepEqual(PLAN_ROW.plan?.counts, { done: 2, total: 5 });
  });

  it('is read under the turn capability: 2 done + 1 in progress of 5 → 50%', () => {
    const progress = gateComputedProgress(progressOf(ROWS), getProviderCapabilities('antigravity').progress.plan);
    assert.deepEqual([progress.done, progress.inProgress, progress.total], [2, 1, 5]);
    assert.deepEqual(resolveOverallPercent(progress), { percent: 50, source: 'tasks' });
  });

  it('renders no row for the status rows', () => {
    const chat = normalizedToChatMessages(ROWS);
    const statusIds = new Set<unknown>(ROWS.filter((m) => m.kind === 'status').map((m) => m.id));
    assert.equal(chat.some((m) => statusIds.has(m.id)), false);
    assert.equal(chat.length, normalizedToChatMessages(ROWS.filter((m) => m.kind !== 'status')).length);
  });

  it('a later snapshot in the same turn wins', () => {
    const later = { ...PLAN_ROW, id: 'later', plan: { ...PLAN_ROW.plan!, counts: { done: 5, total: 5 } } };
    assert.equal(progressOf([...ROWS, later]).done, 5);
  });

  it('a snapshot from a previous turn does not leak into the next', () => {
    const prompt = ROWS.find((m) => m.kind === 'text' && m.role === 'user')!;
    const next = { ...prompt, id: 'next-prompt', timestamp: '2026-09-27T23:00:00Z' };
    assert.equal(progressOf([...ROWS, next]).total, 0);
  });

  it('a status row straight after the prompt carries nothing', () => {
    const prompt = ROWS.find((m) => m.kind === 'text' && m.role === 'user')!;
    assert.equal(progressOf([prompt, PLAN_ROW]).total, 0);
  });
});
