#!/usr/bin/env node
import { connectorCliFailure, exactJson, readBoundedPrivateInput } from './connectors-cli-lib.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) process.stdout.write(
  'Usage: npm run connectors:profile -- PROVIDER --secrets-file FILE --non-interactive\nUse FILE=- for stdin; files must be regular, non-symlink, and mode 0600.\n');
else {
  const provider = args[0]; const at = args.indexOf('--secrets-file'); const file = at >= 0 ? args[at + 1] : null;
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(provider ?? '')
      || !args.includes('--non-interactive') || !file) throw new Error('CONNECTOR_PROFILE_ARGUMENT_INVALID');
    exactJson(await readBoundedPrivateInput(file, { secret: true }));
    connectorCliFailure('CONNECTOR_PROFILE_SETUP_UNAVAILABLE',
      'Provider profile headless import is unavailable until its M6 contract is certified.');
  } catch (error) { connectorCliFailure(error instanceof Error ? error.message : 'CONNECTOR_PROFILE_ARGUMENT_INVALID',
    'No credential was stored.'); }
}
