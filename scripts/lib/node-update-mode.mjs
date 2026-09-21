/** Trusted service/environment mode for ordinary build/publish entry points. */
import fs from 'node:fs';
import path from 'node:path';

/** Resolve only the fixed mode key; never source a shell file or expose other environment values. */
export function resolveNodeUpdateMode(root, env = process.env) {
    let value = env.NASSAJ_UPDATE_MODE;
    if (value === undefined) {
        const file = path.join(root, '.env');
        let fd;
        try {
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            if (!fs.fstatSync(fd).isFile()) throw new Error('node_update_mode_file_unsafe');
            const lines = fs.readFileSync(fd, 'utf8').split('\n').filter(row => /^\s*(?:export\s+)?NASSAJ_UPDATE_MODE(?:\s|=|$)/.test(row));
            if (lines.length > 1) throw new Error('local_update_duplicate_mode');
            const line = lines[0];
            if (line && !/^\s*(?:export\s+)?NASSAJ_UPDATE_MODE\s*=/.test(line)) throw new Error('local_update_invalid_mode');
            value = line?.slice(line.indexOf('=') + 1).trim();
            if (value && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    const mode = value === undefined ? 'release' : value;
    if (!['release', 'local-main'].includes(mode)) throw new Error('local_update_invalid_mode');
    return mode;
}

/** Local-main publication belongs exclusively to the paired capsule, not legacy publishers/watchers. */
export function assertLegacyNodePublication(root, env = process.env) {
    if (resolveNodeUpdateMode(root, env) === 'local-main') throw new Error('local_update_button_required');
}

/** Standalone publication is disabled on every node; button jobs use their own existing authority. */
export function assertStandaloneNodePublication(root, env = process.env) {
    resolveNodeUpdateMode(root, env);
    throw new Error('node_update_button_required');
}

/** Resolve the service mode and reject a caller override that would change its authority. */
export function resolveConsumerUpdateMode(root, requestedMode) {
    const mode = resolveNodeUpdateMode(root);
    if (requestedMode !== undefined && requestedMode !== mode) throw new Error('node_update_mode_override_refused');
    return mode;
}
