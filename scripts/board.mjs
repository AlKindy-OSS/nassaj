#!/usr/bin/env node
/** Product-side board guard (ADR-174). Live board data belongs to nassaj-core. */

const WRITE_COMMANDS = new Set(['add', 'update']);
const READ_COMMANDS = new Set(['get', 'verify']);

export function refusalFor(argv = []) {
  const command = argv[0];
  if (WRITE_COMMANDS.has(command)) {
    return 'governance board writes are disabled in nassaj-dev; from nassaj-core use: node scripts/board.mjs --product nassaj-dev <operation>';
  }
  if (READ_COMMANDS.has(command)) {
    return 'governance board reads are unavailable in nassaj-dev; from nassaj-core use: node scripts/board.mjs --product nassaj-dev <operation>';
  }
  return 'usage moved to the typed nassaj-core board CLI: add | update | get | verify';
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  process.stderr.write(`board: ${refusalFor(process.argv.slice(2))}\n`);
  process.exitCode = 2;
}
