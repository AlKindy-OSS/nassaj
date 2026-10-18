import { describe, expect, it } from 'vitest';

import { extractAgyTextToolCalls } from './agyTextToolCall';

// Shape copied from a real agy transcript (Recipient/RecipientName/message keyword args).
const REAL = 'send_message(Recipient="ibrahim", RecipientName="parent", message="The core issue stems from '
  + 'insufficient permissions. The \'EACCES: permission denied\' error confirms this.")';

describe('extractAgyTextToolCalls (B-1665)', () => {
  it('lifts a single whole-line call out of the reply', () => {
    const result = extractAgyTextToolCalls(`Checked the logs.\n\n${REAL}\n\nDone.`);
    expect(result.calls).toEqual([{
      recipient: 'ibrahim',
      recipientName: 'parent',
      message: "The core issue stems from insufficient permissions. The 'EACCES: permission denied' error confirms this.",
    }]);
    expect(result.body).toBe('Checked the logs.\n\nDone.');
  });

  it('accepts a message that spans several lines and escaped quotes', () => {
    const text = 'send_message(Recipient="a", message="line one\nsays \\"hi\\"\nline three")';
    expect(extractAgyTextToolCalls(text)).toEqual({
      body: '',
      calls: [{ recipient: 'a', recipientName: '', message: 'line one\nsays "hi"\nline three' }],
    });
  });

  it('lifts several calls and keeps the prose between them', () => {
    const text = 'send_message(Recipient="a", message="one")\nmiddle\n  send_message(Recipient="b", message="two")';
    const result = extractAgyTextToolCalls(text);
    expect(result.calls.map((call) => call.message)).toEqual(['one', 'two']);
    expect(result.body).toBe('middle');
  });

  it('leaves send_message in the middle of a sentence alone', () => {
    const text = 'Call send_message(Recipient="a", message="x") to notify the parent.';
    expect(extractAgyTextToolCalls(text)).toEqual({ body: text, calls: [] });
  });

  it.each([
    ['unterminated quote', 'send_message(Recipient="a", message="never closed'],
    ['unknown argument', 'send_message(Recipient="a", priority="high", message="x")'],
    ['missing message', 'send_message(Recipient="a")'],
    ['trailing text on the call line', 'send_message(Recipient="a", message="x") and more'],
    ['unquoted value', 'send_message(Recipient=a, message="x")'],
  ])('malformed input (%s) is returned unchanged', (_label, text) => {
    expect(extractAgyTextToolCalls(text)).toEqual({ body: text, calls: [] });
  });

  it('text without a call is returned as is', () => {
    expect(extractAgyTextToolCalls('plain reply')).toEqual({ body: 'plain reply', calls: [] });
  });
});
