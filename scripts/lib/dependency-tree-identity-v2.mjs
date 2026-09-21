/** ADR-160 v2: relocation-stable dependency identity; historical v1 hashes are unchanged. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const reject = code => { throw Object.assign(new Error(code), { code }); };
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const relative = (root, target) => path.relative(root, target).split(path.sep).join('/') || '.';

function metadata(file, sealed, generationRoot = null, expectedOwnerUid = process.getuid?.()) {
    const stat = fs.lstatSync(file);
    if (stat.mode & 0o6000) reject('dependency_tree_privileged_mode');
    if (sealed && file === generationRoot) {
        if ((stat.mode & 0o777) !== 0o700 || stat.uid !== expectedOwnerUid) reject('dependency_tree_root_owner_mode');
    } else if (!stat.isSymbolicLink() && sealed && (stat.mode & 0o222)) reject('dependency_tree_writable');
    return stat;
}

const stableFields = ['dev', 'ino', 'nlink', 'size', 'mode', 'ctimeMs', 'mtimeMs'];
const sameMetadata = (left, right) => stableFields.every(key => left[key] === right[key]);
const inodeKey = stat => `${stat.dev}:${stat.ino}`;

function verifyInventory(entries) {
    const groups = new Map();
    for (const { file, stat } of entries) {
        if (!sameMetadata(stat, fs.lstatSync(file))) reject('dependency_tree_changed');
        if (!stat.isFile()) continue;
        const key = inodeKey(stat), group = groups.get(key) || [];
        group.push({ file, stat }); groups.set(key, group);
    }
    for (const group of groups.values()) {
        const { stat } = group[0];
        if (!Number.isSafeInteger(stat.nlink) || stat.nlink < 1 || group.length !== stat.nlink
            || new Set(group.map(entry => entry.file)).size !== stat.nlink
            || group.some(entry => !sameMetadata(stat, entry.stat))) reject('dependency_tree_shared_hardlink');
    }
}

function fileRecord(file, stat, name) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || !sameMetadata(before, stat)) reject('dependency_tree_changed');
        const hash = sha256(fs.readFileSync(fd)), after = fs.fstatSync(fd);
        if (!sameMetadata(before, after) || !sameMetadata(after, fs.lstatSync(file))) reject('dependency_tree_changed');
        return [name, 'file', after.mode & 0o777, after.size, hash];
    } finally { fs.closeSync(fd); }
}

function linkRecord(root, file, stat, name) {
    const text = fs.readlinkSync(file);
    if (path.isAbsolute(text)) reject('dependency_tree_absolute_link');
    if (!inside(root, path.resolve(path.dirname(file), text))) reject('dependency_tree_link_escape');
    let target;
    try { target = fs.realpathSync(file); } catch { reject('dependency_tree_unresolved_link'); }
    if (!inside(root, target)) reject('dependency_tree_link_escape');
    return [name, 'link', stat.mode & 0o777, text, relative(root, target)];
}

/** Hash modes, empty directories, bytes and resolved relative links without following directory links. */
function inventoryTree(directory, { requireSealed = false, expectedOwnerUid = process.getuid?.() } = {}) {
    const root = path.resolve(directory), rootStat = metadata(root, requireSealed, root, expectedOwnerUid);
    if (!rootStat.isDirectory() || fs.realpathSync(root) !== root) reject('dependency_tree_invalid_root');
    const records = [], entries = [], counts = { files: 0, directories: 0, links: 0, nativeFiles: 0 };
    function walk(file) {
        const stat = metadata(file, requireSealed, root, expectedOwnerUid), name = relative(root, file);
        entries.push({ file, stat });
        if (stat.isDirectory()) {
            counts.directories += 1;
            records.push([name, 'directory', stat.mode & 0o777]);
            for (const child of fs.readdirSync(file).sort()) walk(path.join(file, child));
        } else if (stat.isFile()) {
            counts.files += 1;
            if (name.endsWith('.node')) counts.nativeFiles += 1;
            records.push(fileRecord(file, stat, name));
        } else if (stat.isSymbolicLink()) {
            counts.links += 1;
            records.push(linkRecord(root, file, stat, name));
        } else reject('dependency_tree_special_file');
    }
    walk(root);
    verifyInventory(entries);
    return { entries, identity: { schema: 'nassaj-dependency-tree/v2', sha256: sha256(JSON.stringify(records)), ...counts } };
}

/** Hash per-path bytes and modes; accept hardlinks only when every alias is inside this tree. */
export function hashDependencyTreeV2(directory, options = {}) {
    return inventoryTree(directory, options).identity;
}

function pinInventory(entries, pinned) {
    for (const entry of entries) {
        if (entry.stat.isSymbolicLink()) continue;
        const key = inodeKey(entry.stat);
        if (!pinned.has(key)) {
            const fd = fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            pinned.set(key, { ...entry, fd, members: [] });
        }
        pinned.get(key).members.push(entry);
        if (!sameMetadata(entry.stat, fs.fstatSync(pinned.get(key).fd))) reject('dependency_tree_changed');
    }
    verifyInventory(entries);
    for (const { fd, stat } of pinned.values()) {
        if (!sameMetadata(stat, fs.fstatSync(fd))) reject('dependency_tree_changed');
    }
}

/** Seal each pinned inode once after closure validation; never chmod through mutable paths. */
export function sealDependencyTreeV2(directory) {
    const root = path.resolve(directory), { entries } = inventoryTree(root), pinned = new Map();
    try {
        pinInventory(entries, pinned);
        for (const { file, stat, fd, members } of [...pinned.values()].reverse()) {
            if (!sameMetadata(stat, fs.fstatSync(fd))
                || members.some(member => !sameMetadata(member.stat, fs.lstatSync(member.file)))) reject('dependency_tree_changed');
            fs.fchmodSync(fd, file === root ? 0o700 : stat.mode & 0o555);
            fs.fsyncSync(fd);
        }
        return hashDependencyTreeV2(root, { requireSealed: true });
    } finally { for (const { fd } of pinned.values()) fs.closeSync(fd); }
}
