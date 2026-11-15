/** ADR-173 P6: the outbox card renders the shared-writing refusal in the UI language. */
import { describe, expect, it } from 'vitest';

import { resolveOutboxVerdict } from '../utils/messageOutbox';
import { readServerErrorCode, readServerErrorDetail } from '../utils/serverErrorMessage';

describe('shared_writing_unsupported outbox verdict', () => {
  it('fails the entry with its code and drops the server sentence', () => {
    const verdict = resolveOutboxVerdict({
      kind: 'complete', success: false, notStarted: true, code: 'shared_writing_unsupported',
      clientMsgId: 'cmid_x', error: 'Only the member who started this conversation can continue it here.',
      provider: 'codex',
    }, {
      isActiveViewSession: false,
      readErrorCode: (m) => readServerErrorCode(m as never),
      readErrorDetail: (m) => readServerErrorDetail(m as never),
    });
    expect(verdict).toMatchObject({ action: 'fail', code: 'shared_writing_unsupported', detail: null });
  });
});

describe('every shared-writing refusal on the outbox card (P8 cosmetic)', () => {
  it.each([
    'shared_writing_forbidden',
    'shared_write_transcript_conflict',
    'shared_write_transcript_unavailable',
    'shared_writing_cli_unproven',
  ])('%s keeps no server sentence beside the localized reason', (code) => {
    const verdict = resolveOutboxVerdict({
      kind: 'complete', success: false, notStarted: true, code, clientMsgId: 'cmid_x',
      error: 'You can no longer write in this conversation.', provider: 'claude',
    }, {
      isActiveViewSession: true,
      readErrorCode: (m) => readServerErrorCode(m as never),
      readErrorDetail: (m) => readServerErrorDetail(m as never),
    });
    expect(verdict).toMatchObject({ action: 'fail', code, detail: null });
  });
});
