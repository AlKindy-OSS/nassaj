import { describe, expect, it } from 'vitest';

import { visibleCategoriesFor } from './agentCategories';

describe('dormant MCP provider surfaces', () => {
  it('hides unproven MCP adapters while keeping Cursor manual MCP', () => {
    expect(visibleCategoriesFor('opencode')).not.toContain('mcp');
    expect(visibleCategoriesFor('gemini')).not.toContain('mcp');
    expect(visibleCategoriesFor('claude')).toContain('mcp');
    expect(visibleCategoriesFor('cursor')).toContain('mcp');
  });
});
