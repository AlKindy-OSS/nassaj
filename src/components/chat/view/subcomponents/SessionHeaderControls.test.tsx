import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../../../internal-session-chat/InternalSessionChat', () => ({
  default: ({ enabled }: { enabled: boolean }) => (enabled ? <button type="button">team</button> : null),
}));

import SessionHeaderControls from './SessionHeaderControls';

afterEach(cleanup);

/** Every text node directly inside the header, ignoring whitespace-only nodes. */
const strayText = (root: Element) => [...root.childNodes]
  .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
  .map((node) => node.textContent);

describe('SessionHeaderControls', () => {
  it('renders exactly the header controls with the feature off — no wrapper, no stray text', () => {
    const { container } = render(
      <SessionHeaderControls sessionId="s1" internalChatEnabled={false}><span>bar</span></SessionHeaderControls>,
    );
    expect(container.innerHTML).toBe('<span>bar</span>');
    expect(strayText(container)).toEqual([]);
  });

  it('adds only the team-chat control with the feature on', () => {
    const { container } = render(
      <SessionHeaderControls sessionId="s1" internalChatEnabled><span>bar</span></SessionHeaderControls>,
    );
    const wrapper = container.firstElementChild as Element;
    expect(strayText(container)).toEqual([]);
    expect(strayText(wrapper)).toEqual([]);
    expect(wrapper.textContent).toBe('barteam');
  });

  it('ChatInterface portals the header as one element (no JSX sibling such as a stray ",")', () => {
    const source = readFileSync(path.join(__dirname, '..', 'ChatInterface.tsx'), 'utf8');
    const portal = source.slice(source.indexOf('createPortal('), source.indexOf('sessionHeaderTarget,\n', source.indexOf('createPortal(')));
    expect(portal).toMatch(/^createPortal\(\s*<SessionHeaderControls/);
    expect(portal.trimEnd()).toMatch(/<\/SessionHeaderControls>,$/);
    expect(portal).not.toMatch(/\/>,\s*</);
  });
});
