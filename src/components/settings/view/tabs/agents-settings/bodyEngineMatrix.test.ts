/**
 * bodyEngineMatrix.test.ts — invariants the BODY × ENGINE matrix must hold
 * whatever its cells say (ADR-073).
 *
 * The matrix is declared, not derived, because most of it is facts about other
 * people's servers (see the module header). Declared data rots differently from
 * derived data: a cell can quietly claim more than the evidence behind it, an
 * engine can be dropped from a body's row when the axis widens, and an i18n key
 * can be reused across two bodies so one body's reason renders under another's.
 * These tests pin the properties that make the table safe to read, without
 * asserting the cells themselves — those belong to the ADR, and change with it.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { describe, expect, it } from 'vitest';

import {
  BODY_ENGINE_MATRIX,
  BODY_AXIS_IDS,
  ENGINE_AXIS_IDS,
  bodyEngineCells,
  bodyHasEngineAxis,
  engineHasStorableKey,
} from '../../../../../../shared/bodyEngineMatrix';
import { ELIGIBLE_ENGINE_PROVIDERS } from '../../../../../../shared/engineProviders';
import enSettings from '../../../../../i18n/locales/en/settings.json';
import arSettings from '../../../../../i18n/locales/ar/settings.json';

const allCells = BODY_AXIS_IDS.flatMap((body) => bodyEngineCells(body));

describe('shape', () => {
  it('every body on the axis has a row, and every row names known engines only', () => {
    for (const body of BODY_AXIS_IDS) {
      const cells = bodyEngineCells(body);
      expect(cells.length, `${body} has no engine row`).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(ENGINE_AXIS_IDS).toContain(cell.engine);
      }
    }
  });

  it('no body lists the same engine twice', () => {
    for (const body of BODY_AXIS_IDS) {
      const engines = bodyEngineCells(body).map((cell) => cell.engine);
      expect(new Set(engines).size, `${body} repeats an engine`).toBe(engines.length);
    }
  });

  it('reports no engine axis for an id that has no row', () => {
    expect(bodyHasEngineAxis('not-a-body')).toBe(false);
    expect(bodyEngineCells('not-a-body')).toEqual([]);
  });

  it('keeps BODY_ENGINE_MATRIX and BODY_AXIS_IDS in step', () => {
    expect(Object.keys(BODY_ENGINE_MATRIX).sort()).toEqual([...BODY_AXIS_IDS].sort());
  });
});

describe('a claim never outruns its evidence', () => {
  it('never marks a pair as running with no evidence at all', () => {
    for (const cell of allCells) {
      if (cell.status === 'available' || cell.status === 'native') {
        expect(cell.evidence, `${cell.engine} claims to run on no evidence`).not.toBe('none');
      }
    }
  });

  it('marks an unverified pair as carrying no evidence', () => {
    for (const cell of allCells) {
      if (cell.status === 'unverified') {
        expect(cell.evidence).toBe('none');
      }
    }
  });

  it('gives every cell a reason — a bare status explains nothing', () => {
    for (const cell of allCells) {
      expect(cell.note.length).toBeGreaterThan(0);
      expect(cell.noteDefault.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the i18n keys the panel renders', () => {
  it('uses a unique note key per cell, so no body borrows another body reason', () => {
    const notes = allCells.map((cell) => cell.note);
    expect(new Set(notes).size).toBe(notes.length);
  });

  it('has an English and an Arabic string for every note', () => {
    const en = (enSettings as { engines: { cell: Record<string, string> } }).engines.cell;
    const ar = (arSettings as { engines: { cell: Record<string, string> } }).engines.cell;
    for (const cell of allCells) {
      expect(en[cell.note], `en is missing engines.cell.${cell.note}`).toBeTruthy();
      expect(ar[cell.note], `ar is missing engines.cell.${cell.note}`).toBeTruthy();
    }
  });

  it('has an English and an Arabic label for every status the matrix uses', () => {
    const en = (enSettings as { engines: { status: Record<string, string> } }).engines.status;
    const ar = (arSettings as { engines: { status: Record<string, string> } }).engines.status;
    for (const status of new Set(allCells.map((cell) => cell.status))) {
      expect(en[status], `en is missing engines.status.${status}`).toBeTruthy();
      expect(ar[status], `ar is missing engines.status.${status}`).toBeTruthy();
    }
  });
});

describe('agreement with the engine axis', () => {
  it('gives the Claude body a cell for every engine eligible to drive it', () => {
    // ELIGIBLE_ENGINE_PROVIDERS is the single switch that makes an engine
    // selectable end to end for the Claude body (shared/engineProviders.ts).
    // Adding one there without a row here would make it selectable in the chat
    // while its own agent page says nothing about it.
    const claudeEngines = bodyEngineCells('claude').map((cell) => cell.engine);
    for (const engine of ELIGIBLE_ENGINE_PROVIDERS) {
      expect(claudeEngines, `claude has no row for eligible engine ${engine}`).toContain(engine);
    }
  });

  it('reports a storable key only for engines the secrets store actually manages', () => {
    expect(engineHasStorableKey('glm')).toBe(true);
    expect(engineHasStorableKey('kimi')).toBe(true);
    expect(engineHasStorableKey('deepseek')).toBe(true);
    // The body's own subscription and Zen's balance are not keys this app holds.
    expect(engineHasStorableKey('anthropic')).toBe(false);
    expect(engineHasStorableKey('zen')).toBe(false);
  });
});
