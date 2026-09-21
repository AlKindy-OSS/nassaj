/** Actual npm12 lifecycle behavior using local tarballs; no registry or live installation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const tooling = process.env.NASSAJ_TEST_NPM12_TOOLING;
const root = path.resolve(import.meta.dirname, '../..');

function command(executable, args, options) {
    const result = spawnSync(executable, args, { ...options, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function tarball(scratch, version) {
    const base = path.join(scratch, `fixture-${version}`), pkg = path.join(base, 'package');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'nassaj-policy-fixture', version,
        scripts: { install: 'node install.cjs' } }));
    fs.writeFileSync(path.join(pkg, 'install.cjs'),
        "require('node:fs').writeFileSync('ran.json',JSON.stringify({version:require('./package.json').version,node:process.version}));");
    const destination = path.join(scratch, `fixture-${version}.tgz`);
    const result = command('/usr/bin/tar', ['-czf', destination, '-C', base, 'package'], { cwd: scratch });
    assert.equal(result.status, 0, result.stderr);
    return destination;
}

test('npm12 honors changed release approvals over stale user pins and refuses unreviewed scripts',
    { skip: !tooling, timeout: 180_000 }, async t => {
        assert.ok(fs.realpathSync(tooling).startsWith(`${root}/.artifacts/`));
        const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'npm12-policy-'));
        t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
        const node = path.join(tooling, 'usr/bin/node'), npm = path.join(tooling, 'usr/lib/node_modules/npm/bin/npm-cli.js');
        const userconfig = path.join(scratch, 'user.npmrc'), cache = path.join(scratch, 'cache');
        fs.writeFileSync(userconfig, 'allow-scripts=nassaj-policy-fixture@1.0.0\n', { mode: 0o600 });
        const env = { PATH: `${path.join(tooling, 'usr/bin')}:/usr/bin:/bin`, HOME: process.env.HOME,
            TMPDIR: scratch, LANG: 'C.UTF-8', NO_UPDATE_NOTIFIER: '1' };
        const version = command(node, [npm, '--version'], { cwd: scratch, env });
        assert.equal(version.status, 0, version.stderr); assert.match(version.stdout.trim(), /^12\./);
        const packages = Object.fromEntries(['1.0.0', '2.0.0'].map(value => [value, tarball(scratch, value)]));
        const registryProgram = path.join(scratch, 'registry.cjs');
        fs.writeFileSync(registryProgram, `const http=require('node:http'),fs=require('node:fs');
const tarballs=JSON.parse(process.argv[2]),integrities=JSON.parse(process.argv[3]);
const server=http.createServer((req,res)=>{
 const host='http://127.0.0.1:'+server.address().port;
 if(req.url==='/nassaj-policy-fixture'){
  const versions=Object.fromEntries(Object.keys(tarballs).map(version=>[version,{name:'nassaj-policy-fixture',version,scripts:{install:'node install.cjs'},dist:{tarball:host+'/nassaj-policy-fixture/-/nassaj-policy-fixture-'+version+'.tgz',integrity:integrities[version]}}]));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({name:'nassaj-policy-fixture',versions,'dist-tags':{latest:'2.0.0'}}));return;
 }
 const match=req.url.match(/^\\/nassaj-policy-fixture\\/-\\/nassaj-policy-fixture-(1\\.0\\.0|2\\.0\\.0)\\.tgz$/);
 if(match){res.setHeader('content-type','application/octet-stream');fs.createReadStream(tarballs[match[1]]).pipe(res);return}
 res.statusCode=404;res.end();
});server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));`);
        const integrities = Object.fromEntries(Object.entries(packages).map(([version, file]) =>
            [version, `sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`]));
        const registry = spawn(node, [registryProgram, JSON.stringify(packages), JSON.stringify(integrities)], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
        t.after(async () => { if (registry.exitCode === null) await new Promise(resolve => { registry.once('exit', resolve); registry.kill('SIGTERM'); }); });
        const port = await new Promise((resolve, reject) => {
            registry.once('error', reject); registry.once('exit', code => reject(new Error(`fixture registry exited: ${code}`)));
            registry.stdout.once('data', value => resolve(Number(String(value).trim())));
        });
        assert.ok(Number.isInteger(port) && port > 0);
        const registryUrl = `http://127.0.0.1:${port}`;
        const report = [];
        for (const scenario of [
            { name: 'initial', version: '1.0.0', approvals: { 'nassaj-policy-fixture@1.0.0': true }, runs: true },
            { name: 'upgrade', version: '2.0.0', approvals: { 'nassaj-policy-fixture@2.0.0': true }, runs: true },
            { name: 'unreviewed', version: '2.0.0', approvals: { 'nassaj-policy-fixture@1.0.0': true }, runs: false, blocked: true },
            { name: 'denied', version: '2.0.0', approvals: { 'nassaj-policy-fixture@2.0.0': false }, runs: false },
        ]) {
            const cwd = path.join(scratch, scenario.name); fs.mkdirSync(cwd);
            const pkg = JSON.stringify({ name: `fixture-${scenario.name}`, version: '1.0.0', private: true,
                dependencies: { 'nassaj-policy-fixture': scenario.version }, allowScripts: scenario.approvals });
            fs.writeFileSync(path.join(cwd, 'package.json'), pkg);
            const flags = ['--no-audit', '--no-fund', '--userconfig', userconfig, '--cache', cache, '--registry', registryUrl];
            const lock = command(node, [npm, 'install', '--package-lock-only', '--ignore-scripts', ...flags], { cwd, env });
            assert.equal(lock.status, 0, lock.stderr);
            const lockBefore = fs.readFileSync(path.join(cwd, 'package-lock.json'));
            const cached = command(node, [npm, 'cache', 'add', `nassaj-policy-fixture@${scenario.version}`, ...flags], { cwd, env });
            assert.equal(cached.status, 0, cached.stderr);
            const installed = command(node, [npm, 'ci', '--include=dev', '--offline', ...flags], { cwd, env });
            assert.equal(installed.status, 0, installed.stderr);
            if (scenario.blocked) assert.match(installed.stderr, /install scripts blocked/);
            const marker = path.join(cwd, 'node_modules/nassaj-policy-fixture/ran.json');
            assert.equal(fs.existsSync(marker), scenario.runs, installed.stderr);
            if (scenario.runs) assert.equal(JSON.parse(fs.readFileSync(marker)).version, scenario.version);
            assert.deepEqual(fs.readFileSync(path.join(cwd, 'package-lock.json')), lockBefore);
            assert.equal(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'), pkg);
            report.push({ scenario: scenario.name, npmStatus: installed.status, scriptRan: scenario.runs, packageAndLockUnchanged: true });
        }
        assert.equal(fs.readFileSync(userconfig, 'utf8'), 'allow-scripts=nassaj-policy-fixture@1.0.0\n');
        t.diagnostic(JSON.stringify({ npm: version.stdout.trim(), staleUserPinsUnchanged: true, report }));
    });
