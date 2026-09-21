import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import ts from 'typescript';

const SENSITIVE_SYMBOLS = new Set([
  'decryptConnectorVaultSecret',
  'getNamespacedSecret',
  'readActiveGrantMaterial',
  'readConnectorGrantMaterialSecret',
  'readConnectorGrantMaterialBundle',
  'createAuthorizedOAuthGrantMaterialReference',
]);

const ALLOWED_OWNERS = new Set([
  'server/modules/connectors/connector-auth-vault.crypto.ts',
  'server/modules/connectors/connector-oauth-engine.ts',
  'server/modules/connectors/connector-placement-composition.ts',
  'server/modules/connectors/connector-user-grant.production.ts',
  'server/modules/connectors/connector-user-grant.service.ts',
  'server/modules/database/repositories/connector-auth.db.ts',
  'server/modules/voice/voice-transcription.service.ts',
  'server/services/isolation/provider-secrets-store.js',
]);

const usesSensitiveSymbol = (path: string): boolean => {
  const source = ts.createSourceFile(
    path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
    path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && SENSITIVE_SYMBOLS.has(node.text)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const callArities = (path: string, functionName: string): number[] => {
  const source = ts.createSourceFile(
    path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const arities: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === functionName) arities.push(node.arguments.length);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return arities;
};

test('module ownership rejects new credential readers and launch-path bypasses', () => {
  const root = join(process.cwd(), 'server');
  const owners = globSync('**/*.{ts,js}', { cwd: root, exclude: ['**/*.test.*'] })
    .map(path => join(root, path))
    .filter(usesSensitiveSymbol)
    .map(path => relative(process.cwd(), path));
  assert.deepEqual(new Set(owners), ALLOWED_OWNERS);

  const placement = readFileSync(join(root, 'modules/connectors/connector-placement-composition.ts'), 'utf8');
  assert.match(placement, /resolveProductionConnectorGrantFanout/u);
  assert.match(placement, /readConnectorGrantMaterialSecret/u);
  const distribution = readFileSync(join(root, 'modules/connectors/connectors.service.ts'), 'utf8');
  assert.doesNotMatch(distribution, /getNamespacedSecret/u);
  assert.doesNotMatch(distribution, /process\.env\[connector\.keyEnvVar\]/u);
  assert.doesNotMatch(distribution, /NASSAJ_GRANT_FILE:/u);
  assert.doesNotMatch(distribution, /MCP_REMOTE_CONFIG_DIR:/u);
  assert.match(distribution, /withProductionConnectorGrantCapability/u);
  assert.match(distribution, /isAuthorizedConnectorGrantMaterialReference/u);
  assert.deepEqual(
    callArities(join(root, 'modules/connectors/connectors.service.ts'), 'buildConnectorMcpInput'),
    [4],
    'every in-module distribution build supplies credential bytes and the opaque capability',
  );
  const production = readFileSync(
    join(root, 'modules/connectors/connector-user-grant.production.ts'), 'utf8',
  );
  assert.match(production, /createAuthorizedOAuthGrantMaterialReference/u);
  assert.match(production, /reference\.provenance === 'm2'/u);
  const mcpLaunch = readFileSync(join(root, 'modules/providers/shared/mcp/mcp.provider.ts'), 'utf8');
  assert.match(mcpLaunch, /Connector MCP material is restricted to member user scope/u);
});
