import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';

import { JSDOM } from 'jsdom';

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
const dom = new JSDOM('', { url: 'https://wallet.example.test' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
  Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
let request: () => Promise<Response> = async () => Response.json({ outcomes: [] });
mock.module('../utils/api', { namedExports: { authenticatedFetch: () => request() } });
const { act, renderHook, cleanup } = await import('@testing-library/react');
const outcomes = await import('./sessionCompletionStore');
const workflows = await import('./workflowStatusStore');
const provider = await import('./selectedProviderStore');
const processes = await import('./sessionProcessStateStore');

afterEach(() => { cleanup(); window.dispatchEvent(new Event('auth:identity-changing')); });
after(() => {
  dom.window.close();
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const action of ['refresh', 'markUnread']) {
  test(`late A outcome ${action} body cannot overwrite B after the identity event`, async () => {
    let release!: (value: unknown) => void;
    const body = new Promise((resolve) => { release = resolve; });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    request = async () => ({ ok: true, status: 200, json: () => { reading(); return body; } }) as Response;
    const view = renderHook(() => outcomes.useSessionOutcome('session'));
    let stale!: Promise<boolean>;
    await act(async () => {
      outcomes.applyOutcomeSnapshot([{ sessionId: 'session', outcome: 'done' }]);
      stale = action === 'refresh' ? outcomes.refreshOutcomes() : outcomes.markOutcomeUnread('session');
      await started;
    });
    act(() => {
      window.dispatchEvent(new Event('auth:identity-changing'));
      outcomes.applyOutcomeSnapshot([{ sessionId: 'session', outcome: 'question' }]);
    });
    await act(async () => {
      release(action === 'refresh' ? { outcomes: [{ sessionId: 'session', outcome: 'error' }] } : { outcome: 'error' });
      await stale;
    });
    assert.equal(view.result.current, 'question');
  });
}

test('workflow snapshots stamped before an identity event cannot refill the new account', () => {
  const oldGeneration = workflows.getWorkflowStatusGeneration();
  const view = renderHook(() => workflows.useWorkflowsEnvelope());
  act(() => {
    window.dispatchEvent(new Event('auth:identity-changing'));
    workflows.setActiveWorkflows({ workflows: [], eligible: 2, scanned: 2, capped: false, dormant: 0 });
    workflows.setActiveWorkflows({ workflows: [], eligible: 99, scanned: 99, capped: false, dormant: 0 }, oldGeneration);
  });
  assert.equal(view.result.current.eligible, 2);
});

test('provider model and engine reset reaches mounted consumers on the identity event', () => {
  const view = renderHook(() => ({
    provider: provider.useSelectedProvider(), engine: provider.useSelectedEngineProvider(),
    model: provider.useSelectedActiveModel(),
  }));
  act(() => {
    provider.setSelectedProvider('codex');
    provider.setSelectedEngineProvider('account-a-engine');
    provider.setSelectedActiveModel('account-a-model');
  });
  act(() => window.dispatchEvent(new Event('auth:identity-changing')));
  assert.deepEqual(view.result.current, { provider: 'claude', engine: null, model: null });
  act(() => provider.setSelectedActiveModel('account-b-model'));
  assert.equal(view.result.current.model, 'account-b-model');
});

test('old socket process epoch cannot repopulate process state after identity reset', () => {
  const oldEpoch = processes.beginSessionProcessConnectionEpoch();
  processes.setSessionProcessState('A', 'running', { epoch: oldEpoch });
  window.dispatchEvent(new Event('auth:identity-changing'));
  const newEpoch = processes.beginSessionProcessConnectionEpoch();
  processes.setSessionProcessState('B', 'running', { epoch: newEpoch });
  processes.setSessionProcessState('A', 'running', { epoch: oldEpoch });
  assert.equal(processes.getSessionProcessState('A'), null);
  assert.equal(processes.getSessionProcessState('B'), 'running');
});
