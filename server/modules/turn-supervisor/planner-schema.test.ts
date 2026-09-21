import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePlannerPlan, parseReviewVerdict, PlannerSchemaError } from './planner-schema.js';

test('planner schema accepts only a non-empty allowlisted exact JSON plan', () => {
  const plan = parsePlannerPlan(JSON.stringify({
    version: 1,
    workers: [{ workerId: 'research', task: 'Find evidence' }],
    synthesisInstructions: 'Merge carefully',
  }), { allowedWorkerIds: new Set(['research']) });
  assert.equal(plan.workers[0].workerId, 'research');
  assert.throws(
    () => parsePlannerPlan('{"version":1,"workers":[],"synthesisInstructions":"x"}', {
      allowedWorkerIds: new Set(['research']),
    }),
    (error: unknown) => error instanceof PlannerSchemaError && error.code === 'MALFORMED_PLAN',
  );
  assert.throws(
    () => parsePlannerPlan(JSON.stringify({
      version: 1, workers: [{ workerId: 'shell', task: 'escape' }], synthesisInstructions: 'x',
    }), { allowedWorkerIds: new Set(['research']) }),
    (error: unknown) => error instanceof PlannerSchemaError && error.code === 'PLAN_NOT_ALLOWLISTED',
  );
  assert.throws(
    () => parsePlannerPlan('```json\n{}\n```', { allowedWorkerIds: new Set(['research']) }),
    (error: unknown) => error instanceof PlannerSchemaError && error.code === 'MALFORMED_PLAN',
  );
});

test('review verdict is structured and fenced to the current artifact hash', () => {
  assert.deepEqual(parseReviewVerdict(JSON.stringify({
    verdict: 'pass', artifactHash: 'current', feedback: '',
  }), 'current'), { verdict: 'pass', artifactHash: 'current', feedback: '' });
  assert.throws(
    () => parseReviewVerdict(JSON.stringify({
      verdict: 'pass', artifactHash: 'stale', feedback: '',
    }), 'current'),
    (error: unknown) => error instanceof PlannerSchemaError && error.code === 'MALFORMED_VERDICT',
  );
});
