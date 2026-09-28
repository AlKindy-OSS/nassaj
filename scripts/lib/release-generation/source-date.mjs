/**
 * Reproducible build time (https://reproducible-builds.org/specs/source-date-epoch/).
 * The release-generation build sets SOURCE_DATE_EPOCH to the source commit
 * time (ADR-174 §9.4), so `builtAt` in the build provenance is a function of
 * the source, not of when the build ran. Without it, the wall clock is used.
 */

/**
 * `builtAt` for a build record.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => Date} [now]
 * @returns {string} ISO-8601 UTC time
 */
export function releaseBuiltAt(env = process.env, now = () => new Date()) {
    const raw = env.SOURCE_DATE_EPOCH;
    if (raw === undefined || raw === '') return now().toISOString();
    if (!/^\d{1,12}$/.test(raw)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer of seconds');
    return new Date(Number(raw) * 1000).toISOString();
}
