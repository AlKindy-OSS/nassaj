/**
 * Emit the transitive relative-import closure of server/shared modules into a scratch tree.
 *
 * Script tests that need a compiled copy of a few server modules used to list the files by
 * hand and run ts.transpileModule on each one. transpileModule never follows imports, so
 * every new relative import in that graph broke the tests with ERR_MODULE_NOT_FOUND
 * (98c33b50a, then T-1953). This helper derives the list from the import graph instead.
 *
 * Scope: only string-literal specifiers are followed (static imports, `export ... from`,
 * `import('literal')`, `require('literal')`). NOT followed, so callers must emit them explicitly:
 * template-literal or computed `import()`, `file:` URL specifiers, and files read through
 * `fs` with `new URL('...', import.meta.url)` (e.g. capability-registry.ts:112,143,165 read
 * claude-sdk.js, openai-codex.js and agy-cli.js that way).
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

/** The options the script tests have always transpiled with. */
export const CLOSURE_COMPILER_OPTIONS = Object.freeze({
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
});

const TS_SOURCE_FOR = Object.freeze({ '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' });
const TS_OUTPUT_FOR = Object.freeze({ '.ts': '.js', '.mts': '.mjs', '.cts': '.cjs' });
const COPIED = new Set(['.js', '.mjs', '.cjs', '.json']);

/** Write the transpiled form of one source file (also valid for .js, as tsc allowJs rewrites it). */
export function emitTranspiled(sourceFile, targetFile, compilerOptions = CLOSURE_COMPILER_OPTIONS) {
    const text = fs.readFileSync(sourceFile, 'utf8');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, ts.transpileModule(text, { compilerOptions, fileName: sourceFile }).outputText);
}

const fail = message => { throw new Error(`compile_module_closure: ${message}`); };
const TS_SPECIFIER = /\.[cm]?ts$/u;
const isRelative = specifier => specifier.startsWith('./') || specifier.startsWith('../');

/** Resolve a relative specifier the way the repo's NodeNext build does: `x.js` means `x.ts` when it exists. */
function resolveModule(target, importer) {
    const extension = path.extname(target);
    const candidates = TS_SOURCE_FOR[extension]
        ? [target.slice(0, -extension.length) + TS_SOURCE_FOR[extension], target]
        : [target];
    const found = candidates.find(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
    if (!found) fail(`cannot resolve ${target} (imported by ${importer})`);
    return found;
}

/** Every module specifier of a file: static imports, re-exports, dynamic import('literal') and require. */
function importedSpecifiers(file, text) {
    return ts.preProcessFile(text, true, true).importedFiles.map(entry => entry.fileName)
        .filter(specifier => {
            if (specifier.startsWith('@/')) fail(`path alias '${specifier}' in ${file} is not supported`);
            // Emission renames x.ts to x.js, so an importer naming x.ts would point at nothing.
            if (TS_SPECIFIER.test(specifier)) fail(`'${specifier}' in ${file} names a TypeScript extension`);
            return isRelative(specifier) || path.isAbsolute(specifier);
        });
}

/**
 * Transpile/copy every module reachable from `entries` through string-literal relative imports
 * (see the module header for what is not followed). Layout relative to `sourceRoot` is preserved
 * under `destinationRoot`; `.ts` becomes `.js`. Bare package specifiers are left for Node to
 * resolve. Throws on an unresolvable literal relative specifier, a specifier ending in
 * .ts/.mts/.cts, a file whose real path (symlinks resolved) is outside `sourceRoot`, or an
 * unsupported extension.
 *
 * @param {{ sourceRoot: string, destinationRoot: string, entries: string[],
 *   compilerOptions?: import('typescript').CompilerOptions }} options
 * @returns {string[]} emitted paths relative to `destinationRoot`, sorted
 */
export function compileModuleClosure({ sourceRoot, destinationRoot, entries, compilerOptions = CLOSURE_COMPILER_OPTIONS }) {
    if (!Array.isArray(entries) || entries.length === 0) fail('at least one entry is required');
    const root = fs.realpathSync(sourceRoot);
    const pending = entries.map(entry => resolveModule(path.resolve(root, entry), 'entries'));
    const visited = new Set();
    const emitted = [];
    while (pending.length > 0) {
        const file = fs.realpathSync(pending.pop());
        if (visited.has(file)) continue;
        visited.add(file);
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`${file} is outside ${root}`);
        const extension = path.extname(file);
        if (!TS_OUTPUT_FOR[extension] && !COPIED.has(extension)) fail(`unsupported module type ${file}`);
        const text = fs.readFileSync(file, 'utf8');
        const outputRelative = TS_OUTPUT_FOR[extension] ? relative.slice(0, -extension.length) + TS_OUTPUT_FOR[extension] : relative;
        const target = path.join(destinationRoot, outputRelative);
        if (TS_OUTPUT_FOR[extension]) emitTranspiled(file, target, compilerOptions);
        else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target); }
        emitted.push(outputRelative);
        if (extension === '.json') continue;
        for (const specifier of importedSpecifiers(file, text)) {
            pending.push(resolveModule(path.resolve(path.dirname(file), specifier), file));
        }
    }
    return emitted.sort();
}
