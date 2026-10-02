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

  // cursor is a retired body (T-1953): its manual MCP target is zeroed, not
  // kept — writing `.cursor/mcp.json` for a body that can no longer run is a
  // dead file, and the MCP panel is unreachable for it anyway (no settings
  // tile, no MCP_PANEL_AGENTS entry).
  it('zeroes Cursor manual MCP — retired body, no scope, no transport', () => {
    expect(MCP_SUPPORTED_SCOPES.cursor).toEqual([]);
    expect(MCP_SUPPORTED_TRANSPORTS.cursor).toEqual([]);
  });

  it('reports truthful global manual targets for each scope and transport', () => {
    expect(globalManualTargets('user', 'stdio')).toEqual(['claude', 'codex']);
    expect(globalManualTargets('user', 'http')).toEqual(['claude', 'codex']);
    expect(globalManualTargets('project', 'stdio')).toEqual(['claude']);
    expect(globalManualTargets('project', 'http')).toEqual(['claude']);
    expect(globalManualTargets('project', 'sse')).toEqual([]);
    expect(globalManualTargets('local', 'stdio')).toEqual([]);
  });
});
