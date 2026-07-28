/**
 * rawInsertResponse.test.ts — B-257: a successful insert must never be reported
 * as a failure.
 *
 * The defect: clicking Execute on a chat code block inserted the command (HTTP
 * 201, audit row `insert` written, board badge incremented) and then displayed
 * «Failed to add command to queue», while the review dialog never opened. Two
 * days of a queued command looking like nothing had happened — for a surface
 * whose only job is telling the truth about what is about to run.
 *
 * The cause was a shape mismatch, not a failure: the route answers
 *   { command: { id, command, digest, requestedBy, requestedAt } }
 * and the client read `id`/`digest` at the top level, where both are undefined,
 * so the success guard fell through into the error branch.
 *
 * Two kinds of test, because one alone would not have caught it:
 *   1. Behaviour — the parser accepts the real body and rejects real errors.
 *   2. A SOURCE GUARD reading server/routes/system.js, so the day the route stops
 *      nesting the row (or starts) this file fails instead of the owner finding
 *      out from a false error message. The fixture below is derived from that
 *      route and from insertRawCommand's documented return value, not invented —
 *      a hand-written fixture is what let this shape drift unnoticed.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseRawInsertResponse } from './rawInsertResponse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../..');

/** Exactly what POST /api/system/command-board-raw returns on 201. */
const SERVER_201 = {
  command: {
    id: '2cda8433-f6a5-4390-85a0-7d61cef943fa',
    command: 'cd /home/dev/Project/AlNuman/AlNuman-Booking-Engine && git push origin main',
    digest: '5c1fde69deb510cd716bbbbe47ca29f3ecce12ef40fa41e8300ba4103a9e5a74',
    requestedBy: 'owner',
    requestedAt: '2026-07-28T02:51:58.000Z',
  },
};

describe('parseRawInsertResponse — the real 201 body', () => {
  it('accepts the nested row the route actually sends', () => {
    const outcome = parseRawInsertResponse(true, SERVER_201);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.row.id).toBe(SERVER_201.command.id);
    expect(outcome.row.command).toBe(SERVER_201.command.command);
    expect(outcome.row.digest).toBe(SERVER_201.command.digest);
    expect(outcome.row.requestedBy).toBe('owner');
  });

  it('carries the digest through — the reviewer cannot verify without it', () => {
    const outcome = parseRawInsertResponse(true, SERVER_201);
    expect(outcome.ok && outcome.row.digest).toHaveLength(64);
  });

  it('tolerates a flat row as well', () => {
    const outcome = parseRawInsertResponse(true, SERVER_201.command);
    expect(outcome.ok && outcome.row.id).toBe(SERVER_201.command.id);
  });
});

describe('parseRawInsertResponse — real refusals stay refusals', () => {
  it('reports the server code for a validation refusal', () => {
    // The shape of a 400 from the insert route.
    const outcome = parseRawInsertResponse(false, {
      status: 'error',
      code: 'forbidden_control_char',
      position: 12,
    });
    expect(outcome).toEqual({ ok: false, code: 'forbidden_control_char' });
  });

  it('reports the code for a denied tier', () => {
    const outcome = parseRawInsertResponse(false, { status: 'error', code: 'config_denied' });
    expect(outcome).toEqual({ ok: false, code: 'config_denied' });
  });

  it('falls back to internal when the body carries no code', () => {
    expect(parseRawInsertResponse(false, {})).toEqual({ ok: false, code: 'internal' });
    expect(parseRawInsertResponse(false, null)).toEqual({ ok: false, code: 'internal' });
  });

  it('refuses a 2xx whose row is unusable rather than opening the reviewer on it', () => {
    // A row without a digest cannot be integrity-checked in the dialog, and one
    // without an id cannot be addressed by the execute call.
    expect(parseRawInsertResponse(true, { command: { id: 'x', command: 'ls' } }).ok).toBe(false);
    expect(parseRawInsertResponse(true, { command: { command: 'ls', digest: 'd' } }).ok).toBe(false);
    expect(parseRawInsertResponse(true, { command: { id: 'x', command: '', digest: 'd' } }).ok).toBe(false);
  });
});

describe('B-257 source guard — the route still nests the created row', () => {
  const routeSource = readFileSync(resolve(REPO, 'server/routes/system.js'), 'utf8');

  it('POST /command-board-raw answers { command: ... }', () => {
    // Anchored on the raw insert route's own audit call so a change to the
    // custom-commands route (which shares the wrapper shape) cannot satisfy it.
    const insertBlock = routeSource.slice(routeSource.indexOf("auditRawExec(req, 'insert'"));
    expect(insertBlock.slice(0, 600)).toMatch(/res\.status\(201\)\.json\(\{ command: result\.value \}\)/);
  });

  it('the chat code block reads that body through this parser', () => {
    const markdown = readFileSync(
      resolve(REPO, 'src/components/chat/view/subcomponents/Markdown.tsx'),
      'utf8',
    );
    expect(markdown).toMatch(/parseRawInsertResponse\(res\.ok,/);
    // The flat read that caused B-257 must not come back.
    expect(markdown).not.toMatch(/!data\.id \|\| !data\.command/);
  });
});
