/** Durable global fence for OID control transactions. */
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { commonGitDir } from './git-control-root.mjs';
import { validateClientPublicationJournal, CLIENT_PUBLICATION_JOURNAL_SCHEMA } from './lib/client-publication-journal.mjs';
// The disposition validator is the capsule's own export.  Importing the capsule
// runs no side effects (its main-entry guard fires only when executed as raw
// bytes through stdin, `process.argv[1] === '-'`), so the fence stays a single
// shared implementation without duplicating the sealed capsule logic.
import { validateOidManualDisposition, validateOidPairTerminal } from './oid-control-capsule.mjs';

export const OID_CONTROL_JOURNAL_PREFIX = 'nassaj-oid-control-transaction-';
// `loaded` is retained solely to recognise journals written by protocol v1.
// New capsule transactions become terminal only at `served`, after recovery
// attestation and the durable hand-off point.  A journal is scoped by its
// immutable event group as well as sequence/nonce; all files live under the
// worktree-safe common Git directory.
export const OID_TERMINAL_STATES = new Set(['pair_rolled_back', 'pair_served', 'loaded', 'served', 'rolled_back', 'restart_deferred_restored', 'reconciled_adopted_live']);

// Schema of the write-once reconciliation receipt that alone authorises a
// `reconciled_adopted_live` closure (B-1032).  The receipt is created under the
// event lock by `oid-control-reconcile-adopted-live.mjs`; the fence only ever
// re-validates it structurally by hash, never by re-probing a live process.
export const OID_RECONCILE_SCHEMA = 'nassaj-oid-control-reconcile/v1';

const reconcileSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Pinned, symlink-refusing read of the reconcile receipt (mirrors capsule `pinnedFile`). */
function pinnedReconcileReceipt(file, maxSize = 128 * 1024) {
    const requested = lstatSync(file);
    if (!requested.isFile() || requested.isSymbolicLink()) throw new Error('reconcile_receipt_unsafe');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size > maxSize) throw new Error('reconcile_receipt_size_invalid');
        const bytes = readFileSync(fd);
        const after = fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.ctimeMs !== after.ctimeMs) throw new Error('reconcile_receipt_changed');
        return bytes;
    } finally { closeSync(fd); }
}

/**
 * Time-invariant structural validation of a `reconciled_adopted_live` journal.
 *
 * No live process / `/health` / `/proc` probe of any kind: the check reads only
 * the bytes of the journal and its immutable receipt and proves their hash
 * linkage, so the closure holds forever while the receipt is intact (mirroring
 * `validateCompletedDisposition`).  Returns the reconcile link on success, and
 * `false` on any failure (missing/renamed/symlinked/mismatched receipt) so the
 * fence stays fail-closed and raises `…:reconciled_adopted_live_unverified`.
 */
export function validateOidReconcileAdoptedLive(root, transaction) {
    try {
        const value = transaction?.value;
        const link = value?.reconcile;
        if (!link || typeof link.receiptSha256 !== 'string' || typeof link.originalJournalSha256 !== 'string') return false;
        const git = commonGitDir(root);
        const file = path.join(git, `nassaj-oid-control-reconcile-${value.transactionNonce}.json`);
        if (path.dirname(file) !== git) return false;
        const bytes = pinnedReconcileReceipt(file);
        const receipt = JSON.parse(bytes.toString('utf8'));
        if (receipt.schema !== OID_RECONCILE_SCHEMA || receipt.version !== 1
            || receipt.controlsClearedBeforeReceipt !== true
            || receipt.transactionNonce !== value.transactionNonce
            || receipt.sequence !== value.sequence || receipt.group !== value.group
            || link.receiptSha256 !== reconcileSha256(bytes)
            || link.originalJournalSha256 !== receipt.originalJournalSha256) return false;
        return link;
    } catch { return false; }
}

export function listOidControlTransactions(root) {
    const git = commonGitDir(root);
    if (!existsSync(git)) return [];
    return readdirSync(git).filter((name) => name.startsWith(OID_CONTROL_JOURNAL_PREFIX) && name.endsWith('.json'))
        .sort().map((name) => {
            const file = path.join(git, name);
            return { file, value: JSON.parse(pinnedReconcileReceipt(file, 1024 * 1024).toString('utf8')) };
        });
}

/**
 * Refuse to proceed while any non-terminal OID control transaction exists.
 *
 * Two narrow exemptions, never a wildcard:
 *   - `allowedNonce`: the caller's own in-progress successor journal.
 *   - `dispositionContext` ({packetPath, packetSha256, intended}): exactly one
 *     legacy `manual_recovery_required` / `previous_attestation_failed` journal,
 *     and only when the exact authorised-successor back context proves a fresh
 *     restoration under the held event lock (or, once the child chain is
 *     durable, is recognised through that one-to-one link with no context).
 *
 * Without a matching context a manual journal stays blocked, and every other
 * non-terminal state always blocks.
 */
export function assertNoNonterminalOidTransaction(root, allowedNonce = null, dispositionContext = null) {
    const journals = listOidControlTransactions(root);
    for (const entry of journals) {
        if (entry.value?.kind === 'client-publication' || entry.value?.schema === CLIENT_PUBLICATION_JOURNAL_SCHEMA) {
            const checked = validateClientPublicationJournal(root, entry);
            if (checked.terminal) continue;
            if (allowedNonce !== null && entry.value.transactionNonce === allowedNonce) continue;
            throw new Error(`oid_control_transaction_in_progress:${entry.value.state}`);
        }
        // Verify-first: this branch MUST precede the terminal-set shortcut.  A
        // `reconciled_adopted_live` journal is terminal for every set consumer,
        // but the fence still forces the structural receipt proof here so a
        // flipped journal with a missing/forged receipt stays blocked (B-1032).
        if (entry.value?.state === 'reconciled_adopted_live') {
            if (validateOidReconcileAdoptedLive(root, entry)) continue;
            throw new Error('oid_control_transaction_in_progress:reconciled_adopted_live_unverified');
        }
        if (['pair_served','pair_rolled_back'].includes(entry.value?.state) && !validateOidPairTerminal(root, entry)) throw new Error('oid_pair_terminal_unverified');
        if (OID_TERMINAL_STATES.has(entry.value?.state)) continue;
        if (allowedNonce !== null && entry.value?.transactionNonce === allowedNonce) continue;
        if (entry.value?.state === 'manual_recovery_required'
            && validateOidManualDisposition(root, entry, dispositionContext, journals)) continue;
        throw new Error(`oid_control_transaction_in_progress:${entry.value?.state || 'invalid'}`);
    }
}

export function writeOidControlJournal(file, value) {
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    let fd;
    try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, file);
        const directory = openSync(path.dirname(file), 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
        if (fd !== undefined) closeSync(fd);
        rmSync(temporary, { force: true });
    }
}
