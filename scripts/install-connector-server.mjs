#!/usr/bin/env node
/**
 * install-connector-server — installs an MCP server package into the store
 * nassaj resolves connector launchers from (T-1297).
 *
 * WHAT IT BUYS. A connector declared as `npx -y <pkg>` spawns `npm exec` and an
 * `sh` alongside the server itself on every engine spawn — ~250MB of
 * supervisors per session that do nothing after startup. Once the package lives
 * here, `server/services/mcp-npx-direct.ts` resolves its bin and the engine runs
 * it directly under nassaj's own node; the two supervisors disappear.
 *
 * WHY A SEPARATE STORE AND NOT package.json. Connector servers are operator
 * choices, not application dependencies: they change per install, they are
 * third-party code, and putting them in the app's own tree would drag every
 * catalog entry into every build and every lockfile. The store is deliberately
 * NOT under the application data directory — that path holds the active database and
 * is hidden from spawned engines by the provider cage.
 *
 * SAFE TO RE-RUN, and safe to skip: if the package is absent the launcher falls
 * back to `npx` and the connector still works, only slower and fatter.
 *
 * Usage:  node scripts/install-connector-server.mjs @infomaniak/mcp-server-mail [...]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const store =
  process.env.NASSAJ_CONNECTOR_SERVERS_DIR?.trim() ||
  path.join(
    process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share'),
    'nassaj-connector-servers',
  );

const packages = process.argv.slice(2).filter((arg) => arg.trim() !== '');
if (packages.length === 0) {
  console.error('usage: node scripts/install-connector-server.mjs <package>[ <package>...]');
  process.exit(2);
}

fs.mkdirSync(store, { recursive: true });
const manifest = path.join(store, 'package.json');
if (!fs.existsSync(manifest)) {
  // `private` so the store can never be published by accident, and no version
  // range of its own: npm records what was installed and that is the record.
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({ name: 'nassaj-connector-servers', private: true, description: 'MCP servers nassaj launches directly instead of through npx (T-1297).' }, null, 2)}\n`,
  );
}

console.log(`store: ${store}`);
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', ...packages], {
  cwd: store,
  stdio: 'inherit',
  // The store is not the app: never let a stray NODE_ENV=production prune it
  // into something the resolver cannot read.
  env: { ...process.env, NODE_ENV: '' },
});

for (const spec of packages) {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const dir = path.join(store, 'node_modules', ...name.split('/'));
  console.log(`${fs.existsSync(dir) ? 'ok  ' : 'MISS'} ${name} → ${dir}`);
}
