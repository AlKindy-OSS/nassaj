/**
 * ADR-156 / T-1730 W2 — narrowed local-divergence classification (M9).
 *
 * When a node is ahead of the target release, the update stops at
 * `non_fast_forward` (it NEVER rewrites history or resets — contract §3.2).
 * This module only changes the *text* of that refusal: it classifies the paths
 * of `git diff --name-status -z <merge-base(HEAD,target)>..HEAD` into three
 * buckets with the precise definitions of contract §3.1, so the operator is
 * told which customisation is overlayable, which must go upstream, and which
 * code change is simply unsupported on a node.
 *
 * Pure and effect-free: every git fact (the name-status stream, what the target
 * tracks, whether the `.gitignore` change is additions-only, and any dependency
 * version diff) is injected, so the classifier is unit-tested without real git.
 *
 * Categories (contract §3.1 table), precedence `code > dependency > overlayable`:
 *   - overlayable: an ADDED file under `public/<seg>/` where `<seg>` passes
 *     validateMount and the target tracks nothing under it; or `.gitignore`
 *     lines that were only ADDED. Move it to E1 / E2, then re-align.
 *   - dependency: package.json, package-lock.json, .npmrc. Go upstream; the
 *     changed packages are named with their versions.
 *   - code: everything else — a file directly under `public/`, a modification
 *     of an existing tracked file, a deleted `.gitignore` line, a rename, or
 *     any other path. Code customisation is unsupported on a node.
 */
import { validateMount } from './node-overlay.mjs';

/**
 * Parse `git diff --name-status -z` output. The `-z` form separates every field
 * with a NUL and does NOT quote or escape, so paths with spaces or newlines
 * survive intact (test plan §7). Rename/copy entries carry two paths.
 *
 * @param {string} text raw `-z` output
 * @returns {Array<{ status: string, path: string, oldPath?: string }>}
 */
export function parseNameStatusZ(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const tokens = text.split('\0');
    // A trailing NUL yields a final empty token; drop trailing empties only.
    while (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
    const entries = [];
    let i = 0;
    while (i < tokens.length) {
        const status = tokens[i];
        i += 1;
        if (status === undefined || status === '') continue;
        const kind = status[0];
        if (kind === 'R' || kind === 'C') {
            const oldPath = tokens[i];
            const newPath = tokens[i + 1];
            i += 2;
            entries.push({ status, oldPath, path: newPath });
        } else {
            const p = tokens[i];
            i += 1;
            entries.push({ status, path: p });
        }
    }
    return entries;
}

/** Compare two `package.json` dependency maps and name every changed package with its versions. */
export function diffDependencyVersions(basePkg, headPkg) {
    const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const collect = (pkg) => {
        const out = new Map();
        if (pkg && typeof pkg === 'object') {
            for (const field of fields) {
                const map = pkg[field];
                if (map && typeof map === 'object') {
                    for (const [name, version] of Object.entries(map)) out.set(name, version);
                }
            }
        }
        return out;
    };
    const base = collect(basePkg);
    const head = collect(headPkg);
    const names = new Set([...base.keys(), ...head.keys()]);
    const changed = [];
    for (const name of names) {
        const from = base.has(name) ? base.get(name) : null;
        const to = head.has(name) ? head.get(name) : null;
        if (from !== to) changed.push({ name, from, to });
    }
    changed.sort((a, b) => a.name.localeCompare(b.name));
    return changed;
}

const DEPENDENCY_PATHS = new Set(['package.json', 'package-lock.json', '.npmrc']);

function isGitignore(p) {
    return p === '.gitignore' || p.endsWith('/.gitignore');
}

function isDependencyPath(p) {
    return DEPENDENCY_PATHS.has(p) || p.endsWith('/package.json') || p.endsWith('/package-lock.json') || p.endsWith('/.npmrc');
}

/**
 * Does the target release track anything under `public/<seg>/`? A `Set` of the
 * target's tracked paths is injected; overlayable requires this to be false.
 */
function targetTracksUnder(targetTrackedPaths, seg) {
    const prefix = `public/${seg}/`;
    for (const p of targetTrackedPaths) {
        if (p.startsWith(prefix)) return true;
    }
    return false;
}

/**
 * Classify local divergence. Returns the three buckets, the named packages, and
 * the dominant `category` by precedence (`code > dependency > overlayable`, or
 * `none` when there is no divergence).
 *
 * @param {object} input
 * @param {string} [input.nameStatusZ] raw `git diff --name-status -z` output
 * @param {Array} [input.entries] pre-parsed entries (alternative to nameStatusZ)
 * @param {Iterable<string>} [input.targetTrackedPaths] paths the target tracks
 * @param {boolean} [input.gitignoreAddedOnly=false] true iff .gitignore change is additions-only
 * @param {Array<{name,from,to}>} [input.packages=[]] named dependency changes
 * @returns {{ overlayable: object[], dependency: string[], code: object[], packages: object[], category: string }}
 */
export function classifyDivergence(input = {}) {
    const entries = input.entries || parseNameStatusZ(input.nameStatusZ || '');
    const targetTrackedPaths = new Set(input.targetTrackedPaths || []);
    const gitignoreAddedOnly = input.gitignoreAddedOnly === true;
    const packages = Array.isArray(input.packages) ? input.packages : [];

    const overlayable = [];
    const dependency = [];
    const code = [];

    for (const entry of entries) {
        const p = entry.path;
        if (typeof p !== 'string' || p.length === 0) continue;
        const status = (entry.status || '').toString();
        const kind = status[0];

        // Dependency manifests.
        if (isDependencyPath(p)) {
            dependency.push(p);
            continue;
        }

        // .gitignore: additions-only is overlayable (E2), a deletion is code.
        if (isGitignore(p)) {
            if (kind === 'A' || (kind === 'M' && gitignoreAddedOnly)) overlayable.push({ path: p, target: 'E2' });
            else code.push({ path: p, reason: 'gitignore-deletion-or-modification' });
            continue;
        }

        // A file under public/<seg>/... that was ADDED, seg is a valid mount, and
        // the target tracks nothing under it => overlayable (E1). Anything else
        // touching public/ (direct child, modification, rename, or a tracked
        // conflict) is code.
        if (p.startsWith('public/')) {
            const rest = p.slice('public/'.length);
            const parts = rest.split('/');
            const seg = parts[0];
            const isNested = parts.length >= 2 && parts[parts.length - 1] !== '';
            const isAddition = kind === 'A';
            if (isNested && isAddition && validateMount(`/${seg}`).valid && !targetTracksUnder(targetTrackedPaths, seg)) {
                overlayable.push({ path: p, target: 'E1', mount: `/${seg}` });
            } else {
                code.push({ path: p, reason: 'public-not-overlayable' });
            }
            continue;
        }

        // Everything else is unsupported code customisation on a node.
        code.push({ path: p, reason: 'code' });
    }

    let category = 'none';
    if (code.length > 0) category = 'code';
    else if (dependency.length > 0) category = 'dependency';
    else if (overlayable.length > 0) category = 'overlayable';

    return { overlayable, dependency, code, packages, category };
}
