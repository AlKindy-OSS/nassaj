import { describe, expect, it } from 'vitest';

import { visibleCategoriesFor } from './agentCategories';

describe('dormant MCP provider surfaces', () => {
  it('hides unproven MCP adapters while keeping the real ones', () => {
    expect(visibleCategoriesFor('opencode')).not.toContain('mcp');
    expect(visibleCategoriesFor('claude')).toContain('mcp');
    expect(visibleCategoriesFor('codex')).toContain('mcp');
  });

  // cursor is a retired body (T-1953): no MCP panel, no category at all.
  it('cursor has no MCP category (retired body)', () => {
    expect(visibleCategoriesFor('cursor')).not.toContain('mcp');
  });
});
