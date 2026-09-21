/** Materialize the real installed SDK entry in a disposable builder test root. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CODEX_IMAGE_ONLY_PATCH } from '../patch-codex-sdk-image-only.mjs';

/** Copies only fixture-owned bytes, then runs the tracked installer on that root. */
export function installCodexImageOnlyTestFixture(root) {
    const project = path.resolve(import.meta.dirname, '../..');
    const sdk = path.join(root, 'node_modules/@openai/codex-sdk');
    fs.mkdirSync(path.join(sdk, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({
        name: '@openai/codex-sdk', version: CODEX_IMAGE_ONLY_PATCH.version,
        type: 'module', main: 'dist/index.js',
    }));
    fs.copyFileSync(path.join(project, 'node_modules/@openai/codex-sdk/dist/index.js'), path.join(sdk, 'dist/index.js'));
    execFileSync(process.execPath, [path.join(project, 'scripts/patch-codex-sdk-image-only.mjs'), '--apply', '--root', root], { stdio: 'pipe' });
}
