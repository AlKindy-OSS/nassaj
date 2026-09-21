/**
 * T-1730 (ADR-156 §3.3 rule 7). Static guard: the whole update path must never
 * force a restart or kill sessions. The deferral design keeps "no kill" absolute
 * — promotion, the command-board gate and confirmation all stay session-safe —
 * so these tokens must never appear in the updater, the worker or the scheduler.
 * If a future change needs one, it is a governance decision, not an edit that
 * slips past review.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARDED_FILES = [
    'source-updater.js',
    'source-update-worker.js',
    'update-deferral-scheduler.js',
];
const FORBIDDEN = [/force-restart/, /confirmKillSessions/, /NASSAJ_RESTART_KILL_SESSIONS/];

for (const file of GUARDED_FILES) {
    test(`no force-restart guard: ${file} never forces a restart or kills sessions`, () => {
        const source = readFileSync(path.join(here, file), 'utf8');
        for (const pattern of FORBIDDEN) {
            assert.ok(!pattern.test(source), `${file} must not contain ${pattern.source}`);
        }
    });
}
