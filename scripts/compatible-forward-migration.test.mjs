import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const scenario of ['applied', 'old-contract', 'crash', 'preexisting-fd', 'identity', 'source-drift', 'marker-drift',
    'nonce-drift', 'target-drift', 'observe-target', 'observe-identity', 'observe-drift', 'observe-hot-journal', 'observe-hardlink', 'observe-symlink', 'observe-mode', 'observe-sidecars', 'observe-postmode', 'busy', 'metadata-only', 'ambiguity', 'path-drift']) {
    test(`compatible-forward dedicated child: ${scenario}`, () => {
        const root = mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP || path.join(project, '.artifacts'), 'compatible-forward-'));
        try {
            const result = spawnSync(process.execPath,
                ['--import', 'tsx', 'server/scripts/fixtures/compatible-forward-child.test.ts', scenario, root],
                { cwd: project, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(project, 'server/tsconfig.json') },
                    encoding: 'utf8', timeout: 20_000 });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 0, result.stderr);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
}
