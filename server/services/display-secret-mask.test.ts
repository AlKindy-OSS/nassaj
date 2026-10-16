/**
 * ADR-210 (T-2036): display-time secret masking — rules, corpus that must
 * survive, message walking, the stream masker and the live frame decision.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPLAY_MASK_VERSION,
  DisplayStreamMasker,
  configureDisplayMaskForTests,
  createBtwDisplaySink,
  createDisplayReplaySink,
  displayHistoryRevision,
  displayLiteralsForSession,
  isDisplayMaskingEnabled,
  maskDisplayLabel,
  maskMessage,
  maskPendingPermissionsFor,
  maskSessionText,
  maskClippedSessionText,
  maskText,
  prepareDisplayFrames,
  restoreMaskedLabel,
  restoreMaskedUpdatedInput,
} from '@/services/display-secret-mask.js';
import { DISPLAY_RULE_IDS, LEGACY_AUDIT_REDACTION_RULES } from '@/services/secret-patterns.js';

// Fixed fake credentials: shaped like real ones, valid nowhere.
const SK = 'sk-' + 'ant-api03-AbCdEfGhIjKlMnOpQrStUvWx';
const GHP = `ghp_${'Ab1'.repeat(12)}`;
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const SLACK = 'xox' + 'b-1234567890-AbCdEfGhIjKl';
const GOOGLE = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
const GITLAB = 'glp' + 'at-AbCdEfGhIjKlMnOpQrSt';
const HF = 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const NPM = 'npm_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const STRIPE = 'sk_' + 'live_AbCdEfGhIjKlMnOpQrSt1234';
const PEM = `-----BEGIN ${'RSA PRIVATE'} KEY-----\nMIIEowIBAAKCAQEA1b2c3d4e5f6\nZ9y8x7w6v5u4t3s2r1q0\n-----END RSA PRIVATE KEY-----`;
const LITERAL = 'Zx9-literal-service-secret-0001';

const M = (rule: string) => `[masked:${rule}]`;

function quietSources(overrides: Parameters<typeof configureDisplayMaskForTests>[0] = {}): void {
  configureDisplayMaskForTests({
    env: () => undefined,
    readSetting: () => null,
    serviceLiterals: () => [LITERAL],
    allUserIds: () => [],
    sharedVendorLiterals: () => [],
    vendorLiterals: () => [],
    ...overrides,
  });
}

test.beforeEach(() => quietSources());
test.after(() => configureDisplayMaskForTests(null));

const mask = (text: string) => maskText(text, { literals: displayLiteralsForSession(null) });

test('golden: each display rule masks its value and keeps the name', () => {
  const golden: Array<[string, string, string]> = [
    ['json-field', '{"api_key": "abc123xyz"}', `{"api_key": "${M('json-field')}"}`],
    ['json-escaped-field', '"{\\"password\\":\\"hunter2\\"}"', `"{\\"password\\":\\"${M('json-escaped-field')}\\"}"`],
    ['assignment', 'export OPENAI_API_KEY=abc123zz', `export OPENAI_API_KEY=${M('assignment')}`],
    ['table-cell', '| password | hunter2x |', `| password | ${M('table-cell')} |`],
    ['jwt', `token ${JWT} end`, `token ${M('jwt')} end`],
    ['anthropic-openai-key', `use ${SK} now`, `use ${M('anthropic-openai-key')} now`],
    ['github-token', `gh ${GHP}`, `gh ${M('github-token')}`],
    ['aws-access-key', `id ${AWS} ok`, `id ${M('aws-access-key')} ok`],
    ['bearer', 'Authorization: Bearer abcDEF123456', `Authorization: Bearer ${M('bearer')}`],
    ['url-userinfo', 'postgres://app:s3cretpw@db:5432/x', `postgres://app:${M('url-userinfo')}@db:5432/x`],
    ['pem-private-key', `key:\n${PEM}\ndone`, `key:\n${M('pem-private-key')}\ndone`],
    ['cookie-header', 'Cookie: sid=abc123; theme=dark', `Cookie: ${M('cookie-header')}`],
    ['slack-token', `slack ${SLACK}`, `slack ${M('slack-token')}`],
    ['google-api-key', `g ${GOOGLE}`, `g ${M('google-api-key')}`],
    ['gitlab-token', `gl ${GITLAB}`, `gl ${M('gitlab-token')}`],
    ['huggingface-token', `hf ${HF}`, `hf ${M('huggingface-token')}`],
    ['npm-token', `npm ${NPM}`, `npm ${M('npm-token')}`],
    ['stripe-live-key', `pay ${STRIPE}`, `pay ${M('stripe-live-key')}`],
    ['known-secret', `the value ${LITERAL} leaked`, `the value ${M('known-secret')} leaked`],
  ];
  for (const [rule, input, expected] of golden) {
    assert.ok(DISPLAY_RULE_IDS.includes(rule), `${rule} is a display rule`);
    assert.equal(mask(input), expected, rule);
  }
});

test('the corpus that must survive is byte-identical', () => {
  const buildId = 'a3f1'.repeat(16);
  let seed = 11;
  const bytes = Buffer.alloc(3000, 0).map(() => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 256; });
  const corpus = [
    'commit 3636a7419ff81202f2b224e8e953781cdf8c7acedcc8f and short 3636a74',
    'commit 9f3c2a1b4d5e6f708192a3b4c5d6e7f8091a2b3c',
    'session 11111111-2222-4333-8444-555555555555 opened',
    `node scripts/request-server-action.mjs --expected-server-build-id ${buildId} --reason x`,
    'API_KEY=$API_KEY\nTOKEN=${GH_TOKEN}\nSECRET=VAULT_SECRET_NAME',
    'api_key: <your-key>\npassword: ***',
    '"integrity": "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="',
    'see /home/user/.ssh/config and /root/app and 100.64.1.2 and box.example.ts.net',
    `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    'مرحبا — هذا نص عربي عادي بلا أسرار، والرمز token: abcdef',
    'Set the API_KEY variable, then MAX_TOKENS=4096.',
  ];
  for (const text of corpus) assert.equal(mask(text), text, text.slice(0, 60));
});

test('the share and audit profiles are untouched by the display profile', () => {
  assert.equal(LEGACY_AUDIT_REDACTION_RULES.length, 4);
  assert.ok(!DISPLAY_RULE_IDS.includes('high-entropy'));
  assert.ok(!DISPLAY_RULE_IDS.includes('private-path'));
  assert.ok(!DISPLAY_RULE_IDS.includes('tailscale-cgnat'));
});

test('maskMessage walks the content fields, copies on change and never mutates', () => {
  const message = {
    id: 'm1', kind: 'tool_use', sessionId: 's', toolName: 'Bash',
    toolInput: { command: `curl -H "Authorization: Bearer ${SK}"`, nested: [{ deep: GHP }] },
    toolResult: { content: `token=${GHP}` },
  };
  const frozen = structuredClone(message);
  const out = maskMessage(message, {});
  assert.deepEqual(message, frozen, 'input untouched');
  assert.notEqual(out, message);
  assert.ok(!JSON.stringify(out).includes(SK) && !JSON.stringify(out).includes(GHP));
  assert.equal(out.id, 'm1');
  const clean = { id: 'm2', kind: 'text', content: 'nothing here' };
  assert.equal(maskMessage(clean, {}), clean, 'an unchanged message is the same object');
});

test('maskMessage fails closed beyond max depth and replaces oversize strings whole', () => {
  let deep: Record<string, unknown> = { leaf: SK };
  for (let level = 0; level < 14; level += 1) deep = { next: deep };
  const out = JSON.stringify(maskMessage({ content: deep }, {}));
  assert.ok(!out.includes(SK) && out.includes(M('depth')), 'beyond the depth limit a marker replaces the value');
  const huge = 'x'.repeat(16 * 1024 * 1024 + 1);
  assert.equal(maskText(huge), M('oversize'));
});

test('I5: every member vendor key is one shared known-value set, cached 60 s, used by every egress', () => {
  let now = 1_000;
  let lookups = 0;
  // A GLM-format key matches no rule: only the known-value set can mask it.
  const GLM = '0a1b2c3d4e5f60718293a4b5c6d7e8f9.AbCdEfGhIjKlMnOp';
  quietSources({
    now: () => now,
    allUserIds: () => { lookups += 1; return [7, 8]; },
    vendorLiterals: (userId) => (userId === 7 ? [GLM] : []),
  });
  assert.equal(maskText(`k=${GLM}`, { literals: displayLiteralsForSession('a-session-member-7-never-joined') }), `k=${M('known-secret')}`);
  assert.equal(maskDisplayLabel(`title ${GLM}`), `title ${M('known-secret')}`, 'titles and search use the same set');
  assert.equal(maskSessionText(`report ${GLM}`, null), `report ${M('known-secret')}`, 'agent reports and /btw too');
  assert.equal(lookups, 1, 'one user listing per 60 s, whatever the call site');
  now += 60_001;
  displayLiteralsForSession(null);
  assert.equal(lookups, 2, 'refreshed after 60 s');
});

test('a failing literal source masks less but never throws', () => {
  quietSources({ serviceLiterals: () => { throw new Error('store down'); } });
  assert.deepEqual(displayLiteralsForSession(null), []);
  assert.equal(mask(`k ${SK}`), `k ${M('anthropic-openai-key')}`);
});

/** Feeds `text` as `parts` deltas through the frame decision; returns every emitted content. */
function streamThrough(text: string, cuts: number[], masker = new DisplayStreamMasker()): string[] {
  const emitted: string[] = [];
  const points = [0, ...cuts, text.length];
  const collect = (frames: ReturnType<typeof prepareDisplayFrames>) => {
    for (const frame of [...(frames?.before ?? []), frames?.viewer]) {
      const content = (frame as { content?: unknown } | undefined)?.content;
      if (typeof content === 'string') emitted.push(content);
    }
  };
  for (let index = 0; index < points.length - 1; index += 1) {
    const delta = { kind: 'stream_delta', id: `d${index}`, sessionId: 'stream-s', content: text.slice(points[index], points[index + 1]) };
    collect(prepareDisplayFrames(delta, 'stream-s', masker));
  }
  collect(prepareDisplayFrames({ kind: 'stream_end', sessionId: 'stream-s' }, 'stream-s', masker));
  return emitted;
}

test('property: a secret split across 2-5 deltas never appears in any emitted frame', () => {
  const secrets = [SK, GHP, JWT, AWS, SLACK, GOOGLE, GITLAB, HF, NPM, STRIPE, LITERAL];
  const shapes = [
    (s: string) => `Here is the key ${s} — keep it safe.\nNext line.`,
    (s: string) => `OPENAI_API_KEY=${s}\n`,
    (s: string) => `run: curl -H "Authorization: Bearer ${s}" https://x.test`,
    (s: string) => `| token | ${s} |\n`,
    (s: string) => `{"api_key": "${s}"}`,
  ];
  let seed = 3;
  const next = (bound: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % bound; };
  for (const secret of secrets) {
    for (const shape of shapes) {
      const text = shape(secret);
      for (let round = 0; round < 40; round += 1) {
        const parts = 2 + next(4);
        const cuts = [...new Set(Array.from({ length: parts - 1 }, () => 1 + next(text.length - 1)))].sort((a, b) => a - b);
        const frames = streamThrough(text, cuts);
        const joined = frames.join('');
        assert.ok(!joined.includes(secret), `leak: ${JSON.stringify(text)} @ ${cuts}`);
        for (const frame of frames) {
          for (let at = 0; at + 8 <= secret.length; at += 1) {
            assert.ok(!frame.includes(secret.slice(at, at + 8)), `fragment leak in ${JSON.stringify(frame)}`);
          }
        }
        assert.equal(joined, mask(text), 'streamed text equals whole-text masking');
      }
    }
  }
});

test('a PEM block streamed line by line is held and masked whole', () => {
  const text = `before\n${PEM}\nafter`;
  const cuts = [];
  for (let at = 5; at < text.length; at += 7) cuts.push(at);
  const joined = streamThrough(text, cuts).join('');
  assert.ok(!joined.includes('MIIEowIBAAKCAQEA'));
  assert.equal(joined, `before\n${M('pem-private-key')}\nafter`);
});

test('an over-long PEM body is cut off with one marker and nothing after it leaks', () => {
  const body = 'QUJD'.repeat(5000);
  const text = `-----BEGIN ${'PRIVATE'} KEY-----\n${body}\n-----END ${'PRIVATE'} KEY-----\nvisible`;
  const cuts = [];
  for (let at = 1000; at < text.length; at += 1000) cuts.push(at);
  const joined = streamThrough(text, cuts).join('');
  assert.ok(!joined.includes('QUJDQUJD'));
  assert.ok(joined.includes(M('pem-private-key')) && joined.endsWith('visible'));
});

test('a long line without breaks still streams with at most 4 KiB held back', () => {
  const masker = new DisplayStreamMasker();
  const word = 'lorem ';
  let held = 0;
  for (let index = 0; index < 2000; index += 1) {
    const frames = prepareDisplayFrames({ kind: 'stream_delta', sessionId: 'long', content: word }, 'long', masker);
    held += word.length - String((frames?.viewer as { content: string }).content).length;
    assert.ok(held <= 4096 + word.length);
  }
});

test('stream state is bounded and swept after 10 idle minutes', () => {
  let now = 0;
  quietSources({ now: () => now });
  const masker = new DisplayStreamMasker();
  for (let index = 0; index < 2100; index += 1) masker.push(`k${index}`, 'partial', null, {});
  assert.equal(masker.size(), 2000);
  now += 10 * 60 * 1000 + 61_000;
  masker.push('fresh', 'x', null, {});
  assert.equal(masker.size(), 1);
});

test('frames: unmasked kinds pass untouched, permission input stays raw for the requester', () => {
  for (const kind of ['status', 'session_created', 'permission_cancelled', 'workflow_settled']) {
    assert.equal(prepareDisplayFrames({ kind, sessionId: 's', text: SK }, 's'), null, kind);
  }
  const request = { kind: 'permission_request', sessionId: 's', requestId: 'r', toolName: 'Bash', input: { command: `echo ${SK}` } };
  const frames = prepareDisplayFrames(request, 's');
  assert.equal(frames?.owner, request);
  assert.ok(!JSON.stringify(frames?.viewer).includes(SK));
  assert.equal(prepareDisplayFrames({ kind: 'text', content: SK }, null), null, 'no session, no masking');
});

test('kill switches: env 0 wins, the admin setting turns it off, default is on', () => {
  assert.equal(isDisplayMaskingEnabled(), true);
  quietSources({ env: () => '0' });
  assert.equal(isDisplayMaskingEnabled(), false);
  assert.equal(prepareDisplayFrames({ kind: 'text', sessionId: 's', content: SK }, 's'), null);
  quietSources({ readSetting: () => 'false' });
  assert.equal(isDisplayMaskingEnabled(), false);
  assert.equal(maskDisplayLabel(`title ${SK}`), `title ${SK}`);
  quietSources({ readSetting: () => { throw new Error('db'); } });
  assert.equal(isDisplayMaskingEnabled(), true, 'an unreadable setting never disables masking');
});

test('history revision folds in the mask version', () => {
  assert.equal(DISPLAY_MASK_VERSION, 2);
  const raw = 'abc';
  assert.notEqual(displayHistoryRevision(raw), raw);
  assert.equal(displayHistoryRevision(raw), displayHistoryRevision(raw));
  assert.notEqual(displayHistoryRevision(raw), displayHistoryRevision('abd'));
  const before = displayHistoryRevision(raw);
  quietSources({ serviceLiterals: () => [LITERAL, 'a-newly-added-member-key-0001'] });
  assert.notEqual(displayHistoryRevision(raw), before, 'a new known value changes the revision');
});

test('replay sends exactly the frames live viewers saw, looked up by sessionId:sequence', () => {
  const live = [
    { kind: 'stream_delta', id: 'l1', sequence: 1, sessionId: 'r', content: `key ${SK.slice(0, 12)}` },
    { kind: 'stream_delta', id: 'l2', sequence: 2, sessionId: 'r', content: `${SK.slice(12)} end` },
    { kind: 'stream_end', id: 'l3', sequence: 3, sessionId: 'r' },
  ];
  // Live delivery masks a COPY (as the clientMsgId echo does); the ring keeps the originals.
  const liveViews = live.map((payload) => prepareDisplayFrames({ ...payload, clientMsgId: 'c' }, 'r'));
  const sent: unknown[] = [];
  const sink = createDisplayReplaySink((payload) => sent.push(payload), { sessionId: 'r' });
  for (const payload of live) sink(payload);
  sink.finish();
  const contentOf = (frames: unknown[]) => frames.map((f) => (f as { content?: string }).content ?? '').join('');
  const expected = liveViews.flatMap((frames) => [...(frames?.before ?? []), frames?.viewer]).filter(Boolean);
  assert.equal(contentOf(sent), contentOf(expected), 'same text as live viewers');
  assert.ok(!JSON.stringify(sent).includes(SK.slice(0, 12)) && !JSON.stringify(sent).includes(SK.slice(12, 24)));
});

test('C1: unrecorded replay frames go through ONE stateful masker per pass, flushed at the end', () => {
  const ring = [
    { kind: 'stream_delta', id: 'u1', sequence: 11, content: 'Your key is sk-ant-api03-Ab1C' },
    { kind: 'stream_delta', id: 'u2', sequence: 12, content: 'd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv now' },
  ];
  const sent: unknown[] = [];
  const sink = createDisplayReplaySink((payload) => sent.push(payload), { sessionId: 'never-live' });
  for (const payload of ring) sink(payload);
  sink.finish();
  const text = sent.map((f) => (f as { content?: string }).content ?? '').join('');
  assert.equal(text, `Your key is ${M('anthropic-openai-key')} now`);
  for (const fragment of ['api03', 'Ab1C', 'd2Ef3Gh4', 'St0Uv']) assert.ok(!JSON.stringify(sent).includes(fragment), fragment);
});

test('replay keeps a permission prompt raw only where keepRaw says the viewer owns the run', () => {
  const request = { kind: 'permission_request', sessionId: 'p', requestId: 'own', input: { command: `echo ${SK}` } };
  const other = { ...request, requestId: 'other' };
  const sent: unknown[] = [];
  const sink = createDisplayReplaySink((payload) => sent.push(payload), { keepRaw: (frame) => frame.requestId === 'own' });
  sink(request);
  sink(other);
  assert.equal(sent[0], request);
  assert.ok(!JSON.stringify(sent[1]).includes(SK));
});

test('property: long risky lines over the 4 KiB hold stream identically to whole-text masking', () => {
  let seed = 19;
  const next = (bound: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % bound; };
  const secrets = [SK, GHP, JWT, GOOGLE, STRIPE];
  for (let round = 0; round < 40; round += 1) {
    const words: string[] = [];
    while (words.join(' ').length < 5000 + next(9000)) {
      const roll = next(40);
      words.push(roll === 0 ? secrets[next(secrets.length)] : roll === 1 ? `"api_key": "${secrets[next(secrets.length)]}"` : `w${next(1000)}`);
    }
    // Odd rounds: one enclosing quote (held up to 16 KiB); even rounds: a risky
    // line with balanced quotes, cut at safe blanks once it passes 4 KiB.
    const text = round % 2 ? `{"line": "${words.join(' ')}"}\n` : `| ${words.join(' ')}\n`;
    const cuts: number[] = [];
    for (let at = 1 + next(700); at < text.length; at += 1 + next(700)) cuts.push(at);
    const frames = streamThrough(text, cuts);
    assert.equal(frames.join(''), mask(text), `round ${round}`);
    for (const secret of secrets) {
      for (const frame of frames) assert.ok(!frame.includes(secret.slice(4, 16)), 'no fragment');
    }
  }
});

test('past the 16 KiB ceiling a line without blanks is cut, still without a raw fragment', () => {
  const text = `${'A'.repeat(15000)}/${SK}/${'B'.repeat(9000)}\nend`;
  const cuts: number[] = [];
  for (let at = 500; at < text.length; at += 500) cuts.push(at);
  const frames = streamThrough(text, cuts);
  for (const frame of frames) assert.ok(!frame.includes('AbCdEfGh') && !frame.includes('api03'), 'no fragment');
});

test('C4: rename restore refuses a marker moved out of the context that masks it', () => {
  assert.equal(restoreMaskedLabel(`leak: ${M('assignment')}`, 'PASSWORD=hunter2xyz9 note'), `leak: ${M('assignment')}`);
  assert.equal(restoreMaskedLabel(`x ${M('bearer')}`, 'Authorization: Bearer abcDEF123456'), `x ${M('bearer')}`);
  assert.equal(restoreMaskedLabel(`PASSWORD=${M('assignment')} renamed`, 'PASSWORD=hunter2xyz9 note'), 'PASSWORD=hunter2xyz9 renamed',
    'a value kept in its masking context is restored');
});

test('rename round-trip: a title edited from its masked form keeps the stored raw values', () => {
  const stored = `deploy with OPENAI_API_KEY=abc123zz and ${SK}`;
  const shown = mask(stored);
  assert.equal(restoreMaskedLabel(shown, stored), stored, 'unchanged masked title restores the raw one');
  assert.equal(restoreMaskedLabel(`prod ${shown}`, stored), `prod ${stored}`, 'edited text around the markers');
  const swapped = `${M('anthropic-openai-key')} ${M('assignment')}`;
  assert.equal(restoreMaskedLabel(swapped, stored), swapped, 'markers out of order are not resolved');
  assert.equal(restoreMaskedLabel(`x ${M('assignment')}`, 'nothing secret'), `x ${M('assignment')}`);
  assert.equal(restoreMaskedLabel('plain new title', stored), 'plain new title');
});

test('the btw sink masks streamed chunks, flushes the tail before the terminal frame', () => {
  const sent: Array<Record<string, unknown>> = [];
  const sink = createBtwDisplaySink((payload) => sent.push(payload));
  sink({ type: 'btw-accepted', btwId: 'b' });
  sink({ type: 'btw-chunk', btwId: 'b', text: `the key is ${SK.slice(0, 14)}` });
  sink({ type: 'btw-chunk', btwId: 'b', text: `${SK.slice(14)} ok` });
  sink({ type: 'btw-complete', btwId: 'b', text: `the key is ${SK} ok` });
  sink({ type: 'btw-forked', btwId: 'b', title: `fork ${SK}` });
  assert.ok(!JSON.stringify(sent).includes('api03'));
  const chunks = sent.filter((m) => m.type === 'btw-chunk').map((m) => m.text).join('');
  assert.equal(chunks, `the key is ${M('anthropic-openai-key')} ok`);
  assert.equal(sent.find((m) => m.type === 'btw-complete')?.text, chunks, 'chunks agree with the final answer');
});

test('pending permissions: entries the viewer owns stay raw, the rest are masked', () => {
  const entries = [
    { requestId: 'a', ownerUserId: 1, input: { command: SK } },
    { requestId: 'b', ownerUserId: 2, input: { command: SK } },
  ];
  const owner = (entry: Record<string, unknown>) => entry.ownerUserId;
  const forOne = maskPendingPermissionsFor(entries, 1, 's', owner);
  assert.equal(forOne[0], entries[0]);
  assert.ok(!JSON.stringify(forOne[1]).includes(SK));
  assert.ok(!JSON.stringify(maskPendingPermissionsFor(entries, null, 's', owner)).includes(SK));
});

test('maskSessionText masks agent report text and respects the kill switch', () => {
  assert.equal(maskSessionText(`report ${SK}`, 's'), `report ${M('anthropic-openai-key')}`);
  assert.equal(maskSessionText(null, 's'), null);
  quietSources({ env: () => '0' });
  assert.equal(maskSessionText(`report ${SK}`, 's'), `report ${SK}`);
});

test('4 MiB of adversarial input masks in < 500 ms', () => {
  const MiB = 1024 * 1024;
  const parts = [
    'a'.repeat(MiB / 4), 'a='.repeat(MiB / 8), 'token:'.repeat(MiB / 24), 'password: x1 '.repeat(MiB / 26),
    '\\"secret\\":\\"'.repeat(MiB / 64), '"password":"'.repeat(MiB / 48), '| password |'.repeat(MiB / 48),
    'eyJ'.repeat(MiB / 24) + '.', '-----BEGIN ' + 'PRIVATE KEY-----' + 'A-'.repeat(MiB / 16),
    'http://u:'.repeat(MiB / 36), 'Bearer '.repeat(MiB / 28), 'xoxb-'.repeat(MiB / 20), 'AIza'.repeat(MiB / 16),
    'sk_live_'.repeat(MiB / 32), `${LITERAL.slice(0, 20)} `.repeat(MiB / 84),
  ];
  let input = parts.join('\n');
  input = input.length >= 4 * MiB ? input.slice(0, 4 * MiB) : input + 'x '.repeat((4 * MiB - input.length) / 2);
  const t0 = performance.now();
  mask(input);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms`);
});

/** Every content a viewer received for the frames, in order. */
function viewed(framesList: Array<ReturnType<typeof prepareDisplayFrames>>): Array<Record<string, unknown>> {
  return framesList.flatMap((frames) => [...(frames?.before ?? []), frames?.viewer]).filter(Boolean) as Array<Record<string, unknown>>;
}

test('C2: interleaved main and subagent streams never leak a split key', () => {
  const masker = new DisplayStreamMasker();
  const sub = { parentToolUseId: 'toolu_sub' };
  const frames = [
    { kind: 'stream_delta', sessionId: 'c2', content: 'main says sk-' },
    { kind: 'stream_delta', sessionId: 'c2', ...sub, content: 'sub prints ghp_Ab1Ab1' },
    { kind: 'stream_delta', sessionId: 'c2', content: 'ant-api03-AbCdEfGh' },
    { kind: 'stream_delta', sessionId: 'c2', ...sub, content: 'Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1 done\n' },
    { kind: 'stream_delta', sessionId: 'c2', content: 'IjKlMnOpQrStUvWx end' },
    { kind: 'stream_end', sessionId: 'c2', ...sub },
    { kind: 'stream_end', sessionId: 'c2' },
  ].map((frame) => prepareDisplayFrames(frame, 'c2', masker));
  const out = viewed(frames);
  const main = out.filter((f) => !f.parentToolUseId).map((f) => f.content ?? '').join('');
  const subText = out.filter((f) => f.parentToolUseId).map((f) => f.content ?? '').join('');
  assert.equal(main, `main says ${M('anthropic-openai-key')} end`);
  assert.equal(subText, `sub prints ${M('github-token')} done\n`);
  for (const f of out) assert.ok(!/api03|AbCdEf|Ab1Ab1Ab1/.test(String(f.content ?? '')), String(f.content));
});

test('I2: a provider without stream_end releases the tail on its next message; thinking has its own channel', () => {
  const masker = new DisplayStreamMasker();
  const frames = [
    { kind: 'thinking', provider: 'qwen', sessionId: 'i2', content: 'the key sk-ant-api03-' },
    { kind: 'thinking', provider: 'qwen', sessionId: 'i2', content: 'AbCdEfGhIjKlMnOpQrStUvWx is set' },
    { kind: 'stream_delta', provider: 'kimi', sessionId: 'i2', content: 'Done with ghp_Ab1' },
    { kind: 'stream_delta', provider: 'kimi', sessionId: 'i2', content: 'Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1' },
    { kind: 'tool_use', provider: 'kimi', sessionId: 'i2', toolName: 'Bash', toolInput: { command: 'ls' } },
  ].map((frame) => prepareDisplayFrames(frame, 'i2', masker));
  const out = viewed(frames);
  const thinking = out.filter((f) => f.kind === 'thinking').map((f) => f.content).join('');
  const text = out.filter((f) => f.kind === 'stream_delta').map((f) => f.content).join('');
  assert.equal(thinking, `the key ${M('anthropic-openai-key')} is set`, 'the thinking tail is released when text starts');
  assert.equal(text, `Done with ${M('github-token')}`, 'the text tail is released before the tool_use');
  assert.equal(out.at(-1)?.kind, 'tool_use');
  assert.ok(!JSON.stringify(out).includes('api03') && !JSON.stringify(out).includes('Ab1Ab1'));
  // Claude thinking frames are whole blocks: masked as one message, nothing held.
  const whole = prepareDisplayFrames({ kind: 'thinking', provider: 'claude', sessionId: 'i2', content: `plan ${SK}` }, 'i2', masker);
  assert.equal((whole?.viewer as { content: string }).content, `plan ${M('anthropic-openai-key')}`);
});

test('C3: every free-text field is masked (subagent tools, plan and status text), ids are not', () => {
  const message = {
    id: SK, sessionId: 's', kind: 'tool_use', toolName: 'Task',
    subagentTools: [{ toolName: 'Bash', toolInput: { command: `curl -H "Authorization: Bearer ${SK}"` }, toolResult: { content: `token ${GHP}` } }],
    plan: { items: [{ label: `rotate ${SK}`, status: 'done' }] },
    subagent: { label: `agent with ${GHP}` },
    status: `running with ${SK}`,
    aFieldNobodyListed: { deep: [`x ${SK}`] },
  };
  const out = maskMessage(message, {});
  const { id, ...rest } = out;
  assert.equal(id, SK, 'identity fields are not walked');
  assert.ok(!JSON.stringify(rest).includes(SK) && !JSON.stringify(rest).includes(GHP), JSON.stringify(rest));
});

test('I1: an answer built from a masked view keeps the recorded input and takes only the answers', () => {
  const recorded = { questions: [{ question: `Use ${SK}?` }], answers: {} };
  const fromMaskedView = { questions: [{ question: `Use ${M('anthropic-openai-key')}?` }], answers: { q: 'yes' } };
  assert.deepEqual(restoreMaskedUpdatedInput(fromMaskedView, recorded), { questions: recorded.questions, answers: { q: 'yes' } });
  assert.deepEqual(restoreMaskedUpdatedInput({ command: `echo ${M('assignment')}` }, { command: 'echo X=1' }), { command: 'echo X=1' });
  const clean = { command: 'ls -la' };
  assert.equal(restoreMaskedUpdatedInput(clean, { command: 'ls' }), clean, 'an edit without markers is kept');
});

test('I3: long streamed lines stay linear (200 KB in 30-char deltas, 1.2 MB in 4-char deltas)', () => {
  const jsonLine = (size: number) => {
    const parts: string[] = [];
    for (let index = 0, length = 0; length < size; index += 1) {
      parts.push(`"field${index}": "value ${index} with words"`);
      length += parts.at(-1)!.length + 2;
    }
    return `{${parts.join(', ')}}\n`;
  };
  for (const [text, step, budget] of [[jsonLine(200_000), 30, 500], [jsonLine(1_200_000), 4, 500]] as const) {
    const masker = new DisplayStreamMasker();
    const t0 = performance.now();
    let emitted = '';
    for (let at = 0; at < text.length; at += step) {
      emitted += (prepareDisplayFrames({ kind: 'stream_delta', sessionId: 'perf', content: text.slice(at, at + step) }, 'perf', masker)?.viewer as { content: string }).content;
    }
    for (const f of viewed([prepareDisplayFrames({ kind: 'stream_end', sessionId: 'perf' }, 'perf', masker)])) emitted += f.content ?? '';
    const elapsed = performance.now() - t0;
    console.log(`[perf] ${text.length} chars in ${step}-char deltas: ${elapsed.toFixed(0)} ms`);
    assert.equal(emitted, mask(text));
    assert.ok(elapsed < budget, `took ${elapsed.toFixed(0)} ms`);
  }
});

test('I4: an apostrophe in prose does not hold the line; a quoted value does', () => {
  const masker = new DisplayStreamMasker();
  const first = prepareDisplayFrames({ kind: 'stream_delta', sessionId: 'i4', content: "I don't think so, it's fine " }, 'i4', masker);
  assert.equal((first?.viewer as { content: string }).content, "I don't think so, it's fine ");
  const quoted = prepareDisplayFrames({ kind: 'stream_delta', sessionId: 'i4b', content: 'PASSWORD="my secret pass' }, 'i4b', masker);
  assert.equal((quoted?.viewer as { content: string }).content, '', 'a quote opening a value holds the line');
});

test('I6: a report clipped at the size cap drops its partial last line before masking', () => {
  const clipped = `line one\nkey ${SK.slice(0, 14)}`;
  assert.equal(maskClippedSessionText(clipped, true, null), 'line one\n');
  assert.equal(maskClippedSessionText(clipped, false, null), clipped, 'an unclipped text is masked as usual');
});

test('numeric table cells and assignments are not credentials unless the name is password-like', () => {
  assert.equal(mask('| Token budget | 200000 |'), '| Token budget | 200000 |');
  assert.equal(mask('MAX_TOKENS_KEY=4096'), 'MAX_TOKENS_KEY=4096');
  assert.equal(mask('| password | 123456 |'), `| password | ${M('table-cell')} |`);
  assert.equal(mask('DB_PASSWORD=12345678'), `DB_PASSWORD=${M('assignment')}`);
});

/** Masks `text` streamed in `chunks` (with a final stream_end); returns the joined viewer text. */
function streamChunks(chunks: string[]): string {
  const masker = new DisplayStreamMasker();
  const frames = chunks.map((content) => prepareDisplayFrames({ kind: 'stream_delta', sessionId: 'h1', content }, 'h1', masker));
  frames.push(prepareDisplayFrames({ kind: 'stream_end', sessionId: 'h1' }, 'h1', masker));
  return viewed(frames).map((f) => f.content ?? '').join('');
}

test('H1: a quoted multi-word value whose opener came in an earlier delta is held and masked whole', () => {
  assert.equal(streamChunks(['password = ', '"correct horse ', 'battery staple"\n']), `password = ${M('assignment')}\n`);
  assert.equal(streamChunks(['{"api_key": ', '"two words ', 'secret here"}\n']), `{"api_key": "${M('json-field')}"}\n`);
  assert.equal(streamChunks(['export DB_PASSWORD=', "'my long ", "pass phrase'\n"]), `export DB_PASSWORD=${M('assignment')}\n`);
});

test('H1: randomized 1-6 char chunking always equals whole-text masking (0 divergence)', () => {
  const lines = [
    'password = "correct horse battery staple" and more text\n',
    '{"api_key": "two words secret here", "user": "bob"}\n',
    `Authorization: Bearer ${GHP} done\n`,
    `export OPENAI_API_KEY='a b c d' then ${SK} ok\n`,
    '| password | hunter2 secret | note |\n',
    "I don't think it's a key, it's prose with quotes \"like this\".\n",
    `Cookie: sid=abc123; theme=dark\nnext line ${JWT}\n`,
    `url postgres://app:s3cretpw@db:5432/x and token: "x y z w"\n`,
    `${PEM}\ntrailing\n`,
  ];
  let seed = 23;
  const next = (bound: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % bound; };
  let divergent = 0;
  let cases = 0;
  for (let round = 0; round < 400; round += 1) {
    for (const line of lines) {
      const text = round % 3 === 0 ? line : `${line}${lines[next(lines.length)]}`;
      const chunks: string[] = [];
      for (let at = 0; at < text.length;) { const size = 1 + next(6); chunks.push(text.slice(at, at + size)); at += size; }
      cases += 1;
      if (streamChunks(chunks) !== mask(text)) divergent += 1;
    }
  }
  assert.ok(cases > 3000, `${cases} cases`);
  assert.equal(divergent, 0, `${divergent}/${cases} divergent`);
});

test('T2: a long numeric value under a key/token/secret name is still a credential', () => {
  assert.equal(mask('API_KEY=1234567890123456'), `API_KEY=${M('assignment')}`);
  assert.equal(mask('| access token | 98765432109876543210 |'), `| access token | ${M('table-cell')} |`);
  assert.equal(mask('MAX_TOKENS_KEY=4096'), 'MAX_TOKENS_KEY=4096', 'a short count is not');
});

test('M2: the organisation shared vendor keys are in the known-value set', () => {
  const SHARED = 'shared-org-deepseek-key-0123456789';
  quietSources({ sharedVendorLiterals: () => [SHARED] });
  assert.equal(maskDisplayLabel(`uses ${SHARED}`), `uses ${M('known-secret')}`);
  quietSources({ sharedVendorLiterals: () => { throw new Error('store down'); } });
  assert.equal(maskDisplayLabel('uses nothing'), 'uses nothing', 'an unreadable store never throws');
});
