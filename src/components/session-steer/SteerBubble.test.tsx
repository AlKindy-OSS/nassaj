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
      <SteerBubble senderName="سارة" content="focus on the auth bug" deliveryStatus="delivered" />,
    );
    const bdi = screen.getByText('سارة');
    expect(bdi.tagName.toLowerCase()).toBe('bdi');
    expect(screen.getByText('focus on the auth bug')).not.toBeNull();
    expect(screen.getByText(/Delivered/i)).not.toBeNull();
  });

  it('carries a data-steer-injected marker and a descriptive aria-label', () => {
    const { container } = render(
      <SteerBubble senderName="Sara" content="hello" deliveryStatus="queued" />,
    );
    const root = container.querySelector('[data-steer-injected="true"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('aria-label')).toMatch(/Sara/);
  });

  it('uses the dedicated --session-steer-accent token, not --primary or --session-internal-accent', () => {
    const { container } = render(<SteerBubble senderName="A" content="x" />);
    const html = container.innerHTML;
    expect(html).toContain('var(--session-steer-accent)');
    expect(html).not.toContain('var(--primary)');
    expect(html).not.toContain('var(--project-accent)');
    expect(html).not.toContain('var(--session-internal-accent)');
    expect(html).not.toContain('var(--user-bubble-background');
  });

  it('uses solid rule token and omits the header for a continuation', () => {
    const { container } = render(<SteerBubble senderName="Sara" content="more" isContinuation />);
    expect(container.innerHTML).toContain('var(--session-steer-rule)');
    expect(container.querySelector('bdi')).toBeNull();
  });

  it('B-1697: renders the steer images as thumbnails below the text', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const { container } = render(
      <SteerBubble senderName="Sara" content="see this" images={[
        { name: 'image_0.png', data: png },
        { name: 'image_1.png', data: `${png}A` },
      ]} />,
    );
    const grid = container.querySelector('[data-steer-images="true"]');
    expect(grid).not.toBeNull();
    const imgs = grid!.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe(png);
    expect(imgs[0].getAttribute('alt')).toBe('image_0.png');
  });

  it('B-1697: renders no image grid for a text-only steer', () => {
    const { container } = render(<SteerBubble senderName="Sara" content="text only" images={[]} />);
    expect(container.querySelector('[data-steer-images]')).toBeNull();
  });
});
