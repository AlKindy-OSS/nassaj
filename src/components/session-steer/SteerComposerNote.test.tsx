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
  it('names the /steer command for the starter, without quota language', () => {
    render(<SteerComposerNote starterName="Sara" isStarter />);
    const note = screen.getByTestId('steer-composer-note');
    expect(note.textContent).toMatch(/\/steer/);
    expect(note.textContent).not.toMatch(/quota/i);
  });

  it('mentions the starter’s quota for a non-starter (default isStarter)', () => {
    render(<SteerComposerNote starterName="Sara" />);
    const note = screen.getByTestId('steer-composer-note');
    expect(note.textContent).toMatch(/Sara/);
    expect(note.textContent).toMatch(/quota/i);
    expect(note.textContent).not.toMatch(/\/steer/);
  });
});
