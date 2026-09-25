/** Execute the actual history route callback and local parsers without importing unrelated SDK/auth routes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test from 'node:test';

import ts from 'typescript';
import express from 'express';

import { HistoryHttpSink } from '../services/history-response.service.js';

const root = path.resolve(import.meta.dirname, '../../../../');
function parsed(relative: string) {
  const file = path.join(root, relative);
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declaration(source: ts.SourceFile, name: string): string {
  const found = source.statements.find(statement => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(item => item.name.getText(source) === name);
    return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name;
  });
  assert.ok(found, `actual source declaration ${name} exists`);
  return found.getText(source).replace(/^export\s+/, '');
}
function actualHandler(service: Record<string, unknown>) {
  const route = parsed('server/modules/providers/provider.routes.ts'); let handler: ts.Node | undefined;
  for (const statement of route.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(route) !== 'router.get' || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== '/sessions/:sessionId/messages') continue;
    assert.ok(ts.isCallExpression(call.arguments[1])); handler = call.arguments[1].arguments[0];
  }
  assert.ok(handler, 'actual history route callback is extracted, never reimplemented');
  const source = [declaration(parsed('server/shared/utils.ts'), 'AppError'),
    declaration(parsed('server/modules/projects/services/project-visibility-guard.service.ts'), 'coerceUserId'),
    ...[
      'readPathParam', 'SESSION_ID_PATTERN', 'parseSessionId', 'readOptionalQueryString', 'readRequesterUserId',
      'readErrorStatus', 'readErrorCode', 'serveSessionMessages',
      'accessFenceError', 'captureSessionRequestFence', 'assertSessionRequestFence',
    ].map(name => declaration(route, name)),
    `globalThis.historyHandler = (${handler.getText(route)});`].join('\n');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  // The request fence (ecfdc7db5) is extracted as-is; only its DB boundary is synthetic:
  // an accessible session under the default-off membership flag, as in production.
  const context = vm.createContext({
    sessionsService: service, HistoryHttpSink, AbortController, AbortSignal, Buffer, console,
    assertSessionAccessible: () => ({ project_path: null }), isProjectMembershipEnforced: () => false,
  });
  vm.runInContext(code, context);
  return context.historyHandler as (req: express.Request, res: express.Response) => Promise<void>;
}

async function routeCall(query: string, service: Record<string, unknown>, allowLegacy = false) {
  const handler = actualHandler({ usesBoundedHistory: () => true, ...service }), app = express(), sockets = new Set<Socket>();
  app.use((req, res, next) => { (req as any).user = { id: 7 }; (req as any).assertCurrentIdentity = () => true; if (!allowLegacy) res.json = (() => { throw new Error('history escaped to unleased res.json'); }) as typeof res.json; next(); });
  app.get('/sessions/:sessionId/messages', (req, res, next) => { void handler(req, res).catch(next); });
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.statusCode = error.statusCode ?? 500; res.end(JSON.stringify({ error: { code: error.code ?? 'TEST_ROUTE_FAILURE' } }));
  });
  const server = http.createServer(app);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/sessions/synthetic-session/messages${query}`, agent: false }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) })); response.once('error', reject);
      });
      request.once('error', reject); request.setTimeout(2000, () => request.destroy(new Error('route test timeout')));
    });
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

for (const query of ['?payload=small', '?limit=501', '?limit=1junk', '?offset=-1', '?cursor=' + 'x'.repeat(2049)]) {
  test(`memory actual history route validates ${query.length > 100 ? 'oversized cursor' : query} before lease/provider access`, async () => {
    let calls = 0;
    const result = await routeCall(query, { withHistoryLease: async () => { calls++; }, fetchHistory: async () => { calls++; } });
    assert.equal(result.status, 400); assert.equal(result.body.error.code, 'INVALID_QUERY_PARAMETER'); assert.equal(calls, 0);
  });
}

test('memory actual history route transfers query and requester to a concrete owned transport', async () => {
  let calls = 0;
  const expected = { messages: [{ id: 'owned', content: 'العربية 🧵' }], total: 1 };
  const result = await routeCall('?limit=1&offset=2&payload=full', {
    fetchHistory: async () => { throw new Error('legacy unleased history read'); },
    async withHistoryLease(sessionId: string, userId: number, options: any, sink: HistoryHttpSink) {
      calls++; assert.equal(sessionId, 'synthetic-session'); assert.equal(userId, 7);
      assert.equal(options.limit, 1); assert.equal(options.offset, 2); assert.equal(options.payloadMode, 'full');
      assert.ok(HistoryHttpSink.isConcrete(sink));
      await sink.write(Buffer.from(JSON.stringify(expected)), new AbortController().signal); await sink.complete();
    },
  });
  assert.equal(calls, 1); assert.equal(result.status, 200); assert.deepEqual(result.body, expected);
});


test('memory actual history route preserves the existing response path for other providers', async () => {
  let legacyCalls = 0;
  const expected = { messages: [{ id: 'synthetic-other-provider', content: 'compatible' }], total: 1 };
  const result = await routeCall('?limit=1', {
    usesBoundedHistory: () => false,
    async fetchHistory() { legacyCalls++; return expected; },
    async withHistoryLease() { throw new Error('unrelated provider entered native containment'); },
  }, true);
  assert.equal(legacyCalls, 1); assert.equal(result.status, 200); assert.deepEqual(result.body, expected);
});
