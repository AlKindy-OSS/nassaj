#!/usr/bin/env node
/**
 * Inventory interactive UI controls from tracked source without rendering the app.
 *
 * Scope and deliberate limits:
 * - Scans tracked src/**.{ts,tsx,js,jsx,css} files only.
 * - Excludes tests, specs, stories, snapshots, fixtures, and generated paths.
 * - Uses the TypeScript AST, so comments and string examples are not counted.
 * - Resolves literal className strings (including literals nested in cn/cva
 *   expressions). Runtime-computed classes, spread props, polymorphic `asChild`
 *   output, and CSS-in-JS runtime styles cannot be resolved statically.
 * - CSS lookup records declarations attached to literal class selectors. It does
 *   not attempt cascade, specificity, media-query, or computed-style evaluation.
 *
 * Use browser/computed-style auditing as the complementary source of truth for
 * final rendered dimensions and accessibility semantics.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import ts from 'typescript';

export const SCHEMA_VERSION = 1;

const CODE_EXTENSION = /\.(?:[jt]sx?)$/i;
const CSS_EXTENSION = /\.css$/i;
const EXCLUDED_PATH = /(?:^|\/)(?:__tests__|__mocks__|fixtures?|generated|coverage)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec|stories|story|snap)\.[jt]sx?$/i;
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'scrollbar', 'searchbox', 'slider',
  'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
]);
const NATIVE_INTERACTIVE = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const HEIGHT_CLASS = /^(?:!?)(?:(?:min|max)-)?h-(?:\[[^\]]+\]|[^\s:]+)$/;
const TYPE_CLASS = /^(?:!?)(?:text-(?:\[[^\]]+\]|xs|sm|base|lg|xl|[2-9]xl)|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|sans|serif|mono|\[[^\]]+\])|leading-(?:\[[^\]]+\]|none|tight|snug|normal|relaxed|loose|[3-9]|10)|tracking-(?:\[[^\]]+\]|tighter|tight|normal|wide|wider|widest))$/;
const HEIGHT_STYLE = new Set(['height', 'minHeight', 'maxHeight']);
const TYPE_STYLE = new Set(['font', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'lineHeight', 'letterSpacing']);

export function isAuditedPath(file) {
  const normalized = file.replaceAll('\\', '/');
  return normalized.startsWith('src/')
    && !EXCLUDED_PATH.test(normalized)
    && (CODE_EXTENSION.test(normalized) || CSS_EXTENSION.test(normalized));
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function jsxName(node, sourceFile) {
  return node.tagName.getText(sourceFile);
}

function canonicalImportPath(file, specifier) {
  let resolved = specifier;
  if (specifier.startsWith('.')) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  } else if (specifier.startsWith('@/')) {
    resolved = `src/${specifier.slice(2)}`;
  }
  return resolved.replace(/\.(?:[jt]sx?)$/, '').replace(/\/index$/, '');
}

function isSharedButtonModule(modulePath) {
  return modulePath === 'src/shared/view/ui' || modulePath === 'src/shared/view/ui/Button';
}

function isSharedButtonDefinition(file) {
  return file.replace(/\.(?:[jt]sx?)$/, '') === 'src/shared/view/ui/Button';
}

function attribute(node, name) {
  return node.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function literalAttributeValue(attr) {
  if (!attr) return null;
  if (!attr.initializer) return true;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (!ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) return null;
  const expression = attr.initializer.expression;
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function collectStringLiterals(node, values = []) {
  if (!node) return values;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    values.push(node.text);
    return values;
  }
  ts.forEachChild(node, (child) => {
    collectStringLiterals(child, values);
  });
  return values;
}

function classInfo(opening) {
  const attr = attribute(opening, 'className');
  if (!attr?.initializer) return { classes: [], dynamic: false };
  if (ts.isStringLiteral(attr.initializer)) {
    return { classes: attr.initializer.text.split(/\s+/).filter(Boolean), dynamic: false };
  }
  if (!ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) {
    return { classes: [], dynamic: true };
  }
  const expression = attr.initializer.expression;
  const literals = collectStringLiterals(expression);
  return {
    classes: [...new Set(literals.flatMap((value) => value.split(/\s+/).filter(Boolean)))],
    dynamic: !ts.isStringLiteralLike(expression) && !ts.isNoSubstitutionTemplateLiteral(expression),
  };
}

function styleProperties(opening) {
  const attr = attribute(opening, 'style');
  if (!attr?.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) return [];
  const expression = attr.initializer.expression;
  if (!ts.isObjectLiteralExpression(expression)) return [];
  return expression.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
    return [property.name.getText().replace(/^['"]|['"]$/g, '')];
  });
}

function parseCss(files) {
  const definitions = new Map();
  for (const { file, content } of files) {
    let root;
    try {
      root = postcss.parse(content, { from: file });
    } catch {
      continue;
    }
    root.walkRules((rule) => {
      const classNames = [...rule.selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((match) => match[1]);
      if (classNames.length === 0) return;
      const declarations = [];
      rule.walkDecls((decl) => {
        if (['height', 'min-height', 'max-height', 'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'line-height', 'letter-spacing'].includes(decl.prop)) {
          declarations.push({ property: decl.prop, value: decl.value });
        }
      });
      if (declarations.length === 0) return;
      for (const className of classNames) {
        const current = definitions.get(className) ?? [];
        current.push({ file, selector: rule.selector, declarations });
        definitions.set(className, current);
      }
    });
  }
  return definitions;
}

function addCount(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function violation(node, rule, detail) {
  return { rule, file: node.file, line: node.line, column: node.column, element: node.element, detail };
}

/** Analyze an in-memory tracked-source snapshot. Exported for deterministic fixtures. */
export function analyzeSourceSet({ codeFiles, cssFiles = [], ref = 'worktree', commit = null }) {
  const cssDefinitions = parseCss(cssFiles);
  const interactiveNodes = [];
  const primitiveNodes = [];
  const rawNodes = [];
  const violations = [];

  for (const { file, content } of codeFiles) {
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind(file));
    const importedButtons = new Set();
    const importedButtonNamespaces = new Set();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const modulePath = canonicalImportPath(file, statement.moduleSpecifier.text);
      if (!isSharedButtonModule(modulePath)) continue;
      const directModule = modulePath === 'src/shared/view/ui/Button';
      if (statement.importClause.name && directModule) {
        importedButtons.add(statement.importClause.name.text);
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if ((specifier.propertyName?.text ?? specifier.name.text) === 'Button') importedButtons.add(specifier.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        importedButtonNamespaces.add(bindings.name.text);
      }
    }

    const visit = (astNode) => {
      if (!ts.isJsxOpeningElement(astNode) && !ts.isJsxSelfClosingElement(astNode)) {
        ts.forEachChild(astNode, visit);
        return;
      }
      const element = jsxName(astNode, sourceFile);
      const roleValue = literalAttributeValue(attribute(astNode, 'role'));
      const role = typeof roleValue === 'string' ? roleValue : null;
      // TypeScript treats lower-case, non-member JSX names as intrinsic. Never
      // lowercase a component name: <Input> is not the intrinsic <input>.
      const isIntrinsic = !element.includes('.') && /^[a-z]/.test(element);
      const intrinsicName = isIntrinsic ? element.toLowerCase() : null;
      const isAnchor = intrinsicName === 'a' && Boolean(attribute(astNode, 'href'));
      const isNative = intrinsicName !== null && (NATIVE_INTERACTIVE.has(intrinsicName) || isAnchor);
      const isRole = role !== null && INTERACTIVE_ROLES.has(role);
      const [namespace, member] = element.split('.');
      const isPrimitive = importedButtons.has(element)
        || (member === 'Button' && importedButtonNamespaces.has(namespace));
      if (!isNative && !isRole && !isPrimitive) {
        ts.forEachChild(astNode, visit);
        return;
      }

      const start = sourceFile.getLineAndCharacterOfPosition(astNode.getStart(sourceFile));
      const classes = classInfo(astNode);
      const heightClasses = classes.classes.filter((name) => HEIGHT_CLASS.test(name.split(':').at(-1)));
      const typeClasses = classes.classes.filter((name) => TYPE_CLASS.test(name.split(':').at(-1)));
      const styles = styleProperties(astNode);
      const cssMatches = classes.classes.flatMap((name) => cssDefinitions.get(name) ?? []);
      const isApprovedImplementation = isSharedButtonDefinition(file) && intrinsicName === 'button';
      const approval = isPrimitive
        ? 'shared-button-primitive'
        : isApprovedImplementation
          ? 'shared-button-implementation'
          : null;
      const family = isPrimitive
        ? 'shared-button'
        : isApprovedImplementation
          ? 'approved-implementation'
          : isNative
            ? 'native'
            : 'interactive-role';
      const record = {
        file,
        line: start.line + 1,
        column: start.character + 1,
        element,
        family,
        approval,
        role,
        classes: classes.classes,
        dynamicClassName: classes.dynamic,
        heightClasses,
        typeClasses,
        inlineStyleProperties: styles,
        cssMatches,
      };
      interactiveNodes.push(record);
      if (isPrimitive) primitiveNodes.push(record);
      if (!approval) rawNodes.push(record);

      if (!approval) {
        violations.push(violation(
          record,
          'raw-interactive-control',
          'Interactive JSX node is neither the documented shared Button primitive nor its implementation.',
        ));
      }
      for (const name of heightClasses) violations.push(violation(record, 'direct-height-class', name));
      for (const name of typeClasses) violations.push(violation(record, 'direct-typography-class', name));
      for (const name of styles.filter((name) => HEIGHT_STYLE.has(name))) violations.push(violation(record, 'direct-height-style', name));
      for (const name of styles.filter((name) => TYPE_STYLE.has(name))) violations.push(violation(record, 'direct-typography-style', name));
      for (const match of cssMatches) {
        const height = match.declarations.filter(({ property }) => ['height', 'min-height', 'max-height'].includes(property));
        const type = match.declarations.filter(({ property }) => !['height', 'min-height', 'max-height'].includes(property));
        if (height.length) violations.push(violation(record, 'css-class-height', `${match.file}: ${height.map(({ property, value }) => `${property}:${value}`).join(', ')}`));
        if (type.length) violations.push(violation(record, 'css-class-typography', `${match.file}: ${type.map(({ property, value }) => `${property}:${value}`).join(', ')}`));
      }
      ts.forEachChild(astNode, visit);
    };
    visit(sourceFile);
  }

  const byFamily = {};
  const byHeightClass = {};
  const byTypeClass = {};
  const violationsByRule = {};
  for (const node of interactiveNodes) {
    addCount(byFamily, node.family);
    for (const name of node.heightClasses) addCount(byHeightClass, name);
    for (const name of node.typeClasses) addCount(byTypeClass, name);
  }
  for (const item of violations) addCount(violationsByRule, item.rule);

  const byLocation = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
  interactiveNodes.sort(byLocation);
  primitiveNodes.sort(byLocation);
  rawNodes.sort(byLocation);
  violations.sort((a, b) => byLocation(a, b) || a.rule.localeCompare(b.rule) || a.detail.localeCompare(b.detail));

  return {
    schemaVersion: SCHEMA_VERSION,
    ref,
    commit,
    approvedComponentPolicy: {
      sharedButtonModules: ['src/shared/view/ui', 'src/shared/view/ui/Button'],
      primitiveImports: 'Named Button exports (including aliases), namespace .Button members, and direct-module default imports from the documented modules.',
      approvedImplementation: 'The intrinsic <button> inside src/shared/view/ui/Button.tsx.',
      rawDefinition: 'Every detected interactive JSX node whose approval field is null; rawNodes and primitiveNodes never overlap.',
    },
    filesScanned: { code: codeFiles.length, css: cssFiles.length, total: codeFiles.length + cssFiles.length },
    interactiveNodes,
    primitiveNodes,
    rawNodes,
    counts: {
      interactive: interactiveNodes.length,
      primitives: primitiveNodes.length,
      raw: rawNodes.length,
      violations: violations.length,
      byFamily: sortedRecord(byFamily),
      byHeightClass: sortedRecord(byHeightClass),
      byTypeClass: sortedRecord(byTypeClass),
      violationsByRule: sortedRecord(violationsByRule),
    },
    violations,
    analysisLimits: [
      'Dynamic class names, spread props, and runtime-polymorphic elements are not resolved.',
      'Literal branches inside className expressions are inventoried as possible classes, not runtime facts.',
      'CSS declarations are selector matches only; cascade, specificity, media queries, inheritance, and computed styles are not evaluated.',
      'Component internals are not expanded at call sites; rendered dimensions require a browser audit.',
    ],
  };
}

function git(args, options = {}) {
  const output = execFileSync('git', args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return options.trim === false ? output : output.trim();
}

function loadSnapshot({ mode, ref }) {
  const commit = mode === 'ref' ? git(['rev-parse', '--verify', `${ref}^{commit}`]) : git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const listed = mode === 'ref'
    ? git(['ls-tree', '-r', '--name-only', ref, '--', 'src'])
    : git(['ls-files', '--', 'src']);
  const files = listed.split('\n')
    .filter(Boolean)
    .filter(isAuditedPath)
    .filter((file) => mode === 'ref' || existsSync(file))
    .sort();
  const read = mode === 'ref'
    ? (file) => git(['show', `${ref}:${file}`], { trim: false })
    : (file) => readFileSync(file, 'utf8');
  const entries = files.map((file) => ({ file, content: read(file) }));
  return {
    codeFiles: entries.filter(({ file }) => CODE_EXTENSION.test(file)),
    cssFiles: entries.filter(({ file }) => CSS_EXTENSION.test(file)),
    commit,
  };
}

function parseArgs(argv) {
  let mode = 'worktree';
  let ref = null;
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--worktree') {
      mode = 'worktree';
      ref = null;
    } else if (arg === '--ref') {
      if (!argv[index + 1]) throw new Error('--ref requires a Git revision');
      mode = 'ref';
      ref = argv[++index];
    } else if (arg === '--out') {
      if (!argv[index + 1]) throw new Error('--out requires a path');
      out = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { mode, ref, out, help: false };
}

export function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/audit-ui-controls.mjs [--worktree | --ref <revision>] [--out <path>]\n');
    return;
  }
  const snapshot = loadSnapshot(options);
  const audit = analyzeSourceSet({
    ...snapshot,
    ref: options.mode === 'ref' ? options.ref : 'worktree',
  });
  const json = `${JSON.stringify(audit, null, 2)}\n`;
  if (options.out) writeFileSync(path.resolve(options.out), json, 'utf8');
  else process.stdout.write(json);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`audit-ui-controls: ${error.message}\n`);
    process.exitCode = 1;
  }
}
