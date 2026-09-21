import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const POLICY_TARGETS = [
  'connector-policy-v2', 'connector-certification-manifest', 'connector-runtime-fence',
  'connector-policy-v2-store', 'connector-policy-v2-adapters', 'connector-migration-v2',
  'connector-installation-readiness-v2', 'connector-jcs', 'connector-trust-bundle',
  'connector-global-certification-pack', 'connector-local-activation', 'connector-setup-store',
  'connector-installation-origin-resolver', 'connector-setup-doctor', 'connector-activation-gate',
  'connector-owner-setup.service', 'connector-owner-setup.routes',
] as const;
const POLICY_IMPORT_PATTERN = /connector-(?:policy-v2|certification-manifest|runtime-fence|migration-v2|installation-readiness-v2)/u;
const SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?)$/u;

const moduleSpecifiers = (source: string, filename: string): string[] => {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      found.push(node.arguments[0].text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

const candidateSourceFiles = (): string[] => {
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  return tracked.filter(filename => (
    SOURCE_EXTENSION_PATTERN.test(filename)
    && !filename.split('/').at(-1)?.includes('.test.')
    && !filename.split('/').includes('__tests__')
    && !['node_modules/', 'dist/', 'dist-server/', '.nassaj-release-candidates/', '.git/']
      .some(prefix => filename.startsWith(prefix))
    && POLICY_IMPORT_PATTERN.test(readFileSync(resolve(root, filename), 'utf8'))
  )).map(filename => resolve(root, filename));
};

const resolvesToPolicyTarget = (importer: string, specifier: string): boolean => {
  let normalized = specifier.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  if (normalized.startsWith('.')) normalized = resolve(dirname(importer), normalized);
  else if (normalized.startsWith('@/')) normalized = resolve(root, 'server', normalized.slice(2));
  else if (normalized.startsWith('server/')) normalized = resolve(root, normalized);
  return POLICY_TARGETS.some(target => normalized.endsWith(`/connectors/${target}`));
};

test('AST scanner detects aliases, reexports, dynamic imports, require, and double quotes', () => {
  const fixture = [
    'import x from "@/modules/connectors/connector-policy-v2.js";',
    'export * from "./connector-certification-manifest.js";',
    'const a = import("./connector-policy-v2.js");',
    'const b = require("./connector-policy-v2.js");',
    'const c = import(`./connector-policy-v2.js`);',
    'type T = import("./connector-policy-v2.js").ConnectorPolicySnapshot;',
  ].join('\n');
  assert.deepEqual(moduleSpecifiers(fixture, 'fixture.ts'), [
    '@/modules/connectors/connector-policy-v2.js', './connector-certification-manifest.js',
    './connector-policy-v2.js', './connector-policy-v2.js', './connector-policy-v2.js',
    './connector-policy-v2.js',
  ]);
});

test('repo-wide Policy V2 graph permits only the reviewed production cutover edges', () => {
  const violations: string[] = [];
  for (const importer of candidateSourceFiles()) {
    const importerName = relative(root, importer);
    if (POLICY_TARGETS.some(target => importerName.endsWith(`${target}.ts`))) {
      if (importerName !== 'server/modules/connectors/connector-certification-manifest.ts') continue;
    }
    for (const specifier of moduleSpecifiers(readFileSync(importer, 'utf8'), importer)) {
      if (!resolvesToPolicyTarget(importer, specifier)) continue;
      const allowedInternalEdge = importerName === 'server/modules/connectors/connector-certification-manifest.ts'
        && specifier.includes('connector-policy-v2');
      const allowedSubstrateLifecycle = importerName
          === 'server/modules/connectors/connector-substrate-only.production.ts'
        && ['connector-policy-v2-store', 'connector-runtime-fence',
          'connector-installation-readiness-v2', 'connector-setup-store',
          'connector-owner-setup'].some(target => specifier.includes(target));
      const allowedAuthorityLifecycle = importerName
          === 'server/modules/connectors/connector-runtime-authority-root.ts'
        && specifier.includes('connector-runtime-fence');
      const allowedSubstrateMigration = importerName
          === 'server/modules/database/connector-policy-v2.migration.ts'
        && ['connector-policy-v2-store', 'connector-migration-v2',
          'connector-installation-readiness-v2', 'connector-policy-v2',
          'connector-setup-store'].some(target => specifier.includes(target));
      const reviewedCutoverEdges: Readonly<Record<string, readonly string[]>> = {
        'server/modules/connectors/connector-user-grant.production.ts': ['connector-policy-v2'],
        'server/modules/connectors/connector-user-grant.routes.ts': ['connector-policy-v2'],
        'server/modules/connectors/connector-placement-composition.ts': ['connector-policy-v2'],
        'server/modules/connectors/connector-substrate-only.production.ts': [
          'connector-installation-origin-resolver', 'connector-activation-gate',
          'connector-global-certification-pack', 'connector-local-activation', 'connector-jcs',
          'connector-policy-v2', 'connector-trust-bundle',
        ],
        'server/modules/connectors/connector-auth-profile.routes.ts': ['connector-policy-v2'],
        'server/modules/connectors/connector-oauth-v2.routes.ts': ['connector-policy-v2'],
        'server/modules/connectors/connector-runtime-manifest.ts': ['connector-jcs', 'connector-policy-v2'],
      };
      const allowedCutoverEdge = reviewedCutoverEdges[importerName]?.some(target =>
        specifier.includes(target)) ?? false;
      if (!allowedInternalEdge && !allowedSubstrateLifecycle && !allowedAuthorityLifecycle
        && !allowedSubstrateMigration && !allowedCutoverEdge) {
        violations.push(`${importerName} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('new substrate has no environment or provider-I/O escape hatch', () => {
  for (const name of [
    'connector-policy-v2.ts', 'connector-certification-manifest.ts', 'connector-runtime-fence.ts',
    'connector-policy-v2-store.ts', 'connector-policy-v2-adapters.ts',
    'connector-migration-v2.ts', 'connector-installation-readiness-v2.ts',
    'connector-jcs.ts', 'connector-trust-bundle.ts', 'connector-global-certification-pack.ts',
    'connector-local-activation.ts', 'connector-setup-store.ts',
    'connector-installation-origin-resolver.ts', 'connector-setup-doctor.ts',
    'connector-activation-gate.ts', 'connector-owner-setup.service.ts',
    'connector-owner-setup.routes.ts',
  ]) {
    const source = readFileSync(join(here, name), 'utf8');
    assert.equal(source.includes('process.env'), false, name);
    assert.equal(/\bfetch\s*\(/u.test(source), false, name);
    assert.equal(source.includes('node:http'), false, name);
    assert.equal(source.includes('node:https'), false, name);
  }
});
