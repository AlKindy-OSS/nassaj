/**
 * The single definition of "does a local change block this release?" (ADR-156 أ.4, WI-10).
 *
 * The governed updater and the update pre-flight must answer identically. Two
 * copies of this judgement is what produced B-1050: the updater refused on an
 * untracked operator file that the release never touches, and no amount of
 * pre-flight wording could describe a rule it did not share. Both sides import
 * these functions; neither keeps a second implementation.
 *
 * The rule: only a local change that falls INSIDE the set of paths the release
 * rewrites can collide with it. Everything else — tracked or untracked — is the
 * node's own business and is none of the updater's.
 */

/** Split NUL-delimited git output, dropping the trailing empty field. */
export function nulFields(stdout) {
    return String(stdout).split('\0').filter((field) => field.length > 0);
}

/**
 * Parse `git status --porcelain=v1 -z` into `{ tracked[], untracked[] }`.
 * With `-z` a rename/copy emits the destination record followed by a separate
 * source record, so that extra field must be consumed rather than read as a
 * status line of its own.
 */
export function parsePorcelainStatus(stdout) {
    const fields = nulFields(stdout);
    const tracked = [];
    const untracked = [];
    for (let index = 0; index < fields.length; index += 1) {
        const record = fields[index];
        if (record.length < 4) continue;
        const x = record[0];
        const y = record[1];
        const target = record.slice(3);
        if (x === '?' && y === '?') untracked.push(target);
        else tracked.push(target);
        if (x === 'R' || x === 'C' || y === 'R' || y === 'C') index += 1; // consume the source path
    }
    return { tracked, untracked };
}

/**
 * The local changes that fall inside the paths a release rewrites — the only
 * ones that may veto an update.
 *
 * @param {{ tracked?: string[], untracked?: string[], changed: Iterable<string> }} input
 * @returns {string[]} the colliding paths, tracked first, in status order.
 */
export function conflictingPaths({ tracked = [], untracked = [], changed }) {
    const scope = changed instanceof Set ? changed : new Set(changed);
    return [...tracked, ...untracked].filter((file) => scope.has(file));
}

/** Name at most `limit` paths so an operator message stays readable and bounded. */
export function describePaths(paths, limit = 5, separator = ', ') {
    const shown = paths.slice(0, limit).join(separator);
    return paths.length > limit ? `${shown} (+${paths.length - limit})` : shown;
}
