/**
 * Per-file manifest and glibc floor of a staged generation (ADR-174 §6.3, §7.3).
 *
 * The file manifest lists every archived entry with its normalised mode and,
 * for files, size and sha256. It is written into the generation as
 * `GENERATION_FILES.json` (not listing itself); its sha256 is
 * `manifest.targets[].fileManifestSha256`.
 *
 * The glibc floor is the highest `GLIBC_2.x` version string found in any ELF
 * file of the generation built for the target machine (addons, bundled Node,
 * bundled binaries); ELF files for another machine (prebuilds a package
 * carries for other CPUs) are listed but never raise the floor. Version
 * strings in `.gnu.version_r` are what the dynamic loader requires, so the
 * byte scan is a conservative (never lower) reading of the real floor.
 */
import fs from 'node:fs';
import { hashFile } from './release-digests.mjs';
import { canonicalJson } from './strict-shape.mjs';

export const GENERATION_FILES_NAME = 'GENERATION_FILES.json';
export const GENERATION_FILES_SCHEMA = 'nassaj-generation-files/v1';
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
/** ELF e_machine per release target (EM_X86_64, EM_AARCH64). */
export const TARGET_ELF_MACHINE = Object.freeze({ 'linux-x64-glibc': 62, 'linux-arm64-glibc': 183 });
const GLIBC_VERSION = /GLIBC_2\.(\d{1,3})(?:\.\d{1,3})?(?![\d.])/g;

/**
 * Build the canonical file-manifest bytes for archive entries.
 * @param {{path: string, type: string, mode: number, size: number, absolute: string}[]} entries
 * @returns {{bytes: Buffer, files: object[]}}
 */
export function buildFileManifest(entries) {
    const files = entries.map(entry => (entry.type === 'dir'
        ? { path: entry.path, type: 'dir', mode: entry.mode }
        : { path: entry.path, type: 'file', mode: entry.mode, ...hashFile(entry.absolute) }));
    const document = { schema: GENERATION_FILES_SCHEMA, files };
    return { bytes: Buffer.from(`${canonicalJson(document)}\n`, 'utf8'), files };
}

/**
 * Highest glibc minor version referenced by one buffer, or -1.
 * @param {Buffer} bytes
 * @returns {number}
 */
export function maxGlibcMinor(bytes) {
    let max = -1;
    for (const match of bytes.toString('latin1').matchAll(GLIBC_VERSION)) max = Math.max(max, Number(match[1]));
    return max;
}

/**
 * ELF e_machine of a file, or null when it is not ELF. e_machine sits at
 * offset 18 in the byte order named by EI_DATA (1 little, 2 big endian).
 * @param {string} file
 * @returns {number|null}
 */
export function elfMachine(file) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const head = Buffer.alloc(20);
        if (fs.readSync(fd, head, 0, 20, 0) !== 20 || !head.subarray(0, 4).equals(ELF_MAGIC)) return null;
        if (head[5] === 1) return head.readUInt16LE(18);
        return head[5] === 2 ? head.readUInt16BE(18) : null;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Compute the generation glibc floor over every ELF file for the target machine.
 * @param {{path: string, type: string, absolute: string}[]} entries
 * @param {{target: string}} options release target
 * @returns {{floor: string|null, elfFiles: {path: string, glibc: string|null}[],
 *   foreignElfFiles: {path: string, machine: number}[]}}
 */
export function computeGlibcFloor(entries, { target } = {}) {
    const machine = TARGET_ELF_MACHINE[target];
    if (!machine) throw new TypeError(`computeGlibcFloor: unknown target ${target}`);
    const elfFiles = [];
    const foreignElfFiles = [];
    let max = -1;
    for (const entry of entries) {
        const found = entry.type === 'file' ? elfMachine(entry.absolute) : null;
        if (found === null) continue;
        if (found !== machine) { foreignElfFiles.push({ path: entry.path, machine: found }); continue; }
        const minor = maxGlibcMinor(fs.readFileSync(entry.absolute));
        elfFiles.push({ path: entry.path, glibc: minor < 0 ? null : `2.${minor}` });
        max = Math.max(max, minor);
    }
    return { floor: max < 0 ? null : `2.${max}`, elfFiles, foreignElfFiles };
}

/**
 * Compare two `2.x` floors; true when `floor` exceeds `limit`.
 * @param {string} floor
 * @param {string} limit
 * @returns {boolean}
 */
export function glibcExceeds(floor, limit) {
    return Number(floor.split('.')[1]) > Number(limit.split('.')[1]);
}
