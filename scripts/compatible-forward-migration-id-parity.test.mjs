/**
 * Tripwire (B-1424 review): a forward migration id the database child accepts but the host
 * verifier rejects, or that no profile emits, is dormant code in a security-sensitive child.
 * The child, the host verifier and the contract builder must name exactly one shared id.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(project, relative), 'utf8');

test('child, host verifier and contract builder accept the same single forward migration id', () => {
    const constant = read('server/modules/database/compatible-forward-permission-receipt.migration.ts')
        .match(/export const PERMISSION_RECEIPT_FORWARD_MIGRATION_ID = '([^']+)';/)?.[1];
    assert.ok(constant, 'child migration id constant not found');

    const child = read('server/scripts/release-database-migration.ts');
    const childChecks = [...child.matchAll(/migrationId\s*!==\s*([A-Za-z_][\w.]*)/g)].map(match => match[1]);
    assert.deepEqual(childChecks, ['PERMISSION_RECEIPT_FORWARD_MIGRATION_ID', 'PERMISSION_RECEIPT_FORWARD_MIGRATION_ID'],
        'run and read paths must each pin the contract id to the single shared constant');
    assert.match(child, new RegExp(`migrationId:'${constant.replace(/[/.]/g, '\\$&')}';`));

    const hostIds = [...read('scripts/lib/update-release-asset.mjs').matchAll(/migrationId\s*!==\s*'([^']+)'/g)]
        .map(match => match[1]);
    assert.deepEqual(hostIds, [constant], 'host verifier must accept exactly the child id');

    const builderIds = [...read('scripts/lib/compatible-forward-release-profile.mjs').matchAll(/migrationId:\s*'([^']+)'/g)]
        .map(match => match[1]);
    assert.deepEqual(builderIds, [constant], 'contract builder must emit exactly the child id');
});
