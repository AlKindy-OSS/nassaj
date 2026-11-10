// B-1771 fixture: a careless test that writes a Claude credential into the
// member tree resolved from HOME, with no sandbox. Run ad hoc under `node --test`
// with HOME set to the (stand-in) real home, the seam guard must refuse it.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { userConfigDir } from '../../server/services/isolation/provision-user-dirs.js';

test('writes a fixture credential into the member tree', () => {
  const dir = userConfigDir(1, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }));
});
