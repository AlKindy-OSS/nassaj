/**
 * Pure verdict of the local-engine header-echo proof (T-2098 qa item 3), shared
 * by scripts/prove-claude-local-engine.mjs and its test.
 */

/**
 * Reads the node:test summary. Proven only when the run exited 0 with at least
 * one pass, no failure and NO skip (a skip means the proof did not run).
 * @param {string} output combined runner output
 * @param {number|null} status runner exit status
 * @returns {{ proven: boolean, pass: number }}
 */
export function evaluateProbeOutput(output, status) {
  const count = (label) => {
    const match = new RegExp(`^ℹ ${label} (\\d+)$`, 'mu').exec(output);
    return match ? Number(match[1]) : null;
  };
  const pass = count('pass');
  const fail = count('fail');
  const skipped = count('skipped');
  const proven = status === 0 && pass !== null && pass > 0 && fail === 0 && skipped === 0;
  return { proven, pass: pass ?? 0 };
}
