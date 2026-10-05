import { describe, expect, it } from 'vitest';

import { isReservedSteerCommand, parseSteerText, withSteerPrefix } from './steerCommand';

describe('isReservedSteerCommand', () => {
  it('is true for "/steer" alone and "/steer <text>"', () => {
    expect(isReservedSteerCommand('/steer')).toBe(true);
    expect(isReservedSteerCommand('/steer focus here')).toBe(true);
    expect(isReservedSteerCommand('  /steer focus here')).toBe(true);
  });

  it('is false for a different command or plain text', () => {
    expect(isReservedSteerCommand('/steering')).toBe(false);
    expect(isReservedSteerCommand('/btw question')).toBe(false);
    expect(isReservedSteerCommand('hello /steer')).toBe(false);
    expect(isReservedSteerCommand('')).toBe(false);
  });
});

describe('parseSteerText', () => {
  it('extracts the trimmed text after "/steer "', () => {
    expect(parseSteerText('/steer  focus on the bug  ')).toBe('focus on the bug');
  });

  it('returns empty for bare "/steer" with no following text', () => {
    expect(parseSteerText('/steer')).toBe('');
  });

  it('returns empty for non-steer input', () => {
    expect(parseSteerText('/btw focus on the bug')).toBe('');
  });
});

describe('withSteerPrefix', () => {
  it('inserts the prefix into an empty composer', () => {
    expect(withSteerPrefix('')).toBe('/steer ');
  });

  it('is idempotent when the command is already present', () => {
    expect(withSteerPrefix('/steer ')).toBe('/steer ');
    expect(withSteerPrefix('/steer hello')).toBe('/steer hello');
    expect(withSteerPrefix('/steer')).toBe('/steer');
    expect(withSteerPrefix(withSteerPrefix('x'))).toBe('/steer x');
  });

  it('prepends to existing text without wiping it', () => {
    expect(withSteerPrefix('fix X')).toBe('/steer fix X');
    expect(withSteerPrefix('/steering')).toBe('/steer /steering');
  });

  it('respects leading whitespace', () => {
    expect(withSteerPrefix('  /steer hi')).toBe('  /steer hi');
    expect(withSteerPrefix('   fix X')).toBe('/steer fix X');
  });
});
