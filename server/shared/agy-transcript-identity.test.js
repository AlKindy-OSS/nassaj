import assert from 'node:assert/strict';
import test from 'node:test';

import { agyTranscriptMessageId, finalAgyTranscriptMessage } from '../modules/providers/list/antigravity/agy-transcript-identity.js';

import { providerSucceeded, observeProviderErrors } from './provider-terminal-proof.js';
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
