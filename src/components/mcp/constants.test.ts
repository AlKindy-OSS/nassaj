import { describe, expect, it } from 'vitest';

import {
  globalManualTargets,
  MCP_SUPPORTED_SCOPES,
  MCP_SUPPORTED_TRANSPORTS,
} from './constants';

describe('MCP provider capability registry', () => {
  it('keeps Codex user-only because the real CLI ignores workspace config', () => {
    expect(MCP_SUPPORTED_SCOPES.codex).toEqual(['user']);
    expect(MCP_SUPPORTED_SCOPES.codex).not.toContain('project');
  });

  it('keeps the dormant OpenCode adapter out of the member UI', () => {
    expect(MCP_SUPPORTED_SCOPES.opencode).toEqual([]);
  });

  it('hides Gemini generic MCP without changing Cursor manual MCP', () => {
    expect(MCP_SUPPORTED_SCOPES.gemini).toEqual([]);
    expect(MCP_SUPPORTED_TRANSPORTS.gemini).toEqual([]);
    expect(MCP_SUPPORTED_SCOPES.cursor).toEqual(['user', 'project']);
    expect(MCP_SUPPORTED_TRANSPORTS.cursor).toEqual(['stdio', 'http']);
  });

  it('reports truthful global manual targets for each scope and transport', () => {
    expect(globalManualTargets('user', 'stdio')).toEqual(['claude', 'cursor', 'codex']);
    expect(globalManualTargets('user', 'http')).toEqual(['claude', 'cursor', 'codex']);
    expect(globalManualTargets('project', 'stdio')).toEqual(['claude', 'cursor']);
    expect(globalManualTargets('project', 'http')).toEqual(['claude', 'cursor']);
    expect(globalManualTargets('project', 'sse')).toEqual([]);
    expect(globalManualTargets('local', 'stdio')).toEqual([]);
  });
});
