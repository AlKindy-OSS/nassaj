/** Build-time-only bundling: the resulting control executable contains only Node built-ins. */
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Keep the authored module graph separate from the committed standalone bridge.
// Nodes running the pre-bundler updater (<= 1.47.0.19) read
// scripts/oid-control-capsule.mjs byte-for-byte and reject relative imports, so
// every release must carry that generated compatibility entry as built-ins only.
const ENTRY = 'scripts/oid-control-capsule.source.mjs';
export const OID_CONTROL_COMPAT_ENTRY = 'scripts/oid-control-capsule.mjs';
const ALLOWED = [ENTRY, 'scripts/lib/local-update-policy.mjs', 'scripts/git-control-root.mjs', 'scripts/lib/client-publication-policy.mjs', 'scripts/lib/pm2-service-owner.mjs', 'scripts/lib/pm2-codec-builtins.mjs', 'scripts/lib/pm2-existing-transport.mjs',
    'scripts/lib/release-runtime-forward-child-protocol.mjs',
    'scripts/vendor/pm2-codec/amp-message/index.js', 'scripts/vendor/pm2-codec/amp/index.js',
    'scripts/vendor/pm2-codec/amp/lib/encode.js', 'scripts/vendor/pm2-codec/amp/lib/decode.js', 'scripts/vendor/pm2-codec/amp/lib/stream.js', 'scripts/lib/dependency-tree-identity-v2.mjs',
    'scripts/lib/oid-triple-target.mjs', 'scripts/lib/local-source-bootstrap-ticket.mjs', 'scripts/lib/update-generation-reconciliation.mjs',
    'scripts/lib/oid-dependency-candidate.mjs', 'scripts/lib/client-publication-artifacts.mjs',
    'scripts/lib/client-publication-journal.mjs', 'scripts/lib/client-publication-lineage.mjs', 'scripts/lib/client-publication-archive.mjs', 'scripts/lib/client-publication-baseline.mjs'];

/** Bundle only the reviewed control closure; record every original input's bytes. */
export function bundleOidControlCapsule(sourceRoot, verifyClosure) {
    const root = fs.realpathSync(sourceRoot);
    const authoredPath = path.join(root, ENTRY);
    if (!fs.existsSync(authoredPath)) {
        const compatibilityBytes = fs.readFileSync(path.join(root, OID_CONTROL_COMPAT_ENTRY));
        verifyClosure(compatibilityBytes);
        return { bytes: compatibilityBytes, sources: null };
    }
    const entry = fs.readFileSync(authoredPath);
    const result = buildSync({ absWorkingDir: root, entryPoints: [ENTRY], bundle: true, write: false,
        format: 'esm', platform: 'node', target: 'node24', packages: 'external', metafile: true,
        alias: { amp: path.join(root, 'scripts/vendor/pm2-codec/amp/index.js'),
            util: path.join(root, 'scripts/lib/pm2-codec-builtins.mjs'), stream: path.join(root, 'scripts/lib/pm2-codec-builtins.mjs') },
        legalComments: 'none', charset: 'utf8', logLevel: 'silent' });
    const sources = Object.keys(result.metafile.inputs).sort().map(name => {
        if (!ALLOWED.includes(name)) throw new Error('OID control bundle contains an unreviewed module.');
        const file = path.join(root, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('OID control bundle input is unsafe.');
        const bytes = fs.readFileSync(file);
        return { path: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    });
    const bytes = Buffer.from(result.outputFiles[0].contents);
    verifyClosure(bytes);
    return { bytes, sources };
}
