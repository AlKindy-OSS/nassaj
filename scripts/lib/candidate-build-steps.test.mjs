import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildInstalledCandidateArtifact, dependencyEnvironment, sanitizedStderrTail } from './candidate-build-steps.mjs';

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

test('a failing builder reports its own reason to the job log, not just an exit status (B-1383)', t => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'failing-builder-'));
    t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(sourceRoot, 'scripts/lib'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'scripts/server-build-atomic.mjs'),
        "export function buildServerReleaseCandidate(){throw new Error('CODEX_IMAGE_ONLY_PATCH_VERSION mismatch');}");
    const stepsUrl = new URL('./candidate-build-steps.mjs', import.meta.url).href;
    // The parent runner mirrors the production runner: it never forwards captured stderr itself.
    const harness = `import {buildInstalledCandidateArtifact as b} from ${JSON.stringify(stepsUrl)};
import {spawnSync} from 'node:child_process';
try { b('server', {sourceRoot: ${JSON.stringify(sourceRoot)}}, (e, a, o) => {
  const r = spawnSync(e, a, {...o, encoding: 'utf8'}); if (r.status !== 0) throw new Error('node failed'); return r; }, {PATH: process.env.PATH}); }
catch (error) { process.stdout.write(error.message); }`;
    const parent = spawnSync(process.execPath, ['--input-type=module', '-e', harness], { encoding: 'utf8' });
    assert.equal(parent.stdout, 'node failed');
    assert.match(parent.stderr, /CODEX_IMAGE_ONLY_PATCH_VERSION mismatch/);
});

test('empty or non-JSON builder output fails with a stable code instead of a bare SyntaxError', () => {
    for (const stdout of ['', 'not json\n', 'null\n', undefined]) {
        assert.throws(() => buildInstalledCandidateArtifact('client', { sourceRoot: '/x' }, () => ({ stdout })),
            error => error.code === 'candidate_build_output_invalid' && !(error instanceof SyntaxError));
    }
});

test('stderr tail is bounded and redacts secret-looking values', () => {
    // Assembled at runtime so the export leak gate never sees a token-shaped literal.
    const fakeGithubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
    const fakeAnthropicKey = ['sk', 'ant', '0123456789abcdef'].join('-');
    const noisy = `${'x'.repeat(10000)}\nGITHUB_TOKEN=${fakeGithubToken} password: hunter2 `
        + `Authorization: Bearer abc.def https://u:pw@host/x ${fakeAnthropicKey}\nREASON_KEPT\n`;
    const tail = sanitizedStderrTail(noisy);
    assert.ok(tail.length <= 4096);
    assert.match(tail, /REASON_KEPT/);
    for (const secret of [fakeGithubToken, 'hunter2', 'abc.def', 'u:pw@', fakeAnthropicKey]) {
        assert.ok(!tail.includes(secret), secret.slice(0, 3));
    }
    assert.equal(sanitizedStderrTail(undefined), '');
});

test('stderr tail redacts fine-grained GitHub, GitLab, AWS and Slack tokens', () => {
    // Assembled at runtime so the export leak gate never sees a token-shaped literal.
    const secrets = [
        ['github', 'pat', '11ABCDEFG0123456789_abcdefghij'].join('_'),
        ['glpat', 'abcdefghij0123456789'].join('-'),
        ['AKIA', 'ABCDEFGHIJ012345'].join(''),
        ['xoxb', '123456789012', 'abcdefghijkl'].join('-'),
        ['xoxp', '123456789012', 'abcdefghijkl'].join('-'),
    ];
    const tail = sanitizedStderrTail(`failed: ${secrets.join(' ')}\nREASON_KEPT\n`);
    assert.match(tail, /REASON_KEPT/);
    for (const secret of secrets) assert.ok(!tail.includes(secret), secret.slice(0, 5));
});
