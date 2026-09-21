#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'server');
const INVENTORY = path.join(
  SERVER,
  'modules/execution-permissions/permission-launch-inventory.json',
);
const CLASSIFICATIONS = path.join(
  SERVER,
  'modules/execution-permissions/permission-launch-classifications.json',
);
const RUNTIME_REGISTRY = path.join(
  SERVER,
  'modules/execution-permissions/permission-runtime-launch-registry.json',
);

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const CHILD_MODULES = new Set(['child_process', 'node:child_process']);
const CHILD_EXPORTS = new Set([
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
]);
const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';
const HTTP_MODULES = new Set(['axios', 'undici', 'got', 'node:http', 'node:https', 'http', 'https']);
const HTTP_EXPORTS = new Set(['fetch', 'request', 'get']);
const PROVIDER_LAUNCHER_MODULE = /(?:^|\/)(?:claude-sdk|openai-codex|agy-cli|cursor-cli|gemini-cli|opencode-cli|qwen-cli|hermes-cli|kimi-agent-cli|vendor-runtime|task-runner|resume-turn-runner)(?:\.[cm]?[jt]s)?$/u;

const walk = directory => fs.readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
      return walk(absolute);
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) return [];
    return [absolute];
  });

const moduleName = node => ts.isStringLiteral(node) ? node.text : null;

const collectBindings = sourceFile => {
  const direct = new Map();
  const namespaces = new Map();
  const ptyNamespaces = new Set();
  const codexClasses = new Set();
  const codexInstances = new Set();
  const codexThreads = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const importedModule = moduleName(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (!clause || !importedModule) continue;
      if (importedModule === 'node-pty' && clause.name) ptyNamespaces.add(clause.name.text);
      if (HTTP_MODULES.has(importedModule) && clause.name) {
        direct.set(clause.name.text, 'http_client.request');
        namespaces.set(clause.name.text, 'http_client');
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        if (CHILD_MODULES.has(importedModule)) {
          namespaces.set(clause.namedBindings.name.text, 'child_process');
        }
        if (importedModule === 'node-pty') ptyNamespaces.add(clause.namedBindings.name.text);
        if (HTTP_MODULES.has(importedModule)) {
          namespaces.set(clause.namedBindings.name.text, 'http_client');
        }
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (CHILD_MODULES.has(importedModule) && CHILD_EXPORTS.has(imported)) {
            direct.set(element.name.text, `child_process.${imported}`);
          }
          if (importedModule === SDK_MODULE && imported === 'query') {
            direct.set(element.name.text, 'claude_sdk.query');
          }
          if (importedModule === '@openai/codex-sdk' && imported === 'Codex') {
            codexClasses.add(element.name.text);
          }
          if (importedModule === 'node-pty' && imported === 'spawn') {
            direct.set(element.name.text, 'node_pty.spawn');
          }
          if (HTTP_MODULES.has(importedModule) && HTTP_EXPORTS.has(imported)) {
            direct.set(element.name.text, `http_client.${imported}`);
          }
        }
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const rawInitializer = declaration.initializer;
      const initializer = rawInitializer && ts.isAwaitExpression(rawInitializer)
        ? rawInitializer.expression
        : rawInitializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      const isRequire = ts.isIdentifier(initializer.expression)
        && initializer.expression.text === 'require';
      const isDynamicImport = initializer.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (!isRequire && !isDynamicImport) continue;
      const importedModule = moduleName(initializer.arguments[0]);
      if (!importedModule) continue;
      if (ts.isObjectBindingPattern(declaration.name)
        && (CHILD_MODULES.has(importedModule) || importedModule === 'node-pty'
          || HTTP_MODULES.has(importedModule) || importedModule === SDK_MODULE
          || importedModule === '@openai/codex-sdk')) {
        for (const element of declaration.name.elements) {
          const imported = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.getText(sourceFile);
          const local = element.name.getText(sourceFile);
          if (CHILD_EXPORTS.has(imported)) direct.set(local, `child_process.${imported}`);
          if (importedModule === 'node-pty' && imported === 'spawn') {
            direct.set(local, 'node_pty.spawn');
          }
          if (HTTP_MODULES.has(importedModule) && HTTP_EXPORTS.has(imported)) {
            direct.set(local, `http_client.${imported}`);
          }
          if (importedModule === SDK_MODULE && imported === 'query') {
            direct.set(local, 'claude_sdk.query');
          }
          if (importedModule === '@openai/codex-sdk' && imported === 'Codex') {
            codexClasses.add(local);
          }
        }
      } else if (ts.isIdentifier(declaration.name)) {
        if (CHILD_MODULES.has(importedModule)) namespaces.set(declaration.name.text, 'child_process');
        if (importedModule === 'node-pty') ptyNamespaces.add(declaration.name.text);
        if (HTTP_MODULES.has(importedModule)) namespaces.set(declaration.name.text, 'http_client');
      }
    }
  }
  const collectNestedModuleBindings = node => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isCallExpression(initializer)
        && ((ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require')
          || initializer.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        const importedModule = moduleName(initializer.arguments[0]);
        if (importedModule && ts.isIdentifier(node.name)) {
          if (CHILD_MODULES.has(importedModule)) namespaces.set(node.name.text, 'child_process');
          if (importedModule === 'node-pty') ptyNamespaces.add(node.name.text);
          if (HTTP_MODULES.has(importedModule)) namespaces.set(node.name.text, 'http_client');
        }
        if (importedModule && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const imported = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.getText(sourceFile);
            const local = element.name.getText(sourceFile);
            if (CHILD_MODULES.has(importedModule) && CHILD_EXPORTS.has(imported)) {
              direct.set(local, `child_process.${imported}`);
            }
            if (importedModule === 'node-pty' && imported === 'spawn') direct.set(local, 'node_pty.spawn');
            if (HTTP_MODULES.has(importedModule) && HTTP_EXPORTS.has(imported)) {
              direct.set(local, `http_client.${imported}`);
            }
            if (importedModule === SDK_MODULE && imported === 'query') direct.set(local, 'claude_sdk.query');
            if (importedModule === '@openai/codex-sdk' && imported === 'Codex') codexClasses.add(local);
          }
        }
      }
    }
    ts.forEachChild(node, collectNestedModuleBindings);
  };
  collectNestedModuleBindings(sourceFile);
  const collectCodexFlow = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && ts.isNewExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && codexClasses.has(node.initializer.expression.text)) {
      codexInstances.add(node.name.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && ts.isNewExpression(node.right)
      && ts.isIdentifier(node.right.expression) && codexClasses.has(node.right.expression.text)) {
      codexInstances.add(node.left.text);
    }
    const assignedThread = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      ? { name: node.name.text, value: node.initializer }
      : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
        ? { name: node.left.text, value: node.right }
        : null;
    if (assignedThread?.value && ts.isCallExpression(assignedThread.value)
      && ts.isPropertyAccessExpression(assignedThread.value.expression)
      && assignedThread.value.expression.name.text === 'startThread'
      && ts.isIdentifier(assignedThread.value.expression.expression)
      && codexInstances.has(assignedThread.value.expression.expression.text)) {
      codexThreads.add(assignedThread.name);
    }
    ts.forEachChild(node, collectCodexFlow);
  };
  collectCodexFlow(sourceFile);
  return { direct, namespaces, ptyNamespaces, codexInstances, codexThreads };
};

const classifyCall = (node, bindings) => {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'fetch') return 'http.fetch';
    return bindings.direct.get(expression.text) ?? null;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const owner = expression.expression.text;
    const method = expression.name.text;
    if (bindings.namespaces.has(owner) && CHILD_EXPORTS.has(method)) {
      return `child_process.${method}`;
    }
    if (bindings.ptyNamespaces.has(owner) && method === 'spawn') return 'node_pty.spawn';
    if (bindings.namespaces.get(owner) === 'http_client' && HTTP_EXPORTS.has(method)) {
      return `http_client.${method}`;
    }
    if (bindings.codexInstances.has(owner) && method === 'startThread') {
      return 'codex_sdk.startThread';
    }
    if (bindings.codexThreads.has(owner) && (method === 'run' || method === 'runStreamed')) {
      return `codex_sdk.${method}`;
    }
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const method = expression.name.text;
    if (method === 'runStreamed') return 'codex_sdk.runStreamed';
  }
  return null;
};

const sitesForSource = (relative, source, kind) => {
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, kind);
  const bindings = collectBindings(sourceFile);
  const occurrences = new Map();
  const result = [];
  const record = (node, primitive, expression) => {
    const occurrence = (occurrences.get(primitive) ?? 0) + 1;
    occurrences.set(primitive, occurrence);
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    result.push({
      id: `${relative}#${primitive}#${occurrence}`,
      file: relative,
      line: position.line + 1,
      primitive,
      expression: expression.slice(0, 160),
    });
  };
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const primitive = classifyCall(node, bindings);
      if (primitive) record(node, primitive, node.expression.getText(sourceFile));
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        && ts.isStringLiteral(node.arguments[0])
        && PROVIDER_LAUNCHER_MODULE.test(node.arguments[0].text)) {
        record(node, 'provider_launcher.dynamic_import', node.getText(sourceFile));
      }
    }
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && PROVIDER_LAUNCHER_MODULE.test(node.moduleSpecifier.text)) {
      record(node, 'provider_launcher.import', node.getText(sourceFile));
    }
    if (ts.isPropertyAccessExpression(node)
      && node.name.text.startsWith('NASSAJ_PERMISSION_')) {
      record(node, 'permission_env.read', node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
};

const sitesForFile = absolute => {
  const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
  const source = fs.readFileSync(absolute, 'utf8');
  const kind = absolute.endsWith('.tsx') ? ts.ScriptKind.TSX
    : absolute.endsWith('.ts') ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  return sitesForSource(relative, source, kind);
};

const readClassifications = () => {
  if (!fs.existsSync(CLASSIFICATIONS)) return { exact: {}, rules: [] };
  const parsed = JSON.parse(fs.readFileSync(CLASSIFICATIONS, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) {
    throw new Error('PERMISSION_LAUNCH_CLASSIFICATIONS_INVALID');
  }
  return parsed;
};

const classificationFor = (id, classifications) => {
  if (classifications.exact?.[id]) return classifications.exact[id];
  const matches = classifications.rules
    .filter(rule => id.startsWith(rule.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  if (matches.length === 0 || matches[1]?.prefix.length === matches[0].prefix.length) {
    return { classification: 'unreviewed' };
  }
  const { prefix: _prefix, ...classification } = matches[0];
  return classification;
};

const resolveRuntimeEntries = () => {
  if (!fs.existsSync(RUNTIME_REGISTRY)) return [];
  const entries = JSON.parse(fs.readFileSync(RUNTIME_REGISTRY, 'utf8')).entries;
  if (!Array.isArray(entries)) throw new Error('PERMISSION_RUNTIME_REGISTRY_INVALID');
  const ids = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id)
      || typeof entry.file !== 'string' || typeof entry.anchor !== 'string' || !entry.anchor) {
      throw new Error(`PERMISSION_RUNTIME_REGISTRY_ENTRY_INVALID:${entry?.id ?? 'unknown'}`);
    }
    ids.add(entry.id);
    const absolute = path.resolve(ROOT, entry.file);
    if (!absolute.startsWith(`${SERVER}${path.sep}`) || !fs.existsSync(absolute)) {
      throw new Error(`PERMISSION_RUNTIME_REGISTRY_FILE_INVALID:${entry.id}`);
    }
    const source = fs.readFileSync(absolute, 'utf8');
    const first = source.indexOf(entry.anchor);
    if (first < 0 || source.indexOf(entry.anchor, first + entry.anchor.length) >= 0) {
      throw new Error(`PERMISSION_RUNTIME_REGISTRY_ANCHOR_INVALID:${entry.id}`);
    }
    return {
      ...entry,
      line: source.slice(0, first).split('\n').length,
    };
  });
};

// T-1593: 'local' is the only effect footprint that lets reconciliation settle a dead
// owner without a fence, so it may be declared only at the reviewed host-child spawn
// sites below. Any other occurrence in server/ fails the check until it is reviewed here.
const LOCAL_FOOTPRINT_SITES = [
  { file: 'server/services/isolation/managed-claude-launcher.ts', start: 'authorizeRuntimeUserProviderEffect({', end: 'return runPermissionExecutionAdapter(' },
  { file: 'server/services/isolation/managed-claude-launch-broker.ts', start: 'authorizeRuntimeUserProviderEffect({', end: 'const launch = crypto.randomUUID();' },
];

function collectEffectScopes(source, file, scopes) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const admissionNames = new Set(['authorizeRuntimeUserProviderEffect', 'authorizeRuntimeProviderExecution']);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const entry of bindings.elements) {
        if (admissionNames.has(entry.propertyName?.text ?? entry.name.text)) admissionNames.add(entry.name.text);
      }
    }
  }
  const visit = node => {
    const expression = ts.isCallExpression(node) ? node.expression : undefined;
    const called = expression && (ts.isIdentifier(expression) ? expression.text
      : ts.isPropertyAccessExpression(expression) ? expression.name.text
      : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined);
    if (ts.isCallExpression(node) && admissionNames.has(called)) {
      const argument = node.arguments[node.arguments.length - 1];
      if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error(`PERMISSION_EFFECT_FOOTPRINT_NONLITERAL:${file}`);
      if (argument) {
        const fields = new Map(argument.properties.filter(ts.isPropertyAssignment)
          .map(property => [property.name.getText(parsed), property.initializer]));
        const literal = key => ts.isStringLiteral(fields.get(key) ?? {}) ? fields.get(key).text : undefined;
        const footprintProperty = argument.properties.find(property => property.name?.getText(parsed).replace(/['"]/g, '') === 'effectFootprint');
        const forwarding = file.endsWith('/execution-permissions/runtime-user-effect.ts')
          && fields.get('effectFootprint')?.getText(parsed) === "input.effectFootprint ?? 'external'";
        if (argument.properties.some(property => ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name)))
          || (!forwarding && footprintProperty && !['local', 'external'].includes(literal('effectFootprint')))) {
          throw new Error(`PERMISSION_EFFECT_FOOTPRINT_NONLITERAL:${file}`);
        }
        const provider = literal('provider'); const purpose = literal('purpose');
        if (provider && purpose) {
          const key = `${provider}:${purpose}`;
          const footprint = literal('effectFootprint') ?? 'external';
          if (scopes.has(key) && scopes.get(key) !== footprint) {
            throw new Error(`PERMISSION_EFFECT_FOOTPRINT_SCOPE_COLLISION:${key}`);
          }
          scopes.set(key, footprint);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}
function assertLocalFootprintReviewed() {
  const offenders = [];
  const scopes = new Map();
  for (const file of walk(SERVER)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file)) || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    collectEffectScopes(source, file, scopes);
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const site = LOCAL_FOOTPRINT_SITES.find(entry => entry.file === relative);
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile).replace(/['"]/g, '') === 'effectFootprint'
        && ts.isStringLiteral(node.initializer) && node.initializer.text === 'local') {
        const position = node.getStart(sourceFile);
        const begin = site ? source.indexOf(site.start) : -1;
        const finish = site && begin >= 0 ? source.indexOf(site.end, begin) : -1;
        if (!(begin >= 0 && finish > begin && position > begin && position < finish)) {
          offenders.push(`${relative}:${source.slice(0, position).split('\n').length}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  if (offenders.length > 0) {
    throw new Error(`PERMISSION_EFFECT_FOOTPRINT_UNREVIEWED:${offenders.join(',')}`);
  }
}

const generate = () => {
  const classifications = readClassifications();
  const runtimeEntries = resolveRuntimeEntries();
  const sites = [...walk(SERVER).flatMap(sitesForFile), ...runtimeEntries]
    .sort((a, b) => a.id.localeCompare(b.id));
  const siteReviewKeys = sites.map(site => ({
    id: site.id,
    file: site.file,
    primitive: site.primitive,
    expression: site.expression,
  }));
  const siteDigest = `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(siteReviewKeys))
    .digest('hex')}`;
  const entries = sites.map(site => ({
    ...site,
    ...classificationFor(site.id, classifications),
  }));
  const canonical = JSON.stringify(entries.map(({ line: _line, ...entry }) => entry));
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/permission-launch-inventory.mjs',
    siteDigest,
    digest: `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
    entries,
  };
};

const serialized = `${JSON.stringify(generate(), null, 2)}\n`;
if (process.argv.includes('--mutation-test')) {
  const mutation = sitesForSource(
    'server/__permission_inventory_mutation__.ts',
    "import { spawn as rawProviderSpawn } from 'node:child_process';\nrawProviderSpawn('provider', []);\n",
    ts.ScriptKind.TS,
  );
  const httpMutation = sitesForSource(
    'server/__permission_inventory_http_mutation__.ts',
    "void fetch('https://provider.invalid');\n",
    ts.ScriptKind.TS,
  );
  const envMutation = sitesForSource(
    'server/__permission_inventory_env_mutation__.ts',
    'void process.env.NASSAJ_PERMISSION_BYPASS;\n',
    ts.ScriptKind.TS,
  );
  const launcherMutation = sitesForSource(
    'server/__permission_inventory_launcher_mutation__.ts',
    "import { queryCodex } from './openai-codex.js';\nvoid queryCodex;\n",
    ts.ScriptKind.TS,
  );
  const ptyMutation = sitesForSource(
    'server/__permission_inventory_pty_mutation__.ts',
    "import { spawn as spawnPty } from 'node-pty';\nspawnPty('provider', []);\n",
    ts.ScriptKind.TS,
  );
  const ptyCommonJsMutation = sitesForSource(
    'server/__permission_inventory_pty_cjs_mutation__.ts',
    "const { spawn: spawnPty } = require('node-pty');\nspawnPty('provider', []);\n",
    ts.ScriptKind.TS,
  );
  const dynamicSpawnMutation = sitesForSource(
    'server/__permission_inventory_dynamic_spawn_mutation__.ts',
    "async function launch() {\n  const { spawn: rawSpawn } = await import('node:child_process');\n  rawSpawn('provider', []);\n}\nvoid launch();\n",
    ts.ScriptKind.TS,
  );
  const httpClientMutation = sitesForSource(
    'server/__permission_inventory_http_client_mutation__.ts',
    "import axios from 'axios';\nvoid axios.get('https://provider.invalid');\n",
    ts.ScriptKind.TS,
  );
  const codexMutation = sitesForSource(
    'server/__permission_inventory_codex_mutation__.ts',
    "import { Codex } from '@openai/codex-sdk';\nconst codex = new Codex();\nconst thread = codex.startThread();\nvoid thread.run('prompt');\nvoid thread.runStreamed('prompt');\n",
    ts.ScriptKind.TS,
  );
  const staticCatalog = sitesForSource(
    'server/__permission_inventory_static_catalog__.ts',
    "const getStaticQwenCatalog = () => ({ DEFAULT: 'qwen' });\nvoid getStaticQwenCatalog();\n",
    ts.ScriptKind.TS,
  );
  const staticCatalogMutation = sitesForSource(
    'server/__permission_inventory_static_catalog_mutation__.ts',
    "import { spawn } from 'node:child_process';\nif (provider === 'qwen') { spawn('qwen', []); void fetch('https://provider.invalid'); }\n",
    ts.ScriptKind.TS,
  );
  if (mutation.length !== 1 || mutation[0].primitive !== 'child_process.spawn'
    || httpMutation.length !== 1 || httpMutation[0].primitive !== 'http.fetch'
    || envMutation.length !== 1 || envMutation[0].primitive !== 'permission_env.read'
    || launcherMutation.length !== 1 || launcherMutation[0].primitive !== 'provider_launcher.import'
    || ptyMutation.length !== 1 || ptyMutation[0].primitive !== 'node_pty.spawn'
    || ptyCommonJsMutation.length !== 1 || ptyCommonJsMutation[0].primitive !== 'node_pty.spawn'
    || dynamicSpawnMutation.length !== 1
    || dynamicSpawnMutation[0].primitive !== 'child_process.spawn'
    || httpClientMutation.length !== 1 || httpClientMutation[0].primitive !== 'http_client.get'
    || codexMutation.length !== 3
    || codexMutation.map(site => site.primitive).join(',')
      !== 'codex_sdk.startThread,codex_sdk.run,codex_sdk.runStreamed'
    || staticCatalog.length !== 0
    || staticCatalogMutation.length !== 2
    || staticCatalogMutation.map(site => site.primitive).sort().join(',')
      !== 'child_process.spawn,http.fetch') {
    throw new Error('PERMISSION_LAUNCH_INVENTORY_MUTATION_NOT_DETECTED');
  }
  const baseline = JSON.parse(serialized);
  // B-927: exact exceptions must remain attached to the reviewed operation,
  // not become broad approval for another launch in either source file.
  const reviewedControls = [
    {
      id: 'server/bootstrap-startup-context.js#child_process.spawn#1',
      classification: 'release_infrastructure_effect', purpose: 'bootstrap_startup_claim',
      adapter: 'exchange', start: 'function exchange(descriptor, request, deadline, deadlineReason = ',
      end: 'function checkResponse(',
      guards: ["['-n', '--', descriptor.dispatcher.path, 'claimBootstrapStartup']"],
      gateTerms: ['root-owned', 'signature', 'kernel process identity', 'CAS', 'before application import'],
    },
    {
      id: 'server/services/codex-app-server.js#child_process.execFileSync#1',
      classification: 'read_only_process_query', purpose: 'codex_native_fork_version_query',
      adapter: 'assertCodexMessageForkRuntimeReady',
      start: 'export function assertCodexMessageForkRuntimeReady() {', end: 'function boundedRpcOutput()',
      guards: ['readCodexExecutableIdentity()', "identity.executablePath, ['--version']",
        'shell: false', 'timeout: 5000', "version !== 'codex-cli 0.153.2'"],
      gateTerms: ['SDK-local', '--version', 'shell false', '5000 ms', 'codex-cli 0.153.2'],
    },
  ];
  const classifications = readClassifications();
  for (const control of reviewedControls) {
    const entry = baseline.entries.find(site => site.id === control.id);
    if (!entry || !classifications.exact?.[control.id]) {
      throw new Error(`PERMISSION_LAUNCH_EXACT_CONTROL_MISSING:${control.id}`);
    }
    const source = fs.readFileSync(path.join(ROOT, entry.file), 'utf8');
    const start = source.indexOf(control.start);
    const end = source.indexOf(control.end, start + control.start.length);
    const offset = source.split('\n', entry.line).join('\n').length;
    const body = source.slice(start, end);
    if (entry.classification !== control.classification || entry.purpose !== control.purpose
      || entry.adapter !== control.adapter || start < 0 || end <= start
      || offset <= start || offset >= end || control.guards.some(guard => !body.includes(guard))
      || control.gateTerms.some(term => !entry.gate?.includes(term))) {
      throw new Error(`PERMISSION_LAUNCH_EXACT_CONTROL_REGRESSION:${control.id}`);
    }
    if (classificationFor(control.id.replace(/#1$/, '#999'), classifications).classification
      !== 'unreviewed') {
      throw new Error(`PERMISSION_LAUNCH_EXACT_CONTROL_WIDENED:${control.id}`);
    }
  }
  // B-1180: pin each newly reviewed site to its operation, not just its ordinal.
  const releaseControls = [
    ['server/index.js#child_process.spawn#1', 'read_only_process_query', 'readGateSessionCount',
      "spawnChildProcess('bash', [SAFE_RESTART_GATE_SCRIPT, '--json'],"],
    ['server/services/source-updater.js#child_process.spawnSync#2', 'read_only_process_query', 'repositorySshCommand',
      "spawnSync('git', ['config', '--get', 'core.sshCommand'],"],
    ['server/services/tests/source-activation-fixture.js#child_process.execFileSync#1', 'test_only', 'git',
      "execFileSync('git', args, { cwd: root"],
    ['server/services/tests/source-activation-fixture.js#child_process.execFileSync#2', 'test_only', 'createActivationFixture',
      "execFileSync('/usr/bin/sqlite3', [databasePath, 'CREATE TABLE rows(id INTEGER); INSERT INTO rows VALUES (1);'])"],
    ['server/services/tests/source-activation-fixture.js#child_process.execFileSync#3', 'test_only', 'cleanup',
      "execFileSync('chmod', ['-R', 'u+w', base])"],
    ['server/services/tests/source-activation-fixture.js#child_process.execFileSync#4', 'test_only', 'sourceState',
      "execFileSync('git', ['diff', '--quiet', commit, '--', '.'], { cwd: fixture.root })"],
    ['server/services/tests/source-activation-fixture.js#child_process.spawn#1', 'test_only', 'startOwnerAt',
      "spawn(process.execPath, ['--input-type=module', '-e', code],"],
  ];
  const releasePurposes = ['safe_restart_session_query', 'repository_ssh_command_query',
    'synthetic_git_fixture', 'synthetic_sqlite_fixture', 'synthetic_fixture_cleanup',
    'synthetic_source_state_query', 'synthetic_owner_crash_fixture'];
  for (const [index, [id, classification, adapter, operation]] of releaseControls.entries()) {
    const entry = baseline.entries.find(site => site.id === id);
    const sourceLine = entry && fs.readFileSync(path.join(ROOT, entry.file), 'utf8').split('\n')[entry.line - 1];
    if (!classifications.exact?.[id] || entry?.classification !== classification
      || entry.adapter !== adapter || entry.purpose !== releasePurposes[index] || !sourceLine?.includes(operation)) {
      throw new Error(`PERMISSION_LAUNCH_RELEASE_CONTROL_REGRESSION:${id}`);
    }
    if (classification === 'test_only'
      && classificationFor(id.replace(/#\d+$/, '#999'), classifications).classification !== 'unreviewed') {
      throw new Error(`PERMISSION_LAUNCH_EXACT_CONTROL_WIDENED:${id}`);
    }
  }
  const forkSource = fs.readFileSync(path.join(SERVER,
    'modules/providers/services/session-fork.service.ts'), 'utf8');
  const createFork = forkSource.slice(forkSource.indexOf('async function createCodexFork('));
  const authorization = createFork.indexOf('await authorizeCodexFork(params)');
  const runtimeQuery = createFork.indexOf('runtime = assertCodexMessageForkRuntimeReady()');
  if (authorization < 0 || runtimeQuery <= authorization) {
    throw new Error('PERMISSION_LAUNCH_RUNTIME_QUERY_AUTHORIZATION_REGRESSION');
  }
  const oidArtifactControl = baseline.entries.find(
    entry => entry.id === 'server/routes/system.js#child_process.spawn#4',
  );
  const governedRestartControl = baseline.entries.find(
    entry => entry.id === 'server/routes/system.js#child_process.spawn#5',
  );
  const foregroundActionControl = baseline.entries.find(
    entry => entry.id === 'server/routes/system.js#child_process.spawn#6',
  );
  const systemRouteSource = fs.readFileSync(path.join(SERVER, 'routes/system.js'), 'utf8');
  const lineOffset = entry => systemRouteSource.split('\n', entry.line).join('\n').length;
  const siteIsBetween = (entry, startAnchor, endAnchor) => {
    if (!entry) return false;
    const start = systemRouteSource.indexOf(startAnchor);
    const end = systemRouteSource.indexOf(endAnchor, start + startAnchor.length);
    const site = lineOffset(entry);
    return start >= 0 && end > start && site > start && site < end;
  };
  if (oidArtifactControl?.classification !== 'release_infrastructure_effect'
    || oidArtifactControl.purpose !== 'oid_restart_control'
    || oidArtifactControl.adapter !== 'executeActionRow OID capsule launcher'
    || !siteIsBetween(
      oidArtifactControl,
      '            if (oidPreview) {\n                // The loaded launcher remains alive',
      "            if (serverCandidate?.activationKind === 'legacy-resume') {",
    )
    || governedRestartControl?.classification !== 'release_infrastructure_effect'
    || governedRestartControl.purpose !== 'governed_restart_activation'
    || governedRestartControl.adapter
      !== 'executeActionRow detached restart and activation launcher'
    || !siteIsBetween(
      governedRestartControl,
      '            const reenqueueRow = async (outcome, extra = {}) => {',
      '                // Spawn launched. Hold the in-flight guard:',
    )
    || foregroundActionControl?.classification !== 'operator_infrastructure'
    || foregroundActionControl.purpose !== 'operator_command'
    || foregroundActionControl.adapter !== 'runForegroundAction'
    || !siteIsBetween(
      foregroundActionControl,
      'function runForegroundAction(req, res, action, id, row) {',
      '        let settled = false;',
    )) {
    throw new Error('PERMISSION_LAUNCH_CONTROL_CLASSIFICATION_REGRESSION');
  }
  if (baseline.entries.some(entry => entry.id === mutation[0].id)) {
    throw new Error('PERMISSION_LAUNCH_INVENTORY_MUTATION_COLLISION');
  }
  const mutatedSites = [
    mutation[0], httpMutation[0], envMutation[0], launcherMutation[0], ptyMutation[0],
    ptyCommonJsMutation[0], dynamicSpawnMutation[0], httpClientMutation[0], ...codexMutation,
    ...staticCatalogMutation,
  ];
  const mutatedIds = mutatedSites.map(site => site.id);
  const mutatedSiteDigest = `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify([...baseline.entries, ...mutatedSites]
      .map(site => ({ id: site.id, file: site.file, primitive: site.primitive, expression: site.expression }))
      .sort((a, b) => a.id.localeCompare(b.id))))
    .digest('hex')}`;
  const reviewedSiteDigest = readClassifications().reviewedSiteDigest;
  if (mutatedSiteDigest === reviewedSiteDigest) {
    throw new Error('PERMISSION_LAUNCH_INVENTORY_MUTATION_GATE_BYPASSED');
  }
  const scopeFixture = new Map();
  collectEffectScopes("authorizeRuntimeUserProviderEffect({provider:'codex',purpose:'spawn',effectFootprint:'external'})", 'external.ts', scopeFixture);
  let collisionRejected = false;
  try {
    collectEffectScopes("authorizeRuntimeUserProviderEffect({provider:'codex',purpose:'spawn',effectFootprint:'local'})", 'local.ts', scopeFixture);
  } catch (error) { collisionRejected = error.message.includes('PERMISSION_EFFECT_FOOTPRINT_SCOPE_COLLISION'); }
  if (!collisionRejected) throw new Error('PERMISSION_EFFECT_FOOTPRINT_SCOPE_MUTATION_BYPASSED');
  for (const property of ['effectFootprint: footprint', 'effectFootprint', '...options', "['effectFootprint']: footprint", "['effectFootprint']: 'local'"]) {
    let rejected = false;
    try { collectEffectScopes(`authorizeRuntimeUserProviderEffect({provider:'codex',purpose:'spawn',${property}})`, 'mutation.ts', new Map()); }
    catch (error) { rejected = error.message.includes('PERMISSION_EFFECT_FOOTPRINT_NONLITERAL'); }
    if (!rejected) throw new Error('PERMISSION_EFFECT_FOOTPRINT_DYNAMIC_MUTATION_BYPASSED');
  }
  for (const argument of ['options', 'condition ? local : external']) {
    let rejected = false;
    try { collectEffectScopes(`authorizeRuntimeUserProviderEffect(${argument})`, 'mutation.ts', new Map()); }
    catch (error) { rejected = error.message.includes('PERMISSION_EFFECT_FOOTPRINT_NONLITERAL'); }
    if (!rejected) throw new Error('PERMISSION_EFFECT_FOOTPRINT_ARGUMENT_MUTATION_BYPASSED');
  }
  let aliasRejected = false;
  try { collectEffectScopes("import { authorizeRuntimeUserProviderEffect as authorize } from './runtime-user-effect'; authorize({provider:'claude',purpose:'spawn',effectFootprint: ('lo'+'cal')})", 'alias.ts', new Map()); }
  catch (error) { aliasRejected = error.message.includes('PERMISSION_EFFECT_FOOTPRINT_NONLITERAL'); }
  if (!aliasRejected) throw new Error('PERMISSION_EFFECT_FOOTPRINT_ALIAS_MUTATION_BYPASSED');
  process.stdout.write(`mutation-rejected:${mutatedIds.join(',')}\n`);
} else if (process.argv.includes('--write')) {
  fs.writeFileSync(INVENTORY, serialized, 'utf8');
  process.stdout.write(`${INVENTORY}\n`);
} else if (process.argv.includes('--check')) {
  assertLocalFootprintReviewed();
  if (!fs.existsSync(INVENTORY) || fs.readFileSync(INVENTORY, 'utf8') !== serialized) {
    throw new Error('PERMISSION_LAUNCH_INVENTORY_DRIFT');
  }
  const inventory = JSON.parse(serialized);
  const reviewedSiteDigest = readClassifications().reviewedSiteDigest;
  if (inventory.siteDigest !== reviewedSiteDigest) {
    throw new Error(
      `PERMISSION_LAUNCH_SITE_SET_UNREVIEWED:${inventory.siteDigest}:${reviewedSiteDigest ?? 'missing'}`,
    );
  }
  const invalid = inventory.entries.filter(entry => (
    entry.classification === 'unreviewed'
    || entry.classification.endsWith('_unenclosed')
  ));
  if (invalid.length > 0) {
    throw new Error(`PERMISSION_LAUNCH_INVENTORY_UNREVIEWED:${invalid.map(e => e.id).join(',')}`);
  }
  process.stdout.write(`${inventory.digest} ${inventory.entries.length}\n`);
} else {
  process.stdout.write(serialized);
}
