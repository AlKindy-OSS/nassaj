// B-1771 fixture: prints which parent provider variables survived into this
// process, by NAME only, and where HOME-derived credential files would resolve.
import os from 'node:os';

import { leakedNames } from './provider-leak-parent-env.mjs';

console.log(`PROVIDER_LEAK_PROBE ${JSON.stringify({
  leaked: leakedNames(process.env),
  homedir: os.homedir(),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
})}`);
