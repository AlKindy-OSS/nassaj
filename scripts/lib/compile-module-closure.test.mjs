import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileModuleClosure, emitTranspiled } from './compile-module-closure.mjs';

function scratch(t) {
    fs.mkdirSync(path.join(process.cwd(), '.artifacts'), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), '.artifacts/module-closure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const write = (relative, text) => {
        fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
        fs.writeFileSync(path.join(source, relative), text);
    };
    return { source, destination: path.join(root, 'out'), write };
}

test('emits the transitive closure through static, re-export and dynamic imports', async t => {
    const { source, destination, write } = scratch(t);
    write('server/entry.ts', "import { a } from './a.js';\nexport { b } from '../shared/b.js';\n"
        + "export const load = () => import('./lazy/c.js');\nexport const value: string = a;\n");
    write('server/a.ts', "import data from './data.json' with { type: 'json' };\nexport const a = data.name;\n");
    write('server/data.json', '{"name":"alpha"}');
    write('shared/b.ts', "export * from './deep.js';\nexport const b = 'beta';\n");
    write('shared/deep.js', 'export const deep = 1;\n');
    write('server/lazy/c.ts', 'export const c = 3;\n');
    write('server/unreachable.ts', "import './missing.js';\n");

    const emitted = compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['server/entry.ts'] });

    assert.deepEqual(emitted, ['server/a.js', 'server/data.json', 'server/entry.js', 'server/lazy/c.js',
        'shared/b.js', 'shared/deep.js']);
    const entry = await import(pathToFileURL(path.join(destination, 'server/entry.js')).href);
    assert.equal(entry.value, 'alpha');
    assert.equal(entry.b, 'beta');
    assert.equal((await entry.load()).c, 3);
    assert.equal(fs.readFileSync(path.join(destination, 'shared/deep.js'), 'utf8'), 'export const deep = 1;\n');
});

test('resolves a .js specifier to the .ts source and accepts a .js entry name', t => {
    const { source, destination, write } = scratch(t);
    write('lib/main.ts', "import { helper } from './helper.js';\nexport const main = helper;\n");
    write('lib/helper.ts', 'export const helper = (n: number): number => n + 1;\n');

    const emitted = compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['lib/main.js'] });

    assert.deepEqual(emitted, ['lib/helper.js', 'lib/main.js']);
    assert.doesNotMatch(fs.readFileSync(path.join(destination, 'lib/helper.js'), 'utf8'), /: number/);
});

test('terminates on an import cycle and emits each module once', async t => {
    const { source, destination, write } = scratch(t);
    write('x.ts', "import { y } from './y.js';\nexport const x = () => 'x' + y();\n");
    write('y.ts', "import { x } from './x.js';\nexport const y = () => 'y';\nexport const usesX = () => x;\n");

    const emitted = compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['x.ts', 'y.ts'] });

    assert.deepEqual(emitted, ['x.js', 'y.js']);
    assert.equal((await import(pathToFileURL(path.join(destination, 'x.js')).href)).x(), 'xy');
});

test('throws loudly on an unresolvable relative import', t => {
    const { source, destination, write } = scratch(t);
    write('entry.ts', "export { gone } from './gone.js';\n");

    assert.throws(() => compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['entry.ts'] }),
        /cannot resolve .*gone\.js \(imported by .*entry\.ts\)/);
});

test('leaves bare package imports alone and rejects unsupported path aliases', t => {
    const { source, destination, write } = scratch(t);
    write('entry.ts', "import fs from 'node:fs';\nimport ts from 'typescript';\nexport const ok = [fs, ts];\n");
    write('alias.ts', "import { x } from '@/server/x.js';\nexport { x };\n");

    assert.deepEqual(compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['entry.ts'] }), ['entry.js']);
    assert.match(fs.readFileSync(path.join(destination, 'entry.js'), 'utf8'), /from 'typescript'/);
    assert.throws(() => compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['alias.ts'] }),
        /path alias '@\/server\/x\.js'/);
});

test('rejects an empty entry list and imports that escape the source root', t => {
    const { source, destination, write } = scratch(t);
    write('inner/entry.ts', "import '../../outside.js';\n");
    fs.writeFileSync(path.join(source, '..', 'outside.js'), 'export {};\n');

    assert.throws(() => compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: [] }), /entry is required/);
    assert.throws(() => compileModuleClosure({ sourceRoot: path.join(source, 'inner'), destinationRoot: destination,
        entries: ['entry.ts'] }), /is outside/);
});

test('emitTranspiled rewrites a .js file the way the compiled build does', t => {
    const { source, destination, write } = scratch(t);
    write('adapter.js', 'export const value = 1 // no semicolon\n');

    emitTranspiled(path.join(source, 'adapter.js'), path.join(destination, 'nested/adapter.js'));

    assert.equal(fs.readFileSync(path.join(destination, 'nested/adapter.js'), 'utf8'), 'export const value = 1; // no semicolon\n');
});

test('rejects a relative specifier that names a TypeScript extension', t => {
    const { source, destination, write } = scratch(t);
    write('entry.ts', "export { a } from './a.ts';\n");
    write('a.ts', 'export const a = 1;\n');
    write('modern.ts', "import './m.mts';\n");
    write('m.mts', 'export {};\n');

    assert.throws(() => compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['entry.ts'] }),
        /'\.\/a\.ts' in .*entry\.ts names a TypeScript extension/);
    assert.throws(() => compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['modern.ts'] }),
        /'\.\/m\.mts' .* names a TypeScript extension/);
});

test('rejects a symlink inside the root whose real target escapes it', t => {
    const { source, destination, write } = scratch(t);
    write('entry.ts', "import { secret } from './link.js';\nexport { secret };\n");
    fs.writeFileSync(path.join(source, '..', 'escaped.js'), 'export const secret = 1;\n');
    fs.symlinkSync(path.join(source, '..', 'escaped.js'), path.join(source, 'link.js'));

    assert.throws(() => compileModuleClosure({ sourceRoot: source, destinationRoot: destination, entries: ['entry.ts'] }),
        /escaped\.js is outside/);
    assert.equal(fs.existsSync(path.join(destination, 'link.js')), false);
});
