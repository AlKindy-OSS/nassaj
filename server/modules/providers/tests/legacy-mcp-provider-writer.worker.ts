const [provider, rootDir, name, action = 'upsert'] = process.argv.slice(2);
if ((provider !== 'claude' && provider !== 'cursor' && provider !== 'codex')
  || !rootDir || !name || (action !== 'upsert' && action !== 'remove')) {
  process.exitCode = 2;
} else if (provider === 'claude') {
  process.env.HOME = rootDir;
  process.env.CLAUDE_CONFIG_DIR = rootDir;
  const { ClaudeMcpProvider } = await import('../list/claude/claude-mcp.provider.js');
  const instance = new ClaudeMcpProvider();
  if (action === 'remove') {
    await instance.removeServer({ name, scope: 'user', userId: null });
  } else {
    await instance.upsertServer({
      name, scope: 'user', transport: 'stdio', command: 'writer', userId: null,
    });
  }
} else if (provider === 'cursor') {
  process.env.HOME = rootDir;
  const { CursorMcpProvider } = await import('../list/cursor/cursor-mcp.provider.js');
  const instance = new CursorMcpProvider();
  if (action === 'remove') {
    await instance.removeServer({ name, scope: 'user', userId: null });
  } else {
    await instance.upsertServer({
      name, scope: 'user', transport: 'stdio', command: 'writer', userId: null,
    });
  }
} else {
  process.env.HOME = rootDir;
  process.env.CODEX_HOME = `${rootDir}/.codex`;
  const { CodexMcpProvider } = await import('../list/codex/codex-mcp.provider.js');
  const instance = new CodexMcpProvider();
  if (action === 'remove') {
    await instance.removeServer({ name, scope: 'user', userId: null });
  } else {
    await instance.upsertServer({
      name, scope: 'user', transport: 'stdio', command: 'writer', userId: null,
    });
  }
}
