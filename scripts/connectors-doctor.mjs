#!/usr/bin/env node

import Database from 'better-sqlite3';

import { inspectConnectorSetup } from '../server/modules/connectors/connector-setup-doctor.ts';
import { readConnectorRuntimeAuthorityRoot } from '../server/modules/connectors/connector-runtime-authority-root.ts';
import { getDatabasePath } from '../server/modules/database/connection.ts';
import { connectorCliFailure } from './connectors-cli-lib.mjs';

const substrateUnavailableReport = Object.freeze({
  schemaVersion: 1,
  readyForAccountLinking: false,
  resumableStep: 'origin',
  checks: Object.freeze([
    Object.freeze({ id: 'substrate', status: 'blocked', code: 'CONNECTOR_SUBSTRATE_UNAVAILABLE' }),
    Object.freeze({ id: 'origin', status: 'blocked', code: 'CONNECTOR_ORIGIN_REQUIRED' }),
    Object.freeze({ id: 'trust', status: 'blocked', code: 'CONNECTOR_TRUST_REQUIRED' }),
    Object.freeze({ id: 'pack', status: 'blocked', code: 'CONNECTOR_PACK_REQUIRED' }),
    Object.freeze({ id: 'activation', status: 'blocked', code: 'CONNECTOR_ACTIVATION_REQUIRED' }),
  ]),
});

const printReport = (report, json) => {
  process.stdout.write(json ? `${JSON.stringify(report)}\n`
    : `${report.readyForAccountLinking ? 'OK' : 'SETUP REQUIRED'}: ${report.resumableStep}\n${report.checks
      .map(check => `${check.status.toUpperCase()} ${check.id} ${check.code}`).join('\n')}\n`);
  if (!report.readyForAccountLinking) process.exitCode = 2;
};

const args = process.argv.slice(2); const json = args.includes('--json');
if (args.some(arg => arg !== '--json' && arg !== '--help')) {
  connectorCliFailure('CONNECTOR_DOCTOR_ARGUMENT_INVALID', 'Usage: npm run connectors:doctor -- [--json]', json);
} else if (args.includes('--help')) {
  process.stdout.write('Usage: npm run connectors:doctor -- [--json]\nRead-only; performs no setup or provider requests.\n');
} else {
  const databasePath = getDatabasePath();
  try {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const substrateExists = Boolean(database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='connector_installations'",
      ).get());
      const installation = substrateExists ? database.prepare(`SELECT installation_id AS id
        FROM connector_installations WHERE singleton=1`).get() : undefined;
      if (!installation?.id) {
        printReport(substrateUnavailableReport, json);
      } else {
        const authority = readConnectorRuntimeAuthorityRoot(
          `${databasePath}.connector-runtime-authority.json`,
        ).authority;
        const report = inspectConnectorSetup(database, installation.id, authority);
        printReport(report, json);
      }
    } finally { database.close(); }
  } catch {
    connectorCliFailure('CONNECTOR_DOCTOR_UNAVAILABLE', 'Database or runtime authority is unavailable.', json);
  }
}
