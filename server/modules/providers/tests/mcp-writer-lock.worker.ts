import { writeFile } from 'node:fs/promises';

import { withCanonicalMcpWriterLock } from '../services/legacy-mcp-cleanup.js';

const [filePath, action] = process.argv.slice(2);
if (!filePath || (action !== 'crash-after-create' && action !== 'crash-after-mkdir')) {
  process.exitCode = 2;
} else {
  await withCanonicalMcpWriterLock(
    filePath,
    async ({ targetPath }) => {
      await writeFile(targetPath, '{"mcpServers":{}}\n', { mode: 0o600, flag: 'wx' });
      process.exit(77);
    },
    {
      testAfterDirectoryCreated: action === 'crash-after-mkdir'
        ? () => process.exit(77)
        : undefined,
    },
  );
}
