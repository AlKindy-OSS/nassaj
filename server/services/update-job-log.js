/**
 * Live terminal log of an update job (T-1768, ADR-156). The owner watches what
 * the updater runs — git, npm ci, the candidate build, the restart gate — the way
 * a distribution installer shows its console under the progress screen.
 *
 * One append-only file per job, 0600 under the update control root, so the log
 * survives the restart that activates the release. Every byte is sanitized
 * before it is written: credentials and tokens are redacted and the install root
 * collapses to `.`, so the file is safe to hand to the owner's browser as is.
 * Logging never fails an update: every write error is swallowed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const UPDATE_JOB_LOG_CAP_BYTES = 2 * 1024 * 1024;
export const UPDATE_JOB_LOG_READ_CHUNK = 64 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const TRUNCATED_MARKER = '\n[… log size limit reached; later output is not recorded]\n';

/** Redact secrets and the install root from one piece of command output. */
export function sanitizeUpdateLogText(raw, { appRoot = null } = {}) {
    let out = String(raw ?? '').replace(ANSI, '');
    if (appRoot) out = out.split(appRoot).join('.');
    return out
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL, '')
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key redacted]')
        // The scheme is bounded: an unbounded `[\w+.-]*` backtracks quadratically
        // over a long run of word characters, and build output has those.
        .replace(/\b([a-zA-Z][\w+.-]{0,31}:\/\/)[^/\s@]{1,512}@/g, '$1')
        .replace(/((?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|passwd|secret|authorization)"?\s*[=:]\s*(?:bearer\s+)?"?)[^\s"',]+/gi, '$1…')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '…');
}

/** Back `end` off so a chunk never splits a UTF-8 character; may return `start`. */
function utf8Boundary(buffer, start, end) {
    let lead = end - 1;
    while (lead > start && (buffer[lead] & 0xC0) === 0x80) lead -= 1;
    // ASCII (or no lead byte in range): `end` already sits on a boundary.
    if (lead < start || buffer[lead] < 0xC0) return end;
    const width = buffer[lead] >= 0xF0 ? 4 : buffer[lead] >= 0xE0 ? 3 : 2;
    // Keep the last character only when all of its bytes fit before `end`.
    return lead + width <= end ? end : lead;
}

/**
 * @param {{ root: string|null, appRoot?: string|null, now?: () => number }} options
 */
export function createUpdateJobLog({ root, appRoot = null, now = Date.now } = {}) {
    const fileFor = (jobId) => {
        if (!root || typeof jobId !== 'string' || !SAFE_ID.test(jobId)) return null;
        return path.join(root, `${jobId}.log`);
    };

    const append = (jobId, raw) => {
        const file = fileFor(jobId);
        if (!file) return;
        try {
            const text = sanitizeUpdateLogText(raw, { appRoot });
            if (!text) return;
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
            let size = 0;
            try { size = fs.statSync(file).size; } catch { size = 0; }
            // The marker's bytes are reserved inside the cap, so writing it can
            // never push the file past the cap, and once written nothing follows.
            const dataCap = UPDATE_JOB_LOG_CAP_BYTES - Buffer.byteLength(TRUNCATED_MARKER);
            if (size >= dataCap) return;
            let bytes = Buffer.from(text, 'utf8');
            if (size + bytes.length > dataCap) {
                const room = dataCap - size;
                bytes = Buffer.concat([bytes.subarray(0, utf8Boundary(bytes, 0, room)), Buffer.from(TRUNCATED_MARKER)]);
            }
            const fd = fs.openSync(file, 'a', 0o600);
            try { fs.writeSync(fd, bytes); } finally { fs.closeSync(fd); }
        } catch { /* the log is a window onto the update, never a reason it fails */ }
    };

    /** One timestamped status line (UTC clock time), e.g. `[09:14:03] ▸ staging`. */
    const line = (jobId, message) => {
        const stamp = new Date(now()).toISOString().slice(11, 19);
        append(jobId, `[${stamp}] ${message}\n`);
    };

    /**
     * Read from a byte offset. Returns whole lines when it can, so a poller that
     * resumes from `offset` never renders half a line or half a character.
     */
    const read = (jobId, offset = 0) => {
        const file = fileFor(jobId);
        if (!file) return { offset: 0, size: 0, text: '' };
        let fd;
        try { fd = fs.openSync(file, 'r'); } catch { return { offset: 0, size: 0, text: '' }; }
        try {
            const { size } = fs.fstatSync(fd);
            const start = Number.isSafeInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
            const length = Math.min(UPDATE_JOB_LOG_READ_CHUNK, size - start);
            if (length <= 0) return { offset: start, size, text: '' };
            const buffer = Buffer.alloc(length);
            const got = fs.readSync(fd, buffer, 0, length, start);
            let end = got;
            if (start + got < size) {
                const newline = buffer.lastIndexOf(0x0A, got - 1);
                // A line longer than the chunk is cut on a character boundary.
                end = newline >= 0 ? newline + 1 : (utf8Boundary(buffer, 0, got) || got);
            }
            return { offset: start + end, size, text: buffer.subarray(0, end).toString('utf8') };
        } finally {
            fs.closeSync(fd);
        }
    };

    return Object.freeze({ append, line, read, fileFor });
}
