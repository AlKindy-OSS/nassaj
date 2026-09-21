import assert from 'node:assert/strict';
import test from 'node:test';

import { agyTranscriptMessageId, finalAgyTranscriptMessage } from '../modules/providers/list/antigravity/agy-transcript-identity.js';

import { providerSucceeded, observeProviderErrors } from './provider-terminal-proof.js';
import { persistKimiTranscriptFinal } from './kimi-transcript-final.js';
const planner = { step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'answer' };
const transcript = (entries) => entries.map(x => JSON.stringify(x)).join('\n');
test('AGY durable identity is stable across reads and current completed native step only', () => {
    assert.equal(finalAgyTranscriptMessage(transcript([planner]), 'brain', 2).id, agyTranscriptMessageId('brain', 3));
    for (const entries of [[{ ...planner, status: 'RUNNING' }], [planner, planner], [planner, { step_index: 4, type: 'RUN_COMMAND' }]])
        assert.equal(finalAgyTranscriptMessage(transcript(entries), 'brain', 2), null);
    assert.equal(finalAgyTranscriptMessage(transcript([planner]), 'brain', 3), null);
});
test('zero exit cannot erase timeout, error, signal or abort', () => {
    assert.equal(providerSucceeded(0, null, false), true);
    for (const failure of ['timeout', 'error', 'signal'])
        assert.equal(providerSucceeded(0, failure, false), false);
    assert.equal(providerSucceeded(0, null, true), false);
    let failure;
    const messages = [];
    const writer = observeProviderErrors({ send(message) { messages.push(message); } }, value => failure = value);
    writer.send({ kind: 'error', content: 'failure' });
    assert.equal(failure, 'failure');
    assert.equal(messages.length, 1);
});
test('Kimi preserves user/tools order, gives only one final string its persisted id, and suppresses timing after append failure', async () => {
    const calls = [];
    const turn = { sessionId: 's', userId: 7, messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'result' }] }], assistantBlocks: [{ type: 'text', text: 'answer' }], succeeded: true };
    const id = await persistKimiTranscriptFinal(turn, async (event, key) => calls.push({ event, key }));
    assert.equal(calls.length, 4);
    assert.equal(calls[3].event.message.content, 'answer');
    assert.equal(calls[3].event.message.id, id);
    assert.equal(calls[3].event.message.isFinalAnswer, true);
    assert.equal(await persistKimiTranscriptFinal(turn, async () => { throw Error('disk'); }), null);
    const partial = [];
    assert.equal(await persistKimiTranscriptFinal({ ...turn, succeeded: false }, async (event) => partial.push(event)), null);
    assert.equal(partial.at(-1).message.isFinalAnswer, undefined);
    assert.equal(await persistKimiTranscriptFinal({ ...turn, userId: null }, async () => assert.fail()), null);
});
