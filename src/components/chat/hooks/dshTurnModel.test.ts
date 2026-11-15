/**
 * dshTurnModel.test.ts — T-2108 (qa round 1, HIGH 4), in the owner's terms: "no
 * switching local <-> cloud mid-chat". A new chat sends the composer pick, the
 * qualified local id included; a resumed chat never sends a local id. The server
 * keeps the local chat's own qualified id and uses it when the turn names a
 * non-local model or none.
 *
 * Run: npx vitest run src/components/chat/hooks/dshTurnModel.test.ts
 */
import { describe, expect, it } from 'vitest';

import { dshTurnModel } from './dshTurnModel';

const LOCAL = 'nassaj_local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/qwen3:8b';
const CLOUD = 'deepseek-v4-flash';

describe('dshTurnModel', () => {
  it('a new chat sends the composer pick as is, local or cloud', () => {
    expect(dshTurnModel(false, LOCAL)).toBe(LOCAL);
    expect(dshTurnModel(false, CLOUD)).toBe(CLOUD);
  });

  it('a resumed chat sends no local id (the server keeps a local chat on its own model)', () => {
    expect(dshTurnModel(true, LOCAL)).toBeUndefined();
  });

  it('a resumed chat keeps a cloud pick (a local chat ignores it server-side)', () => {
    expect(dshTurnModel(true, CLOUD)).toBe(CLOUD);
  });
});
