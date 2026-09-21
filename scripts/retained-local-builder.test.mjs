import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installUpdateRuntimeBundle } from './lib/update-runtime-bundle.mjs';
import { retainedLocalBuilderEntry } from './preview-oid-consumer.mjs';

test('full builder entry remains retained when mutable source changes; altered retained bytes refuse', t => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.artifacts/retained-builder-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source'), artifactRoot = path.join(root, 'artifact');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true }); fs.mkdirSync(artifactRoot);
    const entry = 'scripts/oid-update-candidate.mjs';
    fs.writeFileSync(path.join(source, entry), 'export const generation = 1;');
    const installed = installUpdateRuntimeBundle(source, artifactRoot, { entries: [entry] });
    const boot = { artifactRoot, buildId: installed.manifest.buildId };
    const resolved = retainedLocalBuilderEntry(boot);
    fs.writeFileSync(path.join(source, entry), 'throw Error("mutable source must not run");');
    assert.equal(retainedLocalBuilderEntry(boot).entry, resolved.entry);
    assert.equal(fs.readFileSync(resolved.entry, 'utf8'), 'export const generation = 1;');
    assert.throws(() => retainedLocalBuilderEntry(null), /retained_builder_required/);
    assert.throws(() => retainedLocalBuilderEntry({ ...boot, buildId: 'a'.repeat(64) }), /retained_builder_changed/);
    fs.writeFileSync(resolved.entry, 'changed');
    assert.throws(() => retainedLocalBuilderEntry(boot), /fingerprint/);
});
