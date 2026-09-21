#!/usr/bin/env node
import { connectorCliFailure, exactJson, readBoundedPrivateInput } from './connectors-cli-lib.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: npm run connectors:setup -- --origin URL --pack FILE --activate FILE --non-interactive\n');
} else {
  const value = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : null; };
  try {
    const origin = value('--origin'); const pack = value('--pack'); const activation = value('--activate');
    if (!args.includes('--non-interactive') || !origin || !pack || !activation
      || new URL(origin).origin !== origin) throw new Error('CONNECTOR_SETUP_ARGUMENT_INVALID');
    exactJson(await readBoundedPrivateInput(pack)); exactJson(await readBoundedPrivateInput(activation));
    connectorCliFailure('CONNECTOR_HEADLESS_OWNER_AUTH_REQUIRED',
      'Headless mutation requires an owner authorization adapter; use the owner Setup section.');
  } catch (error) { connectorCliFailure(error instanceof Error ? error.message : 'CONNECTOR_SETUP_ARGUMENT_INVALID',
    'No setup state was changed.'); }
}
