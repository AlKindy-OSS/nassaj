/** Actual service cleanup boundary + real leases/admission; synthetic FS only, no shared VM seam or DB. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

import ts from 'typescript';

import { HistoryAdmission, HistoryReadLease, HistoryBudgetError, HISTORY_LIMITS } from './history-budget.service.js';
const sourcePath = path.join(import.meta.dirname, 'sessions.service.ts');
async function actualService(bindings: Record<string, unknown>) {
  const source = ts.createSourceFile(sourcePath, await fs.readFile(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let method: ts.MethodDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'withHistoryLeaseCallback') method = node;
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(method, 'extract actual callback body without rewriting its cleanup');
  const code = ts.transpileModule('globalThis.service = {' + method.getText(source) + '};', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const context = vm.createContext({ HistoryReadLease, HistoryBudgetError, HISTORY_LIMITS,
    AbortController, AbortSignal, setTimeout, clearTimeout, ...bindings });
  vm.runInContext(code, context); return context.service;
}
for (const scenario of ['read-413', 'consumer-413', 'consumer-undefined', 'consumer-null', 'logger-throws', 'cleanup-only', 'primary-only'] as const) {
  test(`actual service preserves primary error identity across cleanup failure: ${scenario}`, async () => {
    const root = await fs.mkdtemp(path.resolve('.memory-c1-cleanup-service-')), file = path.join(root, 'fixture.jsonl');
    const open = fs.open, admission = new HistoryAdmission(), diagnostics: unknown[][] = [];
    let restore: (() => void) | undefined, closeCalls = 0, primary: unknown;
    const cleanupFails = scenario !== 'primary-only', primaryFails = scenario !== 'cleanup-only';
    if (scenario === 'consumer-413' || scenario === 'primary-only') primary = new HistoryBudgetError('HISTORY_BUDGET_EXCEEDED');
    else if (scenario === 'consumer-null') primary = null;
    try {
      await fs.writeFile(file, '{"fixture":1}\n');
      const service = await actualService({ historyAdmission: admission,
        assertHistorySourceAccessible(session: string, user: number) { assert.equal(session, 'fixture'); assert.equal(user, 7); return { provider: 'codex', jsonl_path: file }; },
        console: { error(...args: unknown[]) { diagnostics.push(args); if (scenario === 'logger-throws') throw new Error('logging failed'); } },
      });
      service.fetchHistory = async (_session: string, _user: number, options: { historyLease: HistoryReadLease }) => {
        const lease = options.historyLease;
        if (scenario === 'read-413') {
          try { lease.charge('sourceBytes', HISTORY_LIMITS.sourceBytes + 1); } catch (error) { primary = error; throw error; }
        }
        for await (const line of lease.lines(file)) lease.parse(line);
        return { messages: [], total: 0 };
      };
      fs.open = async (...args: Parameters<typeof open>) => {
        assert.equal(args[0], file); const fd = await open(...args), close = fd.close.bind(fd);
        restore = () => { fd.close = close; };
        fd.close = async () => { closeCalls++; if (cleanupFails) throw new Error('private-path-and-stack-must-not-be-logged'); await close(); };
        return fd;
      };
      let rejected = false, caught: unknown;
      try {
        await service.withHistoryLeaseCallback('fixture', 7, {}, new AbortController().signal, () => {
          if (primaryFails) throw primary;
        });
      } catch (error) { rejected = true; caught = error; }
      fs.open = open; assert.equal(rejected, true);
      if (primaryFails) {
        assert.equal(caught, primary);
        if (primary instanceof HistoryBudgetError) { assert.equal(primary.code, 'HISTORY_BUDGET_EXCEEDED'); assert.equal(primary.statusCode, 413); }
      } else {
        assert.ok(caught instanceof HistoryBudgetError); assert.equal(caught.code, 'HISTORY_SOURCE_UNAVAILABLE'); assert.equal(caught.statusCode, 409);
      }
      assert.equal(closeCalls, 1);
      assert.equal(admission.active, cleanupFails ? 1 : 0); assert.equal(admission.quarantined, cleanupFails);
      if (cleanupFails) await assert.rejects(admission.acquire({ user: 'other', session: 'next', provider: 'codex' }, new AbortController().signal), { code: 'HISTORY_BUSY' });
      assert.equal(diagnostics.length, cleanupFails && primaryFails ? 1 : 0);
      if (diagnostics.length) {
        assert.deepEqual(JSON.parse(JSON.stringify(diagnostics[0])), ['History cleanup failed after primary failure', {
          event: 'history_cleanup_failed', quarantined: true,
        }]);
        assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) < 256);
      }
      restore?.(); await admission.retryCleanup(); assert.equal(admission.active, 0); assert.equal(admission.quarantined, false);
    } finally { fs.open = open; restore?.(); await admission.retryCleanup(); await fs.rm(root, { recursive: true, force: true }); }
  });
}
