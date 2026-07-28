// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';

const __dirname = getModuleDir(import.meta.url);
// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.js and /dist-server/server/load-env.js.
const APP_ROOT = findAppRoot(__dirname);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e) {
  // A genuinely-missing .env is an optional-config case (env vars may instead be
  // supplied by the process manager / shell) — preserve the prior behavior: log
  // and continue. But any OTHER read error (EACCES, EISDIR, a partial/corrupt
  // read, the wrong cwd, ...) must NOT be swallowed: silently continuing would
  // let DATABASE_PATH fall through to the ~/.cloudcli/auth.db default below
  // instead of the live ~/.local/share/nassaj-dev/db.sqlite, booting the backend
  // on an empty database with a fresh bootstrap-owner window. Fail fast and loud.
  if (e.code === 'ENOENT') {
    console.log('No .env file found or error reading it:', e.message);
  } else {
    console.error(
      `FATAL: cannot read .env at ${path.join(APP_ROOT, '.env')}: ${e.message}`
    );
    process.exit(1);
  }
}

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}
