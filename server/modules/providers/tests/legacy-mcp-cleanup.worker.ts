import { removeLegacyMcpEntry } from '../services/legacy-mcp-cleanup.js';

const [rootDir, relativePath, format, mapKey, name, crashPhase] = process.argv.slice(2);
if (!rootDir || !relativePath || (format !== 'json' && format !== 'toml')
  || (mapKey !== 'mcpServers' && mapKey !== 'mcp_servers') || !name) {
  process.exitCode = 2;
} else {
  const result = await removeLegacyMcpEntry({
    rootDir,
    relativePath,
    format,
    mapKey,
    name,
    testLockHook: crashPhase === 'release-after-quarantine-link'
      || crashPhase === 'recovery-after-quarantine-link'
      ? (phase) => {
        if (phase === crashPhase) process.exit(77);
      }
      : undefined,
  });
  process.stdout.write(JSON.stringify(result));
}
