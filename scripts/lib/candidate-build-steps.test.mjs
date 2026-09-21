import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildInstalledCandidateArtifact, dependencyEnvironment } from './candidate-build-steps.mjs';

test('both builders run the target source modules with the target staged dependency resolution', t => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-build-tools-'));
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(sourceRoot, 'scripts/lib'), { recursive: true });
    const dep = path.join(sourceRoot, 'node_modules/nassaj-staged-tool-fixture'); fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'nassaj-staged-tool-fixture', version: '2.0.0', type: 'module', exports: './index.js' }));
    fs.writeFileSync(path.join(dep, 'index.js'), "export const marker = 'target dependency v2';");
    for (const domain of ['client', 'server']) {
        const name = domain === 'client' ? 'buildClientReleaseCandidate' : 'buildServerReleaseCandidate';
        fs.writeFileSync(path.join(sourceRoot, 'scripts', `${domain}-build-atomic.mjs`),
            `import {marker} from 'nassaj-staged-tool-fixture'; export function ${name}(options){return {marker,sourceRoot:options.sourceRoot,node:process.version};}`);
        const result = buildInstalledCandidateArtifact(domain, { sourceRoot }, (executable, args, options) => {
            const child = spawnSync(executable, args, { ...options, encoding: 'utf8' });
            assert.equal(child.status, 0, child.stderr); return child;
        }, dependencyEnvironment());
        assert.equal(result.marker, 'target dependency v2'); assert.equal(result.sourceRoot, sourceRoot);
        assert.equal(result.node, process.version);
    }
    assert.throws(() => buildInstalledCandidateArtifact('arbitrary', {}, () => assert.fail()), /domain_invalid/);
});
