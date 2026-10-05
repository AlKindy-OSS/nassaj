/**
 * ADR-196 / T-1970 stage 7: adversarial and end-to-end tests of read-only session shares
 * against the REAL stack (production runtime, repositories, snapshot pipeline, JWT
 * verifier) on a temp database and a real-format Claude JSONL in a temp HOME.
 * The browser half lives in tests/e2e/session-share-real-stack.browser.test.ts.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import {
  DAY_MS, SANDBOX_HOME, advanceClock, claudeRows, startRealStack, type RealStack, type StackUser,
} from '../../tests/helpers/session-share-real-stack.js';

let stack: RealStack;
let admin: StackUser;
let admin2: StackUser;
let platformOwner: StackUser;
let member: StackUser;
let outsider: StackUser;

before(async () => {
  stack = await startRealStack();
  platformOwner = stack.createUser('platform-owner', 'owner');
  admin = stack.createUser('admin', 'admin');
  admin2 = stack.createUser('admin2', 'admin');
  member = stack.createUser('member', 'user');
  outsider = stack.createUser('outsider', 'user');
});
after(async () => { await stack.close(); });

const hello = () => [claudeRows.user('hello from the owner'), claudeRows.assistant([claudeRows.text('hi there')])];
const sessionOf = (rows = hello()) => stack.seedSession(member, rows);

/** Header map without volatile fields, for byte-identity comparisons. */
function stableHeaders(headers: Headers): string {
  return JSON.stringify([...headers.entries()].filter(([name]) => name !== 'date').sort());
}

// ---------------------------------------------------------------------------
// Secret leakage through the real pipeline
// ---------------------------------------------------------------------------

/** Secrets are assembled at runtime so no source line looks like a real credential. */
const SECRETS = {
  anthropic: ['sk-ant-', 'api03-Zq9XvB2mK7pLw4RtYu8NcHs3DfGjA1eO6iVbT5xMn0QrCyWk'].join(''),
  github: ['ghp_', 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ'].join(''),
  aws: ['AKIA', 'IOSFODNN7REALKEY'].join(''),
  awsSecret: ['wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYREALSECRETKEY'].join(''),
  jwt: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiJyZWFsc3RhY2siLCJuYW1lIjoiU2VjcmV0In0',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.'),
  jsonPassword: 'Tr0ub4dor&3-JsonPw-xYz',
  yamlPassword: 'Yaml-Passw0rd-Zz91',
  envToken: 'envTokenValue-9f8e7d6c5b4a',
  tableToken: 'table-secret-77aa88bb99cc',
  urlPassword: 'UrlP4ssw0rdQ7',
  urlQuery: 'qt-3c4d5e6f7a8b9c0d1e2f',
  pemBody: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7REALPEMBODY',
  tailscale: '100.101.102.103',
  nassajUsersPath: '/home/operator/.nassaj-users/1/.claude/settings.json',
};
const PEM = `-----BEGIN ${'PRIVATE KEY'}-----\n${SECRETS.pemBody}\n-----END ${'PRIVATE KEY'}-----`;

/** One block carrying every secret format; each context gets its own unique marker value too. */
function secretBlock(tag: string): string {
  return [
    `{"api_key": "${SECRETS.anthropic}", "password": "${SECRETS.jsonPassword}", "tag": "${tag}"}`,
    `db_password: ${SECRETS.yamlPassword}`,
    `AWS_SECRET_ACCESS_KEY=${SECRETS.awsSecret}`,
    `API_TOKEN=${SECRETS.envToken}`,
    `| name | value |\n|---|---|\n| token | ${SECRETS.tableToken} |`,
    `curl https://deploy:${SECRETS.urlPassword}@git.example.com/repo.git?token=${SECRETS.urlQuery}`,
    `github ${SECRETS.github} and aws ${SECRETS.aws}`,
    `Authorization: Bearer ${SECRETS.jwt}`,
    PEM,
    `tailscale node ${SECRETS.tailscale}`,
    `config at ${SECRETS.nassajUsersPath} and ${SANDBOX_HOME}/.ssh/id_rsa`,
  ].join('\n');
}

test('secrets in every transcript context never reach the public JSON', async () => {
  const dropped = ['TOOLUSE-ONLY-SECRET-aa11', 'TOOLRESULT-ONLY-SECRET-bb22', 'THINKING-ONLY-SECRET-cc33',
    'SUBAGENT-ONLY-SECRET-dd44', 'REMINDER-ONLY-SECRET-ee55', 'SIDECHAIN-ASSISTANT-ff66'];
  const rows = [
    claudeRows.user(`user text\n${secretBlock('user')}`),
    claudeRows.assistant([claudeRows.text(`assistant text\n${secretBlock('assistant')}`)]),
    claudeRows.assistant([claudeRows.thinking(`${dropped[2]} ${secretBlock('thinking')}`)]),
    claudeRows.assistant([claudeRows.toolUse('toolu_1', { command: `export TOKEN=${dropped[0]} ${secretBlock('tool')}` })]),
    claudeRows.toolResult('toolu_1', `${dropped[1]} ${secretBlock('result')}`),
    claudeRows.user(`question <system-reminder>${dropped[4]} ${secretBlock('reminder')}</system-reminder> tail`),
    claudeRows.user(`${dropped[3]} ${secretBlock('subagent')}`, { isSidechain: true, agentId: 'a1' }),
    claudeRows.assistant([claudeRows.text(`${dropped[5]} ${secretBlock('sidechain')}`)], { isSidechain: true, agentId: 'a1' }),
    claudeRows.assistant([claudeRows.text('final answer')]),
  ];
  const { sessionId, projectPath } = sessionOf(rows);

  const shown = await stack.preview(member, sessionId);
  assert.equal(shown.status, 200, shown.text);
  assert.ok(shown.json.counts.secret > 0, 'the preview reports redactions');
  const created = await stack.create(member, sessionId);
  assert.equal(created.status, 201, created.text);
  const read = await stack.read(created.id!, created.token!);
  assert.equal(read.status, 200);

  for (const [label, body] of [['preview', shown.text], ['public read', read.text]] as const) {
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.ok(!body.includes(value), `${label} leaks ${name}`);
    }
    for (const marker of dropped) {
      assert.ok(!body.includes(marker), `${label} leaks dropped context ${marker}`);
    }
    for (const forbidden of [SANDBOX_HOME, projectPath, sessionId, '.nassaj-users', 'toolu_', 'claude-test', 'signature']) {
      assert.ok(!body.includes(forbidden), `${label} leaks ${forbidden}`);
    }
  }
  assert.ok(read.text.includes('final answer'), 'ordinary text still travels');
  assert.ok(read.text.includes('user text'), 'ordinary user text still travels');
  // The share record holds a token digest only; the token itself is in no list nor audit entry.
  const mine = await stack.call('GET', '/api/session-shares/mine', { user: member });
  assert.equal(mine.status, 200);
  assert.ok(!mine.text.includes(created.token!) && !mine.text.includes('token_hash') && !mine.text.includes('snapshot"'));
  assert.ok(!JSON.stringify(stack.audits).includes(created.token!));
});

// D1 (fixed): the Claude reader tags sidechain/agentId/parent_tool_use_id/synthetic rows; the snapshot drops them.
test('D1: subagent rows of a Claude transcript are excluded from the public snapshot', async () => {
  const rows = [
    claudeRows.user('MAIN-USER-PROMPT'),
    claudeRows.user('SC-USER-PROMPT-TO-SUBAGENT', { isSidechain: true, agentId: 'a1' }),
    claudeRows.assistant([claudeRows.text('SC-ASSISTANT-ANSWER')], { isSidechain: true, agentId: 'a1' }),
    claudeRows.assistant([claudeRows.text('PARENT-SNAKE-ASSISTANT')], { parent_tool_use_id: 'toolu_1' }),
    claudeRows.user('PARENT-SNAKE-USER', { parent_tool_use_id: 'toolu_1' }),
    claudeRows.user('PARENT-CAMEL-USER', { parentToolUseId: 'toolu_1' }),
    claudeRows.user('AGENT-ID-ONLY-USER', { agentId: 'a2' }),
    claudeRows.assistant([claudeRows.text('SYNTHETIC-ASSISTANT')], { isSynthetic: true }),
    claudeRows.assistant([claudeRows.text('MAIN-ASSISTANT-ANSWER')]),
  ];
  const { sessionId } = sessionOf(rows);
  const shown = await stack.preview(member, sessionId);
  const texts = shown.json.snapshot.messages.map((message: { parts: Array<{ text?: string }> }) => message.parts.map((p) => p.text).join(''));
  assert.deepEqual(texts, ['MAIN-USER-PROMPT', 'MAIN-ASSISTANT-ANSWER']);
});

test('the share is a frozen snapshot: later transcript changes and tampering do not alter it', async () => {
  const { sessionId, file } = sessionOf();
  const created = await stack.create(member, sessionId);
  assert.equal(created.status, 201, created.text);
  const before = (await stack.read(created.id!, created.token!)).text;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, `${JSON.stringify(claudeRows.user('LATER-MESSAGE-AFTER-SHARE'))}\n`);
  const after = (await stack.read(created.id!, created.token!)).text;
  assert.equal(after, before);
  assert.ok(!after.includes('LATER-MESSAGE'));
});

// ---------------------------------------------------------------------------
// Authorization and enumeration
// ---------------------------------------------------------------------------

test('management matrix on a real session: owner, platform owner, admin create; member and outsider are refused', async () => {
  const { sessionId } = sessionOf();
  assert.equal((await stack.preview(outsider, sessionId)).status, 403);
  const refusedCreate = await stack.call('POST', `/api/sessions/${sessionId}/shares`, { user: outsider,
    body: { expiry: '30d', upToMessageId: 'x', previewSha256: 'a'.repeat(64), reviewedRedactions: true } });
  assert.equal(refusedCreate.status, 403);
  assert.deepEqual(refusedCreate.json, { error: { code: 'ACCESS_DENIED' } });
  assert.equal((await stack.create(member, sessionId)).status, 201, 'session owner');
  assert.equal((await stack.create(platformOwner, sessionId)).status, 201, 'platform owner on another user\'s session');
  stack.audits.length = 0;
  const byAdmin = await stack.create(admin, sessionId);
  assert.equal(byAdmin.status, 201, byAdmin.text);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const notified = stack.audits.find((entry) => entry.action === 'session_share_owner_notified');
  assert.ok(notified, 'the session owner is notified when an admin shares their session');
  assert.equal(notified.userId, admin.id);
  assert.equal(notified.metadata.ownerUserId, member.id);
  assert.ok(stack.audits.some((entry) => entry.action === 'session_share_created' && entry.userId === admin.id));
  stack.audits.length = 0;
  await stack.create(member, sessionId);
  assert.ok(!stack.audits.some((entry) => entry.action === 'session_share_owner_notified'), 'no self-notification');
  assert.equal((await stack.preview(member, 'does-not-exist-session')).status, 404);
  assert.equal((await stack.preview(member, 'bad id with spaces')).status, 404);
});

test('authentication edge cases on the real verifier: anonymous, stale generation, cookie-only, cookie plus Bearer', async () => {
  const { sessionId } = sessionOf();
  assert.equal((await stack.call('POST', `/api/sessions/${sessionId}/shares/preview`, { body: {} })).status, 401);
  assert.equal((await stack.call('POST', `/api/sessions/${sessionId}/shares/preview`,
    { auth: stack.bearer(member, { auth_gen: 0 }), body: {} })).status, 401);
  assert.equal((await stack.call('POST', `/api/sessions/${sessionId}/shares/preview`,
    { auth: 'Bearer not.a.jwt', body: {} })).status, 401);
  assert.equal((await stack.call('POST', `/api/sessions/${sessionId}/shares/preview`,
    { auth: stack.bearer(member).replace('Bearer', 'bearer'), body: {} })).status, 401);
  process.env.TEST_DEVICE_COOKIES = '1';
  try {
    const cookie = { 'Cookie': '__Host-nassaj_device=abcdef' };
    assert.equal((await stack.call('POST', `/api/sessions/${sessionId}/shares/preview`, { headers: cookie, body: {} })).status, 401);
    assert.equal((await stack.call('POST', `/api/sessions/${sessionId}/shares/preview`,
      { user: member, headers: cookie, body: {} })).status, 400);
  } finally {
    delete process.env.TEST_DEVICE_COOKIES;
  }
  const disabled = stack.createUser('soon-disabled', 'user');
  const own = stack.seedSession(disabled, hello());
  assert.equal((await stack.preview(disabled, own.sessionId)).status, 200);
  const header = stack.bearer(disabled);
  stack.userDb.setStatus(disabled.id, 'disabled');
  const after = await stack.call('POST', `/api/sessions/${own.sessionId}/shares/preview`, { auth: header, body: {} });
  assert.equal(after.status, 401, 'a disabled account loses its Bearer');
});

test('lists and revocation never widen access; unknown and foreign shares look the same', async () => {
  const { sessionId } = sessionOf();
  const mine = await stack.create(member, sessionId);
  const byAdmin = await stack.create(admin, sessionId);
  const listAs = async (user: StackUser) => (await stack.call('GET', `/api/sessions/${sessionId}/shares`, { user })).json.shares
    .map((share: { id: string }) => share.id).sort();
  assert.deepEqual(await listAs(member), [mine.id, byAdmin.id].sort(), 'owner sees every share of the session');
  assert.deepEqual(await listAs(outsider), [], 'outsider sees nothing');
  assert.deepEqual(await listAs(admin2), [mine.id, byAdmin.id].sort(), 'an admin manages every session');
  const unknownSession = await stack.call('GET', '/api/sessions/no-such-session/shares', { user: outsider });
  assert.deepEqual(unknownSession.json, { shares: [] }, 'no existence oracle');
  const eligibility = await stack.call('GET', `/api/sessions/${sessionId}/shares/eligibility`, { user: outsider });
  assert.deepEqual(eligibility.json, { canShare: false, canManage: false });

  const denied = await stack.call('POST', `/api/session-shares/${mine.id}/revoke`, { user: outsider });
  const unknown = await stack.call('POST', `/api/session-shares/${'e'.repeat(32)}/revoke`, { user: outsider });
  const malformed = await stack.call('POST', '/api/session-shares/not-an-id/revoke', { user: outsider });
  for (const response of [denied, unknown, malformed]) {
    assert.equal(response.status, 404);
    assert.equal(response.text, '{"error":{"code":"SHARE_UNAVAILABLE"}}');
  }
  assert.equal((await stack.read(mine.id!, mine.token!)).status, 200, 'the refused revoke changed nothing');
  assert.equal((await stack.call('POST', `/api/session-shares/${mine.id}/revoke`, { user: member })).status, 204);
  assert.equal((await stack.read(mine.id!, mine.token!)).status, 404);
  assert.equal((await stack.read(byAdmin.id!, byAdmin.token!)).status, 200, 'revoking one share leaves the other');
});

test('public read: a token opens only its own share, and every refusal is byte-identical', async () => {
  const a = sessionOf();
  const b = sessionOf();
  const shareA = await stack.create(member, a.sessionId);
  const shareB = await stack.create(member, b.sessionId);
  const revoked = await stack.create(member, a.sessionId);
  await stack.call('POST', `/api/session-shares/${revoked.id}/revoke`, { user: member });
  const expired = await stack.create(member, a.sessionId, { expiry: '24h' });

  const refusals: Array<[string, string, string | null]> = [
    ['token of B on A', shareA.id!, shareB.token!],
    ['token of A on B', shareB.id!, shareA.token!],
    ['revoked', revoked.id!, revoked.token!],
    ['unknown id', 'c'.repeat(32), shareA.token!],
    ['wrong token', shareA.id!, 'W'.repeat(43)],
    ['no token', shareA.id!, null],
    ['empty token header', shareA.id!, ''],
    ['short token', shareA.id!, shareA.token!.slice(0, 42)],
    ['long token', shareA.id!, `${shareA.token!}x`],
    ['token with illegal characters', shareA.id!, `${shareA.token!.slice(0, 40)}+/=`],
    ['upper-case id', shareA.id!.toUpperCase(), shareA.token!],
    ['id too short', shareA.id!.slice(0, 31), shareA.token!],
    ['id with encoded NUL', `${shareA.id!.slice(0, 30)}%00`, shareA.token!],
    ['id with traversal', '..%2F..%2Fetc%2Fpasswd', shareA.token!],
    ['10k id', 'a'.repeat(10_000), shareA.token!],
    ['unicode id', 'ا'.repeat(32), shareA.token!],
  ];
  const seen = new Map<string, string>();
  for (const [label, id, token] of refusals) {
    const response = await stack.read(id, token);
    assert.equal(response.status, 404, label);
    seen.set(label, `${response.text}|${stableHeaders(response.headers)}`);
  }
  assert.equal(new Set(seen.values()).size, 1, `refusals differ: ${JSON.stringify([...seen])}`);

  advanceClock(2 * DAY_MS);
  const afterExpiry = await stack.read(expired.id!, expired.token!);
  assert.equal(afterExpiry.status, 404, 'expired');
  assert.equal(`${afterExpiry.text}|${stableHeaders(afterExpiry.headers)}`, [...seen.values()][0], 'expired looks the same');
  assert.equal((await stack.read(shareA.id!, shareA.token!)).status, 200, 'a 30d share is unaffected');
});

test('public read ignores client credentials and sets none', async () => {
  const { sessionId } = sessionOf();
  const share = await stack.create(member, sessionId);
  const credentials = { Authorization: stack.bearer(member), Cookie: 'sid=abc; __Host-nassaj_device=zzz' };
  const without = await stack.read(share.id!, null, { headers: credentials });
  assert.equal(without.status, 404, 'a Bearer or cookie is no substitute for the share token');
  const ok = await stack.read(share.id!, share.token!, { headers: credentials });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('set-cookie'), null);
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
  const forged = await stack.read(share.id!, share.token!, { headers: { Authorization: 'Bearer garbage' } });
  assert.equal(forged.status, 200, 'a bad Authorization header is ignored, not an error');
  // The management API refuses a share token as a credential.
  const asBearer = await stack.call('GET', '/api/session-shares/mine', { auth: `Bearer ${share.token}` });
  assert.equal(asBearer.status, 401);
});

// ---------------------------------------------------------------------------
// Death causes through the real repositories and the real sweeper
// ---------------------------------------------------------------------------

const rowOf = (id: string) => stack.store().get(id) as { revoked_at: string | null; revoke_reason: string | null;
  snapshot: Buffer | null; sweep_miss_count: number };

async function freshShare(creator: StackUser = member) {
  const session = sessionOf();
  const share = await stack.create(creator, session.sessionId);
  assert.equal(share.status, 201, share.text);
  assert.equal((await stack.read(share.id!, share.token!)).status, 200);
  return { ...session, share };
}

async function assertDead(share: { id?: string; token?: string }, reason: string) {
  assert.equal((await stack.read(share.id!, share.token!)).status, 404, 'a dead share is refused on read at once');
  const result = stack.sweep();
  assert.ok(result.revoked >= 1, JSON.stringify(result));
  const row = rowOf(share.id!);
  assert.equal(row.revoke_reason, reason);
  assert.equal(row.snapshot, null, 'the conversation text is deleted with the share');
  assert.ok(row.revoked_at);
}

test('sweeper: expiry', async () => {
  const { share } = await freshShare();
  stack.store().resetSweepMiss(share.id!);
  advanceClock(31 * DAY_MS);
  await assertDead(share, 'expired');
});

test('sweeper: manual revoke leaves nothing behind, and a stray leftover blob is nulled', async () => {
  const { share } = await freshShare();
  stack.store().revoke(share.id!, 'manual');
  assert.equal(rowOf(share.id!).snapshot, null);
  const { share: leftover } = await freshShare();
  stack.database.getConnection().prepare('UPDATE session_shares SET revoked_at = ? WHERE id = ?')
    .run(new Date().toISOString(), leftover.id);
  assert.ok(rowOf(leftover.id!).snapshot, 'precondition: a revoked row that still holds a blob');
  assert.equal((await stack.read(leftover.id!, leftover.token!)).status, 404);
  stack.sweep();
  assert.equal(rowOf(leftover.id!).snapshot, null);
});

test('sweeper: creator disabled', async () => {
  const creator = stack.createUser('doomed-admin', 'admin');
  const { share } = await freshShare(creator);
  stack.userDb.setStatus(creator.id, 'disabled');
  await assertDead(share, 'creator_inactive');
});

test('sweeper: admin creator demoted to a plain user', async () => {
  const creator = stack.createUser('demoted-admin', 'admin');
  const session = sessionOf();
  const share = await stack.create(creator, session.sessionId);
  assert.equal(share.status, 201, share.text);
  assert.equal((await stack.read(share.id!, share.token!)).status, 200);
  stack.userDb.setRole(creator.id, 'user');
  await assertDead(share, 'creator_unentitled');
});

test('sweeper: session ownership changed', async () => {
  const { sessionId, share } = await freshShare();
  stack.database.getConnection().prepare("UPDATE session_participants SET user_id = ? WHERE session_id = ? AND role = 'owner'")
    .run(outsider.id, sessionId);
  await assertDead(share, 'owner_changed');
});

test('sweeper: session moved to another project', async () => {
  const { sessionId, share } = await freshShare();
  const other = stack.project('moved-to');
  stack.database.getConnection().prepare('UPDATE sessions SET project_path = ? WHERE session_id = ?').run(other, sessionId);
  await assertDead(share, 'project_gone');
});

test('sweeper: project archived', async () => {
  const { projectPath, share } = await freshShare();
  stack.database.getConnection().prepare('UPDATE projects SET isArchived = 1 WHERE project_path = ?').run(projectPath);
  await assertDead(share, 'project_archived');
});

test('sweeper: a missing session row or unresolved owner is only definitive after two sweeps', async () => {
  const missing = await freshShare();
  stack.database.getConnection().prepare('DELETE FROM sessions WHERE session_id = ?').run(missing.sessionId);
  assert.equal((await stack.read(missing.share.id!, missing.share.token!)).status, 404, 'readers refuse at once');
  const first = stack.sweep();
  assert.ok(first.missed >= 1);
  assert.equal(rowOf(missing.share.id!).revoked_at, null, 'first strike keeps the row');
  assert.equal(rowOf(missing.share.id!).sweep_miss_count, 1);
  assert.ok(rowOf(missing.share.id!).snapshot, 'and the blob (a watcher rewrite may restore the row)');
  stack.sweep();
  assert.equal(rowOf(missing.share.id!).revoke_reason, 'session_gone');
  assert.equal(rowOf(missing.share.id!).snapshot, null);

  const ownerless = await freshShare();
  stack.database.getConnection().prepare('DELETE FROM session_participants WHERE session_id = ?').run(ownerless.sessionId);
  stack.sweep();
  assert.equal(rowOf(ownerless.share.id!).revoked_at, null);
  stack.sweep();
  assert.equal(rowOf(ownerless.share.id!).revoke_reason, 'owner_unresolved');

  const flapping = await freshShare();
  const { sessionId } = flapping;
  const connection = stack.database.getConnection();
  const saved = connection.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown>;
  const participants = connection.prepare('SELECT * FROM session_participants WHERE session_id = ?').all(sessionId) as Array<Record<string, unknown>>;
  connection.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  stack.sweep();
  assert.equal(rowOf(flapping.share.id!).sweep_miss_count, 1);
  const columns = Object.keys(saved);
  connection.prepare(`INSERT INTO sessions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(saved));
  for (const participant of participants) {
    const names = Object.keys(participant);
    connection.prepare(`INSERT INTO session_participants (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(participant));
  }
  stack.sweep();
  assert.equal(rowOf(flapping.share.id!).sweep_miss_count, 0, 'a restored row resets the strike');
  assert.equal((await stack.read(flapping.share.id!, flapping.share.token!)).status, 200, 'the share survived the rewrite');
});

test('real lifecycle hooks: archive and delete through the sessions service revoke at once', async () => {
  const archived = await freshShare();
  await stack.sessionsService.deleteOrArchiveSessionById(archived.sessionId, member.id, {});
  assert.equal((await stack.read(archived.share.id!, archived.share.token!)).status, 404);
  assert.equal(rowOf(archived.share.id!).revoke_reason, 'session_archived');

  const deleted = await freshShare();
  await stack.sessionsService.deleteOrArchiveSessionById(deleted.sessionId, member.id, { force: true });
  assert.equal((await stack.read(deleted.share.id!, deleted.share.token!)).status, 404);
  assert.equal(rowOf(deleted.share.id!).revoke_reason, 'session_deleted');
  assert.equal(rowOf(deleted.share.id!).snapshot, null);

  const victim = stack.createUser('victim', 'user');
  const owned = stack.seedSession(victim, hello());
  const share = await stack.create(victim, owned.sessionId);
  stack.userDb.deleteUser(victim.id);
  assert.equal((await stack.read(share.id!, share.token!)).status, 404);
  assert.equal(rowOf(share.id!).revoke_reason, 'user_deleted');
});

// ---------------------------------------------------------------------------
// Abuse: rate limits, caps, oversized sessions
// ---------------------------------------------------------------------------

test('public read rate limits: per IP, per share, and X-Forwarded-For cannot evade them', async () => {
  advanceClock(120_000);
  const { sessionId } = sessionOf();
  const share = await stack.create(member, sessionId);
  const statuses: number[] = [];
  for (let index = 0; index < 61; index += 1) statuses.push((await stack.read(share.id!, share.token!, { ip: '203.0.113.7' })).status);
  assert.equal(statuses.filter((status) => status === 200).length, 60);
  const limited = await stack.read(share.id!, share.token!, { ip: '203.0.113.7' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(limited.json, { error: { code: 'RATE_LIMITED' } });
  assert.equal((await stack.read(share.id!, share.token!, { ip: '203.0.113.8' })).status, 200, 'another IP is unaffected');

  advanceClock(120_000);
  const spoofed: number[] = [];
  for (let index = 0; index < 62; index += 1) {
    spoofed.push((await stack.read(share.id!, share.token!, { ip: 'none', headers: { 'X-Forwarded-For': `10.9.${index}.1` } })).status);
  }
  assert.ok(spoofed.includes(429), 'X-Forwarded-For is not a key');

  advanceClock(120_000);
  let denied = 0;
  for (let index = 0; index < 130; index += 1) {
    const status = (await stack.read(share.id!, share.token!, { ip: `192.0.2.${(index % 8) + 1}`.concat(String(index)) })).status;
    if (status === 429) denied += 1;
  }
  assert.ok(denied >= 1 && denied <= 10, `per-share ceiling (120/min) applied across IPs, denied=${denied}`);
});

test('concurrent readers: bounded, never a 5xx', async () => {
  advanceClock(120_000);
  const { sessionId } = sessionOf();
  const share = await stack.create(member, sessionId);
  const responses = await Promise.all(Array.from({ length: 40 }, (_, index) =>
    stack.read(share.id!, share.token!, { ip: `203.0.113.${index + 20}` })));
  const statuses = responses.map((response) => response.status);
  assert.ok(statuses.every((status) => status === 200 || status === 429), statuses.join());
  assert.ok(statuses.includes(200));
  for (const response of responses.filter((r) => r.status === 200)) assert.equal(response.json.messages.length, 2);
});

const createPatiently = (user: StackUser, sessionId: string) => stack.create(user, sessionId);

test('per-session cap of 20 holds across creators and parallel waves', async () => {
  const { sessionId } = sessionOf();
  const creators = [platformOwner, admin, admin2, member];
  const outcomes: string[] = [];
  for (let index = 0; index < 26; index += 2) {
    advanceClock(61_000);
    const wave = await Promise.all([creators[index % 4], creators[(index + 1) % 4]].map((user) => createPatiently(user, sessionId)));
    for (const result of wave) outcomes.push(result.status === 201 ? 'created' : result.json?.error?.code ?? `http-${result.status}`);
  }
  assert.equal(outcomes.filter((outcome) => outcome === 'created').length, 20, outcomes.join());
  assert.ok(outcomes.filter((outcome) => outcome === 'SHARE_LIMIT_REACHED').length >= 6, outcomes.join());
  assert.ok(outcomes.every((outcome) => outcome === 'created' || outcome === 'SHARE_LIMIT_REACHED'), outcomes.join());
  const active = (stack.store().listBySession(sessionId) as Array<{ revoked_at: string | null }>).filter((row) => !row.revoked_at);
  assert.equal(active.length, 20);
  // A revoked share frees one slot.
  await stack.call('POST', `/api/session-shares/${(active[0] as unknown as { id: string }).id}/revoke`, { user: member });
  advanceClock(61_000);
  assert.equal((await createPatiently(platformOwner, sessionId)).status, 201);
  assert.equal((await createPatiently(platformOwner, sessionId)).json.error.code, 'SHARE_LIMIT_REACHED');
});

test('per-creator cap of 50 holds across sessions', async () => {
  const creator = stack.createUser('prolific-admin', 'admin');
  const sessions = [sessionOf(), sessionOf(), sessionOf()];
  let created = 0;
  let refused = 0;
  for (let index = 0; index < 54; index += 1) {
    if (index % 4 === 0) advanceClock(61_000);
    const result = await createPatiently(creator, sessions[index % 3].sessionId);
    if (result.status === 201) created += 1;
    else if (result.json?.error?.code === 'SHARE_LIMIT_REACHED') refused += 1;
    else assert.fail(`unexpected ${result.status} ${result.text}`);
  }
  assert.equal(created, 50);
  assert.equal(refused, 4);
});

test('oversized sessions are refused with 413 and store nothing', async () => {
  const words = (bytes: number) => {
    let out = '';
    while (out.length < bytes) out += `${Math.random().toString(36).slice(2, 2 + 3 + Math.floor(Math.random() * 6))} `;
    return out.slice(0, bytes);
  };
  const tooMuchText = sessionOf(Array.from({ length: 5 }, (_, i) =>
    (i % 2 ? claudeRows.assistant([claudeRows.text(words(900_000))]) : claudeRows.user(words(900_000)))));
  advanceClock(61_000);
  const text = await stack.preview(member, tooMuchText.sessionId);
  assert.equal(text.status, 413, text.text.slice(0, 200));
  assert.equal(text.json.error.code, 'SNAPSHOT_TOO_LARGE');

  const tooMany = sessionOf(Array.from({ length: 5001 }, (_, i) => claudeRows.user(`m${i}`)));
  advanceClock(61_000);
  assert.equal((await stack.preview(member, tooMany.sessionId)).status, 413, 'more than 5000 messages');

  const hugeHistory = sessionOf([claudeRows.user('x'), claudeRows.assistant([claudeRows.toolUse('toolu_9', { blob: 'z'.repeat(9 * 1024 * 1024) })])]);
  advanceClock(61_000);
  assert.equal((await stack.preview(member, hugeHistory.sessionId)).status, 413, 'history beyond the in-memory cap');

  const incompressible = sessionOf(Array.from({ length: 6 }, (_, i) =>
    (i % 2 ? claudeRows.assistant([claudeRows.text(words(600_000))]) : claudeRows.user(words(600_000)))));
  advanceClock(61_000);
  const blob = await stack.preview(member, incompressible.sessionId);
  assert.equal(blob.status, 413, `a snapshot over 1 MiB compressed: ${blob.text.slice(0, 120)}`);
  for (const { sessionId } of [tooMuchText, tooMany, hugeHistory, incompressible]) {
    assert.equal((stack.store().listBySession(sessionId) as unknown[]).length, 0);
  }
});

test('create refuses a stale or forged preview and a truncated range stays truncated', async () => {
  const { sessionId } = sessionOf([claudeRows.user('first'), claudeRows.assistant([claudeRows.text('second')]), claudeRows.user('third')]);
  const shown = await stack.preview(member, sessionId);
  const base = { expiry: '7d', upToMessageId: shown.json.upToMessageId, previewSha256: shown.json.previewSha256, reviewedRedactions: true };
  const post = (body: unknown) => stack.call('POST', `/api/sessions/${sessionId}/shares`, { user: member, body });
  assert.equal((await post({ ...base, previewSha256: 'b'.repeat(64) })).status, 409);
  assert.equal((await post({ ...base, upToMessageId: 'no-such-message' })).status, 409);
  assert.equal((await post({ ...base, upToMessageId: 'x'.repeat(300) })).status, 400);
  assert.equal((await post({ ...base, expiry: 'forever' })).status, 400);
  assert.equal((await post({ ...base, __proto__: { admin: true }, extra: 1 })).status, 400);
  assert.equal((await post({ ...base, reviewedRedactions: 'true' })).status, 400);
  const good = await post(base);
  assert.equal(good.status, 201, good.text);
  assert.equal(good.json.share.messageCount, 3);
  assert.equal(good.json.share.sessionId, sessionId);
  assert.ok(!('tokenHash' in good.json.share) && !('token_hash' in good.json.share));
});

// ---------------------------------------------------------------------------
// Protocol edges
// ---------------------------------------------------------------------------

/** Raw HTTP request, for headers that fetch refuses to set (Host, Accept-Encoding). */
async function raw(method: string, urlPath: string, headers: Record<string, string>) {
  const http = await import('node:http');
  const { port } = new URL(stack.origin);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('public path edges: other methods, trailing slash and sub-paths never serve a snapshot', async () => {
  const { sessionId } = sessionOf();
  const share = await stack.create(member, sessionId);
  const headers = { 'X-Share-Token': share.token!, 'cf-connecting-ip': '203.0.113.99' };
  for (const [method, urlPath] of [['HEAD', `/api/session-shares/${share.id}`], ['POST', `/api/session-shares/${share.id}`],
    ['PUT', `/api/session-shares/${share.id}`], ['DELETE', `/api/session-shares/${share.id}`],
    ['GET', `/api/session-shares/${share.id}/`], ['GET', `/api/session-shares/${share.id}/extra`],
    ['GET', `/api/session-shares//${share.id}`], ['GET', `/API/session-shares/${share.id}`]] as const) {
    const response = await raw(method, urlPath, headers);
    assert.notEqual(response.status, 200, `${method} ${urlPath}`);
    assert.ok(!response.body.toString().includes('hello from the owner'), `${method} ${urlPath} leaked the snapshot`);
  }
});

test('the public origin is configuration: Host and X-Forwarded-Host never reach the share URL', async () => {
  const { sessionId } = sessionOf();
  const shown = await stack.preview(member, sessionId);
  const body = JSON.stringify({ expiry: '7d', upToMessageId: shown.json.upToMessageId, previewSha256: shown.json.previewSha256, reviewedRedactions: true });
  const http = await import('node:http');
  const { port } = new URL(stack.origin);
  const created = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/api/sessions/${sessionId}/shares`,
      headers: { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https', Origin: 'https://evil.example',
        Authorization: stack.bearer(member), 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)),
        'cf-connecting-ip': '203.0.113.98' } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(created.status, 201, created.text);
  assert.match(JSON.parse(created.text).shareUrl, new RegExp(`^${stack.origin.replace(/[.]/g, '\\.')}/s/[a-f0-9]{32}#token=`));
});

test('expiry boundary: alive shortly before, dead at the instant, dead on a corrupt date', async () => {
  const { sessionId } = sessionOf();
  const share = await stack.create(member, sessionId, { expiry: '24h' });
  const expiresAt = Date.parse(share.json.share.expiresAt);
  advanceClock(expiresAt - 5000 - Date.now());
  assert.equal((await stack.read(share.id!, share.token!)).status, 200);
  advanceClock(expiresAt - Date.now());
  assert.ok(Date.now() >= expiresAt);
  assert.equal((await stack.read(share.id!, share.token!)).status, 404);

  const { sessionId: other } = sessionOf();
  const corrupt = await stack.create(member, other);
  stack.database.getConnection().prepare("UPDATE session_shares SET expires_at = 'not-a-date' WHERE id = ?").run(corrupt.id);
  assert.equal((await stack.read(corrupt.id!, corrupt.token!)).status, 404, 'an unreadable expiry fails closed');
});

test('transport: CORS preflight, identity encoding, gzip refusal and the view counter', async () => {
  advanceClock(120_000);
  const { sessionId } = sessionOf();
  const share = await stack.create(member, sessionId);
  const preflight = await raw('OPTIONS', `/api/session-shares/${share.id}`, {
    Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-share-token', 'cf-connecting-ip': '203.0.113.97' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.equal(preflight.headers['access-control-allow-headers'], 'X-Share-Token');
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.equal(preflight.body.length, 0);

  const { gunzipSync } = await import('node:zlib');
  const gz = await raw('GET', `/api/session-shares/${share.id}`, { 'X-Share-Token': share.token!, 'Accept-Encoding': 'gzip', 'cf-connecting-ip': '203.0.113.96' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  const plain = await raw('GET', `/api/session-shares/${share.id}`, { 'X-Share-Token': share.token!, 'Accept-Encoding': 'identity', 'cf-connecting-ip': '203.0.113.96' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), gunzipSync(gz.body).toString());
  const refused = await raw('GET', `/api/session-shares/${share.id}`, { 'X-Share-Token': share.token!, 'Accept-Encoding': 'gzip;q=0', 'cf-connecting-ip': '203.0.113.96' });
  assert.equal(refused.headers['content-encoding'], undefined);
  assert.equal(refused.body.toString(), plain.body.toString());

  const row = stack.store().get(share.id!) as { view_count: number; last_viewed_at: string | null };
  assert.equal(row.view_count, 1, 'views are batched: the first read flushes at once, the rest wait for the minute');
  assert.ok(row.last_viewed_at);
  const dead = await create404();
  assert.equal((stack.store().get(dead.id!) as { view_count: number }).view_count, 0, 'refused reads are never counted');

  async function create404() {
    const made = await stack.create(member, sessionId);
    await stack.read(made.id!, 'W'.repeat(43));
    return made;
  }
});

test('titles are sanitized like messages: secrets, addresses and markup never reach the snapshot', async () => {
  const title = `Deploy ${SECRETS.github} <script>window.__pwned=1</script> ${SECRETS.tailscale} ${SECRETS.anthropic}`;
  const session = stack.seedSession(member, hello(), { title });
  const created = await stack.create(member, session.sessionId);
  assert.equal(created.status, 201, created.text);
  const read = await stack.read(created.id!, created.token!);
  for (const leaked of [SECRETS.github, SECRETS.tailscale, SECRETS.anthropic]) assert.ok(!read.text.includes(leaked), leaked);
  assert.ok(read.json.title.length <= 200);
  const long = stack.seedSession(member, hello(), { title: 'x'.repeat(5000) });
  const longShare = await stack.create(member, long.sessionId);
  assert.ok((await stack.read(longShare.id!, longShare.token!)).json.title.length <= 200);
});

// D3 (fixed): the title is sanitized with the same project/home context as the messages.
test('D3: project and home paths in the session title are redacted like message paths',
  async () => {
    const session = stack.seedSession(member, hello());
    const title = `Fix ${session.projectPath}/src/app.ts and ${SANDBOX_HOME}/notes`;
    stack.database.getConnection().prepare('UPDATE sessions SET custom_name = ? WHERE session_id = ?').run(title, session.sessionId);
    const created = await stack.create(member, session.sessionId);
    const read = await stack.read(created.id!, created.token!);
    assert.ok(!read.json.title.includes(session.projectPath), `title leaks the project path: ${read.json.title}`);
    assert.ok(!read.json.title.includes(SANDBOX_HOME), `title leaks the home path: ${read.json.title}`);
  });
