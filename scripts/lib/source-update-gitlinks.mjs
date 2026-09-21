/**
 * The one gitlink judgement of the source-update path (ADR-156 ب.1, ج، WI-11).
 *
 * A release that adds, removes, retargets or type-changes a submodule gitlink
 * is an UNSUPPORTED STATE, not a bad write. By the golden rule it therefore
 * belongs before any write — in the pre-flight and in the preparation gate —
 * and not inside `applySourceDirection`, where it fired symmetrically and turned
 * every rollback of such a release into `MANUAL` + a closed gate (B-1054).
 *
 * Identity checks (does the index still match the direction's `from`?) are a
 * different class and stay in both directions; they live with activation.
 */

export const GITLINK_MODE = '160000';
const ABSENT_MODE = '000000';

/** Two tree entries are the same when both mode and object id match. */
export function sameEntry(left, right) {
    return left?.mode === right?.mode && left?.oid === right?.oid;
}

/** Split NUL-delimited git output, dropping the trailing empty field. */
function nulFields(stdout) {
    return String(stdout).split('\0').filter((field) => field.length > 0);
}

/**
 * Parse `git ls-tree -rz --full-tree <commit>` into `Map(path -> {mode, oid})`.
 * A record that does not match the expected shape is a refusal, never a skip:
 * a silently dropped entry is a silently skipped gitlink.
 */
export function parseTreeEntries(stdout) {
    const entries = new Map();
    for (const record of nulFields(stdout)) {
        const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
        if (!match || (match[1] === GITLINK_MODE) !== (match[2] === 'commit') || entries.has(match[4])) {
            throw new Error('Source tree listing is invalid.');
        }
        entries.set(match[4], { mode: match[1], oid: match[3] });
    }
    return entries;
}

/**
 * Parse `git diff --raw -z --abbrev=40 <from>..<to>` into the two sides it
 * describes: `{ from, to }` maps over the CHANGED paths only. Every path absent
 * from both maps is identical on both sides by definition, which is exactly why
 * the changed set is enough to decide the gitlink question on a large tree
 * without listing it whole.
 */
export function parseRawDiffEntries(stdout) {
    const fields = nulFields(stdout);
    const from = new Map();
    const to = new Map();
    for (let index = 0; index < fields.length; index += 1) {
        const record = fields[index];
        if (!record.startsWith(':')) continue;
        const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])(\d+)?$/.exec(record);
        if (!match) throw new Error('Source diff listing is invalid.');
        const renamed = match[5] === 'R' || match[5] === 'C';
        const source = fields[index + 1];
        const destination = renamed ? fields[index + 2] : source;
        if (source === undefined || destination === undefined) throw new Error('Source diff listing is invalid.');
        index += renamed ? 2 : 1;
        if (match[1] !== ABSENT_MODE) from.set(source, { mode: match[1], oid: match[3] });
        if (match[2] !== ABSENT_MODE) to.set(destination, { mode: match[2], oid: match[4] });
    }
    return { from, to };
}

/** Every path carrying a gitlink on either side, changed or not. */
export function gitlinkPaths(from, to) {
    return new Set([...from.keys(), ...to.keys()].filter((name) => (
        from.get(name)?.mode === GITLINK_MODE || to.get(name)?.mode === GITLINK_MODE
    )));
}

/**
 * The gitlinks this transition would have to change — the unsupported set.
 * Empty means the transition leaves every gitlink exactly as it found it, which
 * is the only shape activation and rollback both support.
 */
export function gitlinkChangePaths(from, to) {
    return [...gitlinkPaths(from, to)]
        .filter((name) => !sameEntry(from.get(name), to.get(name)))
        .sort();
}
