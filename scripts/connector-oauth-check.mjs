#!/usr/bin/env node
/**
 * connector-oauth-check.mjs — prove a platform can actually be linked, against
 * the real platform, before a member is asked to try.
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST. Everything it checks lives on the
 * other side of the network: whether the platform publishes OAuth metadata,
 * whether it accepts self-registration, and whether it accepts THIS install's
 * public redirect. A mocked authorization server would answer yes to all three
 * and prove nothing (fleet lesson: synthetic fixtures give false confidence).
 *
 * It stops one step short of anything irreversible: it registers a client and
 * prints the authorize URL, but never opens a browser, never stores a grant, and
 * never touches a member's auth directory.
 *
 *   node scripts/connector-oauth-check.mjs https://mcp.canva.com/mcp
 *   node scripts/connector-oauth-check.mjs https://mcp.canva.com/mcp --origin https://nassaj.example.com
 *
 * Exit codes: 0 linkable · 1 usage · 2 the platform cannot be linked this way.
 */

import { beginLink, discoverAuthServer, serverUrlHash } from '../dist-server/server/modules/connectors/connector-oauth-flow.js';

const remoteUrl = process.argv[2];
if (!remoteUrl || remoteUrl.startsWith('-')) {
  console.error('usage: connector-oauth-check.mjs <mcp-server-url> [--origin https://host]');
  process.exit(1);
}

const originIndex = process.argv.indexOf('--origin');
const origin = originIndex === -1 ? 'https://nassaj.example.com' : process.argv[originIndex + 1];
const redirectUri = `${origin.replace(/\/$/, '')}/connectors/oauth/callback`;

try {
  const meta = await discoverAuthServer(remoteUrl);
  console.log(`issuer        : ${meta.issuer}`);
  console.log(`authorize     : ${meta.authorizationEndpoint}`);
  console.log(`token         : ${meta.tokenEndpoint}`);
  console.log(`registration  : ${meta.registrationEndpoint ?? '— (self-registration unsupported)'}`);
  console.log(`scopes        : ${meta.scopes.length}`);
  console.log(`mcp-remote key: ${serverUrlHash(remoteUrl)}`);

  if (!meta.registrationEndpoint) {
    console.error(
      '\n✘ This platform does not accept self-registration, so nassaj cannot link it ' +
        'without an app registered by hand at the platform.',
    );
    process.exit(2);
  }

  const { authorizeUrl } = await beginLink({
    userId: 0,
    connectorId: '__check__',
    remoteUrl,
    redirectUri,
  });
  console.log(`\n✔ Linkable. Registration accepted the redirect ${redirectUri}`);
  console.log(`\nauthorize URL (not opened):\n${authorizeUrl}`);
} catch (error) {
  console.error(`\n✘ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
