import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import i18n from '../../i18n/config.js';

import SteerBubble from './SteerBubble';

beforeAll(async () => {
  await i18n.init();
  await i18n.changeLanguage('en');
});
afterEach(() => cleanup());

describe('SteerBubble', () => {
  it('renders the sender name wrapped in <bdi>, the content and a status label', () => {
    render(
      <SteerBubble senderUserId={7} senderName="سارة" content="focus on the auth bug" deliveryStatus="delivered" />,
    );
    const bdi = screen.getByText('سارة');
    expect(bdi.tagName.toLowerCase()).toBe('bdi');
    expect(screen.getByText('focus on the auth bug')).not.toBeNull();
    expect(screen.getByText(/Delivered/i)).not.toBeNull();
  });

  it('carries a data-steer-injected marker and a descriptive aria-label', () => {
    const { container } = render(
      <SteerBubble senderUserId={7} senderName="Sara" content="hello" deliveryStatus="queued" />,
    );
    const root = container.querySelector('[data-steer-injected="true"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('aria-label')).toMatch(/Sara/);
  });

  it('uses the dedicated --session-steer-accent token, not --primary or --session-internal-accent', () => {
    const { container } = render(<SteerBubble senderUserId={1} senderName="A" content="x" />);
    const html = container.innerHTML;
    expect(html).toContain('var(--session-steer-accent)');
    expect(html).not.toContain('var(--primary)');
    expect(html).not.toContain('var(--project-accent)');
    expect(html).not.toContain('var(--session-internal-accent)');
    expect(html).not.toContain('var(--user-bubble-background');
  });
});
