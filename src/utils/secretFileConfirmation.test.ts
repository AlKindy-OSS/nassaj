/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * B-1593: the client asks before opening a secrets file and retries with the flag.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SECRET_FILE_CONFIRMATION_CODE,
  SECRET_FILE_DECLINED,
  isSecretConfirmationRequired,
  requestWithSecretConfirmation,
} from './secretFileConfirmation';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const askAgain = () => jsonResponse(428, { error: 'confirm', code: SECRET_FILE_CONFIRMATION_CODE });

describe('isSecretConfirmationRequired', () => {
  it('is true only for a 428 carrying the confirmation code', async () => {
    expect(await isSecretConfirmationRequired(askAgain())).toBe(true);
    expect(await isSecretConfirmationRequired(jsonResponse(428, { code: 'other' }))).toBe(false);
    expect(await isSecretConfirmationRequired(jsonResponse(403, { code: SECRET_FILE_CONFIRMATION_CODE })))
      .toBe(false);
    expect(await isSecretConfirmationRequired(new Response('not json', { status: 428 }))).toBe(false);
  });
});

describe('requestWithSecretConfirmation', () => {
  it('passes a normal response through without asking', async () => {
    const request = vi.fn(async () => jsonResponse(200, { content: 'x' }));
    const confirm = vi.fn(() => true);
    const response = await requestWithSecretConfirmation(request, { fileName: 'a.ts', confirm });
    expect(response).not.toBe(SECRET_FILE_DECLINED);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks on 428 and retries once with the flag when the user agrees', async () => {
    const request = vi.fn(async (confirmSecret: boolean) =>
      (confirmSecret ? jsonResponse(200, { content: 'JWT=1' }) : askAgain()));
    const confirm = vi.fn(() => true);
    const response = await requestWithSecretConfirmation(request, { fileName: '.env', confirm });
    expect(confirm).toHaveBeenCalledWith('.env');
    expect(request.mock.calls).toEqual([[false], [true]]);
    expect(response !== SECRET_FILE_DECLINED && response.status).toBe(200);
  });

  it('reads or writes nothing more when the user declines', async () => {
    const request = vi.fn(async () => askAgain());
    const response = await requestWithSecretConfirmation(request, { fileName: '.env', confirm: () => false });
    expect(response).toBe(SECRET_FILE_DECLINED);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends the flag at once, without asking, when already confirmed', async () => {
    const request = vi.fn(async () => jsonResponse(200, {}));
    const confirm = vi.fn(() => true);
    await requestWithSecretConfirmation(request, { fileName: '.env', alreadyConfirmed: true, confirm });
    expect(request.mock.calls).toEqual([[true]]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not loop: a 403 for a service secret is returned as is', async () => {
    const request = vi.fn(async () => jsonResponse(403, { error: 'Path must be under project root' }));
    const response = await requestWithSecretConfirmation(request, { fileName: '.env', confirm: () => true });
    expect(response !== SECRET_FILE_DECLINED && response.status).toBe(403);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
