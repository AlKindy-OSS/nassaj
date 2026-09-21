#!/usr/bin/env node
import { connectorCliFailure, exactJson, readBoundedPrivateInput } from './connectors-cli-lib.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) process.stdout.write(
  'Usage: npm run connectors:trust -- --import FILE --non-interactive\nUse FILE=- for stdin.\n');
else {
  const at = args.indexOf('--import'); const file = at >= 0 ? args[at + 1] : null;
  try {
    if (!args.includes('--non-interactive') || !file) throw new Error('CONNECTOR_TRUST_ARGUMENT_INVALID');
    exactJson(await readBoundedPrivateInput(file));
    connectorCliFailure('CONNECTOR_HEADLESS_OWNER_AUTH_REQUIRED',
      'Trust import requires an owner authorization adapter; use the owner Setup section.');
  } catch (error) { connectorCliFailure(error instanceof Error ? error.message : 'CONNECTOR_TRUST_ARGUMENT_INVALID',
    'No trust state was changed.'); }
}
