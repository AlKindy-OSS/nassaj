import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const events: string[] = [];
mock.module('./runtime-user-effect.js', {
  namedExports: {
    authorizeRuntimeUserProviderEffect: (input: { authenticatedPrincipal: { id: number }; purpose: string }) => {
      events.push(`authorize:${input.authenticatedPrincipal.id}:${input.purpose}`);
      return {
        decisionId: 'decision-catalog',
        leaseId: 'lease-catalog',
        mode: 'legacy',
        consume: () => { events.push('consume'); return {} as never; },
        markStarted: () => { events.push('started'); },
        settle: (outcome: string) => { events.push(`settle:${outcome}`); },
        notStarted: () => { events.push('not-started'); },
      };
    },
  },
});

const { runAuthorizedProviderCatalog } = await import('./runtime-catalog.js');

test('catalog rejects a missing actor before invoking the provider probe', async () => {
  let invoked = false;
  await assert.rejects(
    runAuthorizedProviderCatalog('claude', null, null, async () => {
      invoked = true;
      return ['unreachable'];
    }),
    /CATALOG_ACTOR_REQUIRED/,
  );
  assert.equal(invoked, false);
});

test('catalog uses a dedicated one-shot permission lifecycle', async () => {
  events.length = 0;
  const result = await runAuthorizedProviderCatalog('codex', '7', {
    id: 7, role: 'user', authenticationKind: 'session', authorizationGeneration: 1,
  }, async () => {
    events.push('probe');
    return ['model-a'];
  });
  assert.deepEqual(result, ['model-a']);
  assert.deepEqual(events, [
    'authorize:7:catalog',
    'consume',
    'probe',
    'started',
    'settle:succeeded',
  ]);
});

test('catalog rejects a credential user that differs from the authenticated actor', async () => {
  await assert.rejects(
    runAuthorizedProviderCatalog('codex', '8', {
      id: 7, role: 'user', authenticationKind: 'session', authorizationGeneration: 1,
    }, async () => ['unreachable']),
    /CATALOG_ACTOR_USER_MISMATCH/,
  );
});
