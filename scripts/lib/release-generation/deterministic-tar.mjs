/**
 * Deterministic tar.gz writer for release generations (ADR-174 §9.1, §9.4).
 *
 * The same directory tree always yields the same archive bytes under the
 * same zlib: entries sorted by path (byte order), fixed mtime, uid/gid 0, no
 * user or group names, normalised modes (directories 0755, files 0755 when
 * any execute bit is set, else 0644). Only directories and regular files are
 * written; a symlink or any other file type fails the build, so the node-side
 * extractor never has to reason about links. Long or non-ASCII paths use a
 * PAX `path` record. Memory stays bounded: file bytes are streamed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const BLOCK = 512;
const READ_CHUNK = 1024 * 1024;
const USTAR_NAME_MAX = 100;
const MAX_SIZE = 8 ** 11 - 1;

/**
 * Walk `root` and return every entry below it, sorted by path bytes.
 * @param {string} root directory to archive
 * @returns {{path: string, type: 'dir'|'file', mode: number, size: number, absolute: string}[]}
 */
export function collectTreeEntries(root) {
    const entries = [];
    walk(path.resolve(root), '', entries);
    return entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function walk(absoluteDir, relativeDir, entries) {
    for (const name of fs.readdirSync(absoluteDir)) {
        const absolute = path.join(absoluteDir, name);
        const relative = relativeDir ? `${relativeDir}/${name}` : name;
        const stat = fs.lstatSync(absolute);
        if (stat.isDirectory()) {
            entries.push({ path: relative, type: 'dir', mode: 0o755, size: 0, absolute });
            walk(absolute, relative, entries);
        } else if (stat.isFile()) {
            entries.push({ path: relative, type: 'file', mode: normaliseFileMode(stat.mode), size: stat.size, absolute });
        } else {
            throw new Error(`generation_entry_unsupported: ${relative} is not a regular file or directory`);
        }
    }
}

/**
 * 0755 when any execute bit is set, else 0644.
 * @param {number} mode st_mode
 * @returns {number}
 */
export function normaliseFileMode(mode) {
    return mode & 0o111 ? 0o755 : 0o644;
}

function octal(value, width) {
    return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function needsPax(name) {
    return Buffer.byteLength(name) > USTAR_NAME_MAX || !/^[\x20-\x7e]*$/.test(name);
}

/**
 * One 512-byte ustar header.
 * @param {{name: string, mode: number, size: number, typeflag: string, mtime: number}} fields
 * @returns {Buffer}
 */
export function ustarHeader({ name, mode, size, typeflag, mtime }) {
    if (size > MAX_SIZE) throw new Error(`generation_entry_too_large: ${name}`);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, USTAR_NAME_MAX, 'utf8');
    header.write(octal(mode, 8), 100, 'ascii');
    header.write(octal(0, 8), 108, 'ascii');
    header.write(octal(0, 8), 116, 'ascii');
    header.write(octal(size, 12), 124, 'ascii');
    header.write(octal(mtime, 12), 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write(typeflag, 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return header;
}

/**
 * A PAX extended-header record `"<len> path=<value>\n"` (length counts itself).
 * @param {string} key
 * @param {string} value
 * @returns {Buffer}
 */
export function paxRecord(key, value) {
    const body = ` ${key}=${value}\n`;
    const base = Buffer.byteLength(body);
    let total = base + String(base).length;
    if (String(total).length > String(base).length) total = base + String(total).length;
    return Buffer.from(`${total}${body}`, 'utf8');
}

function padding(size) {
    const rest = size % BLOCK;
    return rest === 0 ? null : Buffer.alloc(BLOCK - rest);
}

function* entryHeaders(entry, mtime) {
    const name = entry.type === 'dir' ? `${entry.path}/` : entry.path;
    const typeflag = entry.type === 'dir' ? '5' : '0';
    if (needsPax(name)) {
        const record = paxRecord('path', name);
        yield ustarHeader({ name: 'PaxHeader', mode: 0o644, size: record.length, typeflag: 'x', mtime });
        yield record;
        const pad = padding(record.length);
        if (pad) yield pad;
    }
    const shortName = needsPax(name) ? name.replace(/[^\x20-\x7e]/g, '_').slice(-USTAR_NAME_MAX) : name;
    yield ustarHeader({ name: shortName, mode: entry.mode, size: entry.type === 'file' ? entry.size : 0, typeflag, mtime });
}

async function* fileChunks(entry) {
    const handle = await fs.promises.open(entry.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        let remaining = entry.size;
        while (remaining > 0) {
            const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, remaining));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) throw new Error(`generation_entry_changed: ${entry.path} shrank while archiving`);
            remaining -= bytesRead;
            yield buffer.subarray(0, bytesRead);
        }
    } finally {
        await handle.close();
    }
}

async function* tarStream(entries, mtime) {
    for (const entry of entries) {
        yield* entryHeaders(entry, mtime);
        if (entry.type !== 'file') continue;
        yield* fileChunks(entry);
        const pad = padding(entry.size);
        if (pad) yield pad;
    }
    yield Buffer.alloc(BLOCK * 2);
}

/**
 * Write `root` as a deterministic tar.gz at `outputFile`.
 * @param {object} input
 * @param {string} input.root directory to archive (its contents become the archive root)
 * @param {string} input.outputFile destination (must not exist)
 * @param {number} [input.mtime] fixed mtime in seconds (default 0)
 * @param {number} [input.level] gzip level (default 9)
 * @returns {Promise<{entries: object[]}>} the archived entries in order
 */
export async function writeDeterministicTarGz({ root, outputFile, mtime = 0, level = 9 }) {
    const entries = collectTreeEntries(root);
    await pipeline(
        Readable.from(tarStream(entries, mtime)),
        createGzip({ level }),
        fs.createWriteStream(outputFile, { flags: 'wx', mode: 0o644 }),
    );
    return { entries };
}
