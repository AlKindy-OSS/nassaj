/**
 * T-2039 qa: moving a conversation to another engine sends its transcript to an
 * external provider, so its confirm must be destructive-toned (focus on Cancel).
 * Source contract: ChatInterface is too large to mount for this one call; the
 * danger tone's focus behaviour itself is covered by ConfirmDialog/DialogHost tests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('engine switch export confirm', () => {
  it('uses tone danger for engineSwitch.exportWarning', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/chat/view/ChatInterface.tsx'), 'utf8');
    const lines = source.split('\n').filter((line) => line.includes("'engineSwitch.exportWarning'"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('confirmDialog({');
    expect(lines[0]).toContain("tone: 'danger'");
    expect(source).not.toMatch(/confirmDialog\(t\('engineSwitch\.exportWarning'/);
  });
});
