import type { EngineRestampModelStoreTestDeps } from './engine-restamp-model-store.service.js';

const TEST_DEPS_KEY = Symbol.for('nassaj.engine-restamp-model-store.test-deps');

/** Installs bounded dependencies only for one named model-store fixture callback. */
export async function withEngineRestampModelStoreTestDeps<T>(
  deps: EngineRestampModelStoreTestDeps,
  callback: () => Promise<T>,
): Promise<T> {
  const globals = globalThis as Record<PropertyKey, unknown>;
  if (globals[TEST_DEPS_KEY] !== undefined) throw new Error('ENGINE_MODEL_TEST_DEPS_ALREADY_INSTALLED');
  globals[TEST_DEPS_KEY] = Object.freeze(deps);
  try { return await callback(); }
  finally { delete globals[TEST_DEPS_KEY]; }
}
