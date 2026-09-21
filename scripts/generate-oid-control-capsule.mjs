#!/usr/bin/env node
/** Regenerate the committed built-ins-only capsule consumed by legacy updaters. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleOidControlCapsule, OID_CONTROL_COMPAT_ENTRY } from './lib/oid-control-bundle.mjs';
import { verifyOidCapsuleModuleClosure } from './server-build-atomic.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = bundleOidControlCapsule(root, verifyOidCapsuleModuleClosure);
fs.writeFileSync(path.join(root, OID_CONTROL_COMPAT_ENTRY), bundle.bytes, { mode: 0o644 });
