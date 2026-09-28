/**
 * Test-only child: runs restoreStores and hard-exits (simulated crash) right
 * before file operation `index` of `phase`. argv: <manifestDir> <phase> <index>.
 */

import { loadManifest, type RestorePhase } from '../manifest.js';
import { restoreStores } from '../store-backup.js';

const [dir, phase, index] = process.argv.slice(2);
restoreStores(dir, loadManifest(dir), 'auto', {
  assertNoHolders: () => undefined,
  beforeStep: (p: RestorePhase, i: number) => {
    if (p === phase && i === Number(index)) process.exit(137);
  },
});
process.exit(0);
