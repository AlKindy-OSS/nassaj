/**
 * Owner-readable reason for a failed pre-action gate (activation defect 2026-09-29).
 *
 * A gate exit 2 used to be recorded as a bare `gate_failed:2`, so the owner could
 * not tell a missing workflow root from a missing `node`. The gate script writes
 * its log to stderr (`<ts> [LEVEL] message`); the LAST non-empty line is the
 * reason it stopped. This keeps a bounded tail while the gate runs and reduces it
 * to one sanitized, capped line: control characters and the timestamp/level prefix
 * are removed, absolute paths keep only their last segment (no home layout reaches
 * the record or the response), and the result never exceeds GATE_REASON_MAX_LEN.
 */

export const GATE_STDERR_TAIL_BYTES = 4096;
export const GATE_REASON_MAX_LEN = 200;

/**
 * Append a stderr chunk to a bounded tail buffer.
 * @param {string} tail current tail
 * @param {Buffer|string} chunk new data
 * @returns {string} the last GATE_STDERR_TAIL_BYTES characters
 */
export function appendGateStderr(tail, chunk) {
    const next = tail + String(chunk);
    return next.length > GATE_STDERR_TAIL_BYTES ? next.slice(-GATE_STDERR_TAIL_BYTES) : next;
}

/**
 * Reduce a stderr tail to one sanitized, capped line, or null when nothing usable remains.
 * @param {string} tail
 * @returns {string|null}
 */
export function gateReasonFromStderr(tail) {
    if (typeof tail !== 'string' || tail.length === 0) return null;
    const lines = tail.split(/\r?\n/)
        .map((line) => line
            .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
            .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
            .replace(/^\s*\S+\s+\[[A-Z]+\]\s*/, '')
            .replace(/(?:\/[^\s/'"]+)+\/([^\s/'"]+)/g, '…/$1')
            .replace(/\s+/g, ' ')
            .trim())
        .filter(Boolean);
    const last = lines.pop();
    if (!last) return null;
    return last.length > GATE_REASON_MAX_LEN ? `${last.slice(0, GATE_REASON_MAX_LEN - 1)}…` : last;
}
