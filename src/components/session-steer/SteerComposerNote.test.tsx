import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import i18n from '../../i18n/config.js';

import SteerComposerNote from './SteerComposerNote';

beforeAll(async () => {
  await i18n.init();
  await i18n.changeLanguage('en');
});
afterEach(() => cleanup());

describe('SteerComposerNote', () => {
  it('mentions the starter’s quota and never the /steer hint (T-1956)', () => {
    render(<SteerComposerNote starterName="Sara" />);
    const note = screen.getByTestId('steer-composer-note');
    expect(note.textContent).toMatch(/Sara/);
    expect(note.textContent).toMatch(/quota/i);
    expect(note.textContent).not.toMatch(/\/steer/);
  });
});
