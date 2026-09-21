/**
 * Runs under `npm test` (test:src → node:test), NOT vitest.
 *
 * The first version of this file used vitest, which only `test:client` invokes —
 * and `npm test` does not call test:client (package.json:36). So the suite was
 * green and unreachable: exactly the "test that never runs" qa-critic flagged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractChatImagesFromPrompt, stripChatImageNote } from './chatImageNote';

/**
 * The synthetic note below preserves the shape written by the server
 * (claude-sdk handleImages) — the whole point of B-430 is that this text is the
 * ONLY trace of an attachment left in the transcript, so a fixture that drifts
 * from it would test nothing.
 */
const BUCKET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const noteFor = (...names: string[]) =>
  `\n\n[Images provided at the following paths:]\n${names
    .map((n, i) => `${i + 1}. /workspace/chat-images/${BUCKET}/${n}`)
    .join('\n')}`;

describe('extractChatImagesFromPrompt', () => {
  it('recovers every attached image from the path note', () => {
    const images = extractChatImagesFromPrompt(`شوف هذا${noteFor('image_0.png', 'image_1.jpeg')}`);

    assert.deepEqual(images, [
      { name: 'image_0.png', data: `/api/chat-images/${BUCKET}/image_0.png` },
      { name: 'image_1.jpeg', data: `/api/chat-images/${BUCKET}/image_1.jpeg` },
    ]);
  });

  it('returns nothing for a prompt with no attachments', () => {
    assert.deepEqual(extractChatImagesFromPrompt('رسالة عادية بلا صور'), []);
  });

  it('ignores pre-B-430 /tmp paths whose files no longer exist', () => {
    const legacy =
      '\n\n[Images provided at the following paths:]\n1. /tmp/nassaj-claude-images/1785852158337/image_0.png';
    assert.deepEqual(extractChatImagesFromPrompt(legacy), []);
  });

  it('does not resume mid-string across calls (module-level /g regex)', () => {
    const content = `أول${noteFor('image_0.png')}`;
    assert.equal(extractChatImagesFromPrompt(content).length, 1);
    assert.equal(extractChatImagesFromPrompt(content).length, 1);
  });

  it('emits each path once even when the text repeats it', () => {
    const content = `${noteFor('image_0.png')}${noteFor('image_0.png')}`;
    assert.equal(extractChatImagesFromPrompt(content).length, 1);
  });

  it('rejects a bucket that is not 32 hex chars', () => {
    const content =
      '1. /workspace/chat-images/../../secrets/image_0.png';
    assert.deepEqual(extractChatImagesFromPrompt(content), []);
  });

  // qa-critic: a bucket id typed or pasted into ordinary message text is NOT an
  // attachment. Matching it would turn the message body into a retrieval channel
  // for someone else's picture, since the serve route has no ownership check.
  it('ignores a bucket path that is not inside the appended note block', () => {
    const pasted =
      `زميلي أرسل لي هذا المسار: /workspace/chat-images/${BUCKET}/image_0.png وسألني عنه`;
    assert.deepEqual(extractChatImagesFromPrompt(pasted), []);
  });
});

describe('stripChatImageNote', () => {
  it('removes the note so the bucket capability never reaches the screen', () => {
    const stripped = stripChatImageNote(`شوف هذا${noteFor('image_0.png', 'image_1.png')}`);
    assert.equal(stripped, 'شوف هذا');
    assert.ok(!stripped.includes(BUCKET));
  });

  it('leaves a message without a note untouched', () => {
    assert.equal(stripChatImageNote('نصّ عادي'), 'نصّ عادي');
  });

  it('handles an image-only message (empty prompt text)', () => {
    assert.equal(stripChatImageNote(noteFor('image_0.png')), '');
  });

  it('does not strip a bucket path a user merely typed', () => {
    const pasted = `انظر chat-images/${BUCKET}/image_0.png`;
    assert.equal(stripChatImageNote(pasted), pasted);
  });
});
