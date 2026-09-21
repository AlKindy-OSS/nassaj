/** Deterministic filesystem identity shared by candidate builds and runtime activation. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function realDirectory(directory, label) {
    const resolved = realpathSync(directory);
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
    return resolved;
}

/** Aggregate a deterministic identity without writing a giant per-file manifest. */
export function hashTree(directory) {
    const root = realDirectory(directory, 'Candidate tree');
    const records = [];
    function walk(current) {
        for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(current, entry.name);
            const relative = path.relative(root, full).split(path.sep).join('/');
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                const metadata = lstatSync(full);
                records.push([relative, `file:${metadata.mode & 0o777}:${metadata.size}`, sha256(readFileSync(full))]);
            }
            else if (entry.isSymbolicLink()) {
                const link = readlinkSync(full);
                const target = path.resolve(path.dirname(full), link);
                if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Candidate symlink escapes its tree: ${relative}`);
                const metadata = lstatSync(full);
                records.push([relative, `link:${metadata.mode & 0o777}:${metadata.size}`, link]);
            } else throw new Error(`Candidate tree contains a special file: ${relative}`);
        }
    }
    walk(root);
    const hash = createHash('sha256');
    for (const record of records) for (const value of record) hash.update(String(value)).update('\0');
    return { sha256: hash.digest('hex'), files: records.length };
}
