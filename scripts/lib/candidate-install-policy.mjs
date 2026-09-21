/** Reviewed release-owned lifecycle policy; no credentials are serialized into identities. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalTripleJson } from './oid-triple-target.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const matches = (values, current) => !Array.isArray(values) || ((!values.some(value => !value.startsWith('!'))
    || values.includes(current)) && !values.includes(`!${current}`));

/** Require exact approvals for every applicable lockfile lifecycle package and reject broad approvals. */
export function validateInstallScriptInventory(pkg, lock, runtime = process) {
    const policy = pkg.allowScripts;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('candidate_install_policy_missing');
    for (const [name, allowed] of Object.entries(policy)) {
        if (!/^(?:@[^/@\s]+\/)?[^/@\s]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(name)
            || typeof allowed !== 'boolean') fail('candidate_install_policy_not_exact');
    }
    if (!lock.packages || typeof lock.packages !== 'object') fail('candidate_install_lock_invalid');
    const applicable = [], excluded = [];
    for (const [location, entry] of Object.entries(lock.packages)) {
        if (!location || entry.hasInstallScript !== true) continue;
        const name = entry.name || location.split('node_modules/').at(-1);
        const identity = `${name}@${entry.version}`;
        if (!matches(entry.os, runtime.platform) || !matches(entry.cpu, runtime.arch)) { excluded.push(identity); continue; }
        if (!Object.hasOwn(policy, identity)) fail('candidate_install_script_unreviewed');
        applicable.push({ identity, allowed: policy[identity] });
    }
    return { source: 'package.json#allowScripts', policy: Object.fromEntries(Object.entries(policy).sort()),
        applicable: applicable.sort((a, b) => a.identity.localeCompare(b.identity)), excluded: excluded.sort() };
}

function resolveExecutable(name, env) {
    for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const file = path.resolve(directory, name);
        try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch { /* Try next PATH entry. */ }
    }
    fail('candidate_install_executable_missing');
}

function publicRegistry(value) {
    let url;
    try { url = new URL(value); } catch { fail('candidate_install_registry_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('candidate_install_registry_invalid');
    return url.href;
}

/** Inspect effective npm settings and pin the actual Node/npm executables before any lifecycle script. */
export function inspectCandidateInstallPolicy(sourceRoot, run, env) {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package-lock.json')));
    const inventory = validateInstallScriptInventory(pkg, lock);
    const npmCli = resolveExecutable('npm', env), node = resolveExecutable('node', env);
    if (node !== fs.realpathSync(process.execPath)) fail('candidate_install_node_runtime_conflict');
    const version = String(run(npmCli, ['--version'], { cwd: sourceRoot, env }).stdout).trim();
    if (!/^(?:1[2-9]|[2-9]\d)\.\d+\.\d+$/.test(version)
        && !/^11\.(?:1[6-9]|[2-9]\d)\.\d+$/.test(version)) fail('candidate_install_npm_policy_unsupported');
    const get = key => String(run(npmCli, ['config', 'get', key], { cwd: sourceRoot, env }).stdout).trim();
    for (const key of ['ignore-scripts', 'dangerously-allow-all-scripts', 'strict-allow-scripts']) {
        if (get(key) !== 'false') fail('candidate_install_npm_config_conflict');
    }
    const replaceRegistryHost = get('replace-registry-host');
    if (!/^(?:npmjs|never|[a-z0-9.-]+(?::\d+)?)$/.test(replaceRegistryHost)) fail('candidate_install_registry_rewrite_invalid');
    const facts = JSON.parse(run(node, ['-p', 'JSON.stringify({nodeVersion:process.version,nodeModuleAbi:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})'], { cwd: sourceRoot, env }).stdout);
    if (facts.nodeVersion !== process.version || facts.nodeModuleAbi !== process.versions.modules
        || facts.platform !== process.platform || facts.arch !== process.arch) fail('candidate_install_node_runtime_conflict');
    const installRuntime = { ...facts, npmVersion: version, nodeBinarySha256: digest(fs.readFileSync(node)), npmCliSha256: digest(fs.readFileSync(npmCli)) };
    const policy = { ...inventory, registry: publicRegistry(get('registry')), replaceRegistryHost };
    return { installRuntime, installPolicy: policy, installPolicySha256: digest(canonicalTripleJson(policy)),
        executablePaths: { node, npmCli } };
}
