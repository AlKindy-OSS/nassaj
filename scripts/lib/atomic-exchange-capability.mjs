/**
 * The `mv --exchange --no-copy` capability probe, on its own (ADR-156 م-2).
 *
 * Both atomic build scripts and the update pre-flight need this answer, and the
 * pre-flight runs inside the server process. Keeping the probe here — a leaf
 * module whose only dependency is `node:child_process` — is what lets the
 * server import it without dragging the TypeScript compiler that
 * `server-build-atomic.mjs` needs, which on a release node with pruned
 * devDependencies would turn a capability question into a permanent blocker.
 */
import { spawnSync } from 'node:child_process';

/** Report whether the installed mv exposes the required no-copy atomic exchange. */
export function supportsAtomicExchange() {
    const help = spawnSync('mv', ['--help'], { encoding: 'utf8' });
    return help.status === 0 && help.stdout.includes('--exchange') && help.stdout.includes('--no-copy');
}
