/**
 * ADR-196 / T-1970 stage 7 and ADR-205 / T-2013 stages 3-4: adversarial and end-to-end
 * tests of read-only session shares against the REAL stack (production runtime,
 * repositories, snapshot pipeline, live projection, JWT verifier) on a temp database and
 * a real-format Claude JSONL in a temp HOME. Legacy snapshot rows are seeded through the
 * real builder (their creation route is retired); live links go through the real routes.
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
  assert.ok(!mine.text.includes(created.token!) && !mine.text.includes('token_hash') && !mine.text.includes('"snapshot":'));
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

test('M9 on a real session: only the strict owner creates a live link; preview is retired', async () => {
  const { sessionId } = sessionOf();
  for (const [user, name] of [[outsider, 'outsider'], [platformOwner, 'platform owner'], [admin, 'admin']] as const) {
    const refused = await stack.createLive(user, sessionId);
    assert.equal(refused.status, 403, name);
    assert.deepEqual(refused.json, { error: { code: 'OWNER_ONLY' } }, name);
  }
  stack.audits.length = 0;
  const made = await stack.createLive(member, sessionId);
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.share.mode, 'live');
  assert.ok(stack.audits.some((entry) => entry.action === 'session_share_created' && entry.userId === member.id
    && entry.metadata.mode === 'live'));
  const retired = await stack.call('POST', `/api/sessions/${sessionId}/shares/preview`, { user: member, body: {} });
  assert.deepEqual([retired.status, retired.json], [410, { error: { code: 'SNAPSHOT_SHARES_RETIRED' } }]);
  assert.equal((await stack.createLive(member, 'does-not-exist-session')).status, 404);
  assert.equal((await stack.createLive(member, 'bad id with spaces')).status, 404);
  const revoked = await stack.call('POST', `/api/session-shares/${made.id}/revoke`, { user: admin });
  assert.equal(revoked.status, 204, 'revoke stays open to privileged users');
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

test('D1/D7 on the real stack: failures are charged per IP bucket after verification; a valid token is never refused', async () => {
  advanceClock(11 * 60_000);
  const { sessionId } = sessionOf();
  const share = await stack.create(member, sessionId);
  const failures: number[] = [];
  for (let index = 0; index < 21; index += 1) failures.push((await stack.read(share.id!, 'W'.repeat(43), { ip: '203.0.113.7' })).status);
  assert.equal(failures.filter((status) => status === 404).length, 20);
  const limited = await stack.read(share.id!, 'W'.repeat(43), { ip: '203.0.113.7' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(limited.json, { error: { code: 'RATE_LIMITED' } });
  assert.equal((await stack.read(share.id!, share.token!, { ip: '203.0.113.7' })).status, 200, 'the attacker IP with the token is served');
  const live = await stack.createLive(member, sessionId);
  assert.equal((await stack.view(live.id!, 'W'.repeat(43), 'meta', { ip: '2001:db8:7:7::1' })).status, 404);
  for (let index = 0; index < 20; index += 1) await stack.view(live.id!, 'W'.repeat(43), 'meta', { ip: `2001:db8:7:7::${index + 2}` });
  assert.equal((await stack.view(live.id!, 'W'.repeat(43), 'meta', { ip: '2001:db8:7:7:ffff::1' })).status, 429,
    'IPv6 rotation inside one /64 shares one bucket');
  assert.equal((await stack.view(live.id!, live.token!, 'meta', { ip: '2001:db8:7:7::99' })).status, 200);

  advanceClock(11 * 60_000);
  const spoofed: number[] = [];
  for (let index = 0; index < 22; index += 1) {
    spoofed.push((await stack.read(share.id!, 'W'.repeat(43), { ip: 'none', headers: { 'X-Forwarded-For': `10.9.${index}.1` } })).status);
  }
  assert.ok(spoofed.includes(429), 'X-Forwarded-For is not a key');
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

test('per-session cap of 20 live links holds across parallel waves; a revoke frees one slot', async () => {
  const { sessionId } = sessionOf();
  const outcomes: string[] = [];
  for (let index = 0; index < 26; index += 2) {
    const wave = await Promise.all([0, 1].map(() => stack.createLive(member, sessionId)));
    for (const result of wave) outcomes.push(result.status === 201 ? 'created' : result.json?.error?.code ?? `http-${result.status}`);
  }
  assert.equal(outcomes.filter((outcome) => outcome === 'created').length, 20, outcomes.join());
  assert.ok(outcomes.every((outcome) => outcome === 'created' || outcome === 'SHARE_LIMIT_REACHED'), outcomes.join());
  const active = (stack.store().listBySession(sessionId) as Array<{ id: string; revoked_at: string | null }>).filter((row) => !row.revoked_at);
  assert.equal(active.length, 20);
  await stack.call('POST', `/api/session-shares/${active[0].id}/revoke`, { user: member });
  assert.equal((await stack.createLive(member, sessionId)).status, 201);
  assert.equal((await stack.createLive(member, sessionId)).json.error.code, 'SHARE_LIMIT_REACHED');
});

test('per-creator cap of 50 live links holds across sessions', async () => {
  advanceClock(61_000);
  const creator = stack.createUser('prolific-owner', 'user');
  const sessions = [0, 1, 2].map(() => stack.seedSession(creator, hello()));
  let created = 0;
  let refused = 0;
  for (let index = 0; index < 54; index += 1) {
    if (index % 100 === 99) advanceClock(61_000);
    const result = await stack.createLive(creator, sessions[index % 3].sessionId, {}, `198.18.${Math.floor(index / 100)}.1`);
    if (result.status === 201) created += 1;
    else if (result.json?.error?.code === 'SHARE_LIMIT_REACHED') refused += 1;
    else assert.fail(`unexpected ${result.status} ${result.text}`);
  }
  assert.equal(created, 50);
  assert.equal(refused, 4);
});

test('ADR-205: sessions the snapshot builder refused with 413 are readable through a live link', async () => {
  const words = (bytes: number) => {
    let out = '';
    while (out.length < bytes) out += `${Math.random().toString(36).slice(2, 2 + 3 + Math.floor(Math.random() * 6))} `;
    return out.slice(0, bytes);
  };
  const tooMuchText = sessionOf(Array.from({ length: 5 }, (_, i) =>
    (i % 2 ? claudeRows.assistant([claudeRows.text(words(900_000))]) : claudeRows.user(words(900_000)))));
  const tooMany = sessionOf(Array.from({ length: 5001 }, (_, i) => claudeRows.user(`m${i}`)));
  const hugeHistory = sessionOf([claudeRows.user('x'), claudeRows.assistant([claudeRows.toolUse('toolu_9', { blob: 'z'.repeat(9 * 1024 * 1024) })]),
    claudeRows.assistant([claudeRows.text('after the big tool call')])]);
  assert.equal((await stack.preview(member, hugeHistory.sessionId)).status, 413, 'precondition: the snapshot builder refused it');
  for (const [name, { sessionId }] of [['text', tooMuchText], ['count', tooMany], ['tool payload', hugeHistory]] as const) {
    advanceClock(61_000);
    const live = await stack.createLive(member, sessionId);
    assert.equal(live.status, 201, `${name}: ${live.text}`);
    const page = await stack.view(live.id!, live.token!, 'messages');
    assert.equal(page.status, 200, `${name}: ${page.text.slice(0, 200)}`);
    assert.ok(page.json.messages.length >= 1, name);
    assert.ok(Buffer.byteLength(page.text) <= 4 * 1024 * 1024 + 4096, `${name}: per-request byte cap`);
  }
  const many = await stack.createLive(member, tooMany.sessionId);
  const newest = await stack.view(many.id!, many.token!, 'messages');
  assert.equal(newest.json.messages.length, 50);
  assert.equal(newest.json.moreBefore, true);
  assert.equal(newest.json.messages.at(-1).parts[0].text, 'm5000');
  const huge = await stack.createLive(member, hugeHistory.sessionId);
  const texts = (await stack.view(huge.id!, huge.token!, 'messages')).json.messages.map((m: { parts: Array<{ text?: string }> }) => m.parts[0].text);
  assert.deepEqual(texts, ['x', 'after the big tool call'], 'the 9 MiB tool payload is dropped before anything is measured');
});

test('live create validates its body strictly and never returns secret fields', async () => {
  const { sessionId } = sessionOf();
  const post = (body: unknown) => stack.call('POST', `/api/sessions/${sessionId}/shares`, { user: member, body });
  assert.equal((await post({ expiry: 'forever' })).status, 400);
  assert.equal((await post({ expiry: '7d', __proto__: { admin: true }, extra: 1 })).status, 400);
  assert.equal((await post({ expiry: '7d', upToMessageId: 'm1', previewSha256: 'a'.repeat(64), reviewedRedactions: true })).status, 400,
    'the snapshot create body is no longer accepted');
  const good = await post({});
  assert.equal(good.status, 201, good.text);
  assert.equal(Date.parse(good.json.share.expiresAt) - Date.parse(good.json.share.createdAt), 7 * DAY_MS, 'seven-day default');
  assert.equal(good.json.share.sessionId, sessionId);
  for (const key of ['tokenHash', 'token_hash', 'refKey', 'ref_key']) assert.ok(!(key in good.json.share), key);
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
  const body = JSON.stringify({ expiry: '7d' });
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

// ---------------------------------------------------------------------------
// ADR-205 live links end to end
// ---------------------------------------------------------------------------

test('live link: meta, sanitized public messages only, appends arrive by cursor, revoke and delete end it', async () => {
  const { liveProjection } = await import('../services/session-share-live-projection.js');
  const rows = [
    claudeRows.user(`plan the release\n${secretBlock('live-user')}`),
    claudeRows.assistant([claudeRows.thinking('LIVE-THINKING-SECRET-77')]),
    claudeRows.assistant([claudeRows.toolUse('toolu_live', { command: 'cat LIVE-TOOL-INPUT-88' })]),
    claudeRows.toolResult('toolu_live', 'LIVE-TOOL-RESULT-99'),
    claudeRows.user('LIVE-SUBAGENT-PROMPT', { isSidechain: true, agentId: 'a9' }),
    claudeRows.assistant([claudeRows.text(`first answer ${SECRETS.github}`)]),
  ];
  const session = stack.seedSession(member, rows, { title: `Release ${SECRETS.anthropic} ${SANDBOX_HOME}/x` });
  const live = await stack.createLive(member, session.sessionId);
  assert.equal(live.status, 201, live.text);
  const meta = await stack.view(live.id!, live.token!, 'meta');
  assert.equal(meta.status, 200, meta.text);
  assert.deepEqual([meta.json.v, meta.json.mode, meta.json.providerLabel], [2, 'live', 'Claude']);
  for (const leaked of [SECRETS.anthropic, SANDBOX_HOME]) assert.ok(!meta.text.includes(leaked), `meta leaks ${leaked}`);
  const page = await stack.view(live.id!, live.token!, 'messages');
  assert.equal(page.status, 200, page.text);
  // No author was recorded for the seeded prompt: unattributed rows read «member», never «owner» (M6).
  assert.deepEqual(page.json.messages.map((m: { role: string; author: string }) => [m.role, m.author]),
    [['user', 'member'], ['assistant', 'assistant']]);
  for (const forbidden of [...Object.values(SECRETS), 'LIVE-THINKING', 'LIVE-TOOL-INPUT', 'LIVE-TOOL-RESULT', 'LIVE-SUBAGENT',
    session.sessionId, session.projectPath, 'toolu_live']) {
    assert.ok(!page.text.includes(forbidden), `messages leak ${forbidden}`);
  }
  const { appendFileSync } = await import('node:fs');
  appendFileSync(session.file, `${[claudeRows.user('second question'),
    claudeRows.assistant([claudeRows.toolUse('toolu_live2', { command: 'ls' })]), claudeRows.toolResult('toolu_live2', 'out'),
    claudeRows.assistant([claudeRows.text('second answer')])].map((row) => JSON.stringify({ sessionId: session.sessionId, cwd: session.projectPath, ...row })).join('\n')}\n`);
  advanceClock(4_000);
  const after = await stack.view(live.id!, live.token!, `messages?after=${page.json.messages.at(-1).c}`);
  assert.equal(after.status, 200, after.text);
  assert.deepEqual(after.json.messages.map((m: { parts: Array<{ text: string }> }) => m.parts[0].text), ['second question', 'second answer']);
  assert.notEqual(after.json.revision, page.json.revision);
  const replay = await stack.view(live.id!, live.token!, `messages?before=${after.json.messages[0].c}`);
  assert.deepEqual(replay.json.messages.map((m: { k: string }) => m.k), page.json.messages.map((m: { k: string }) => m.k),
    'gap-free and duplicate-free in both directions');
  assert.ok(liveProjection.inspect(session.sessionId), 'one shared projection entry');
  assert.equal((await stack.call('POST', `/api/session-shares/${live.id}/revoke`, { user: member })).status, 204);
  assert.equal(liveProjection.inspect(session.sessionId), undefined, 'the last live revoke drops the projection');
  assert.equal((await stack.view(live.id!, live.token!, 'messages')).status, 404, 'revocation takes effect on the next request');

  const deleted = sessionOf();
  const second = await stack.createLive(member, deleted.sessionId);
  assert.equal((await stack.view(second.id!, second.token!, 'messages')).status, 200);
  assert.ok(liveProjection.inspect(deleted.sessionId));
  await stack.sessionsService.deleteOrArchiveSessionById(deleted.sessionId, member.id, { force: true });
  assert.equal(liveProjection.inspect(deleted.sessionId), undefined, 'session delete drops the projection');
  assert.equal((await stack.view(second.id!, second.token!, 'meta')).status, 404);
});

test('live link attachments: chat images, ADR-157 fences, redacted text files; SVG, binary and secret files withheld', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { getChatImageRoot } = await import('../services/chat-image-store.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'share-live-att-')));
  const projectPath = path.join(root, 'project');
  const inbox = path.join(projectPath, '.nassaj-uploads', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(projectPath, 'out'), { recursive: true });
  stack.projectsDb.createProjectPath(projectPath, null, null);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('live-png')]);
  const bucket = 'feedc0de'.repeat(4);
  const chatDir = path.join(getChatImageRoot(), bucket);
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, 'image_0.png'), png);
  fs.writeFileSync(path.join(chatDir, 'image_1.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(inbox, 'notes.txt'), `release notes\ntoken ${SECRETS.github}\n`);
  fs.writeFileSync(path.join(inbox, 'report.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
  fs.writeFileSync(path.join(inbox, '.env'), `API_TOKEN=${SECRETS.envToken}`);
  fs.writeFileSync(path.join(projectPath, 'out', 'chart.png'), png);
  try {
    const prompt = ['please review', '', '[Images provided at the following paths:]', `1. ${chatDir}/image_0.png`, `2. ${chatDir}/image_1.svg`,
      '', '[Files provided at the following paths:]', '1. .nassaj-uploads/inbox/notes.txt', '2. .nassaj-uploads/inbox/report.pdf',
      '3. .nassaj-uploads/inbox/.env'].join('\n');
    const session = stack.seedSession(member, [claudeRows.user(prompt),
      claudeRows.assistant([claudeRows.text(`here is the chart\n\`\`\`image\n${projectPath}/out/chart.png\n\`\`\``)])], { projectPath });
    const live = await stack.createLive(member, session.sessionId);
    const page = await stack.view(live.id!, live.token!, 'messages');
    assert.equal(page.status, 200, page.text);
    const [user, assistant] = page.json.messages;
    assert.deepEqual(user.parts.map((part: { t: string; cat?: string; kind?: string; name?: string }) =>
      [part.t, part.cat ?? part.kind ?? part.name ?? null]), [['text', null], ['image', null], ['image', null], ['file', 'notes.txt'],
      ['attachment-unavailable', 'file'], ['redacted', 'secret']]);
    for (const forbidden of [chatDir, projectPath, root, bucket, 'inbox', '.env']) assert.ok(!page.text.includes(forbidden), forbidden);
    const fetchRef = (ref: string) => stack.view(live.id!, live.token!, `attachments/${ref}`);
    const image = await fetchRef(user.parts[1].ref);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    const svg = await fetchRef(user.parts[2].ref);
    assert.deepEqual([svg.status, svg.json], [404, { error: { code: 'ATTACHMENT_GONE' } }], 'SVG is never served');
    const notes = await fetchRef(user.parts[3].ref);
    assert.equal(notes.status, 200);
    assert.equal(notes.headers.get('content-disposition'), "attachment; filename*=UTF-8''notes.txt");
    assert.ok(notes.text.includes('release notes') && !notes.text.includes(SECRETS.github), 'served redacted');
    const chart = await fetchRef(assistant.parts.find((part: { t: string }) => part.t === 'image').ref);
    assert.equal(chart.status, 200, chart.text);
    fs.rmSync(path.join(chatDir, 'image_0.png'));
    assert.equal((await fetchRef(user.parts[1].ref)).status, 404, 'a removed file is ATTACHMENT_GONE');
    const forged = `${user.parts[1].ref.slice(0, -1)}${user.parts[1].ref.endsWith('A') ? 'B' : 'A'}`;
    assert.equal((await fetchRef(forged)).status, 404);
    assert.equal((await stack.view(live.id!, 'W'.repeat(43), `attachments/${user.parts[3].ref}`)).status, 404, 'a ref is no credential');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(chatDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ADR-205 stage 7: lifecycle, tool-heavy sessions, attachment escapes, floods
// ---------------------------------------------------------------------------

const UNAVAILABLE = { error: { code: 'SHARE_UNAVAILABLE' } };

test('end to end: create, read, a new completed message arrives by cursor, revoke answers the uniform 404', async () => {
  const session = sessionOf([claudeRows.user('first question'), claudeRows.assistant([claudeRows.text('first answer')])]);
  const live = await stack.createLive(member, session.sessionId);
  assert.equal(live.status, 201, live.text);
  assert.match(live.url!, /^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+#token=[A-Za-z0-9_-]{43}$/);

  const meta = await stack.view(live.id!, live.token!, 'meta');
  assert.deepEqual([meta.status, meta.json.mode], [200, 'live']);
  const first = await stack.view(live.id!, live.token!, 'messages');
  assert.deepEqual(first.json.messages.map((m: { parts: Array<{ text: string }> }) => m.parts[0].text), ['first question', 'first answer']);
  const idle = await stack.view(live.id!, live.token!, `messages?after=${first.json.messages.at(-1).c}`);
  assert.deepEqual([idle.status, idle.json.messages.length], [200, 0], 'nothing new yet');

  const { appendFileSync } = await import('node:fs');
  const append = (...rows: Array<Record<string, unknown>>) => appendFileSync(session.file,
    `${rows.map((row) => JSON.stringify({ sessionId: session.sessionId, cwd: session.projectPath, ...row })).join('\n')}\n`);
  append(claudeRows.user('follow-up'), claudeRows.assistant([claudeRows.text('completed reply')]));
  advanceClock(4_000);
  const poll = await stack.view(live.id!, live.token!, `messages?after=${first.json.messages.at(-1).c}`);
  assert.equal(poll.status, 200, poll.text);
  assert.deepEqual(poll.json.messages.map((m: { parts: Array<{ text: string }> }) => m.parts[0].text), ['follow-up', 'completed reply']);
  assert.ok(!poll.json.messages.some((m: { k: string }) => first.json.messages.some((old: { k: string }) => old.k === m.k)), 'no duplicates');

  assert.equal((await stack.call('POST', `/api/session-shares/${live.id}/revoke`, { user: member })).status, 204);
  for (const endpoint of ['meta', 'messages', `messages?after=${poll.json.messages.at(-1).c}`]) {
    const refused = await stack.view(live.id!, live.token!, endpoint);
    assert.equal(refused.status, 404, endpoint);
    assert.deepEqual(refused.json, UNAVAILABLE, `${endpoint}: the uniform code, no reason`);
  }
  const unknown = await stack.view(`${live.id!.slice(0, -1)}${live.id!.endsWith('a') ? 'b' : 'a'}`, live.token!, 'meta');
  assert.equal(unknown.text, (await stack.view(live.id!, live.token!, 'meta')).text, 'revoked looks like unknown');
});

test('end to end: archive and expiry end a live link on the next request', async () => {
  const archived = sessionOf();
  const a = await stack.createLive(member, archived.sessionId);
  assert.equal((await stack.view(a.id!, a.token!, 'messages')).status, 200);
  await stack.sessionsService.deleteOrArchiveSessionById(archived.sessionId, member.id, { force: false });
  assert.deepEqual((await stack.view(a.id!, a.token!, 'messages')).json, UNAVAILABLE);

  const expiring = sessionOf();
  const e = await stack.createLive(member, expiring.sessionId, { expiry: '24h' });
  assert.equal((await stack.view(e.id!, e.token!, 'meta')).status, 200);
  advanceClock(DAY_MS + 1_000);
  assert.deepEqual((await stack.view(e.id!, e.token!, 'meta')).json, UNAVAILABLE);
});

test('tool-heavy session (about 10 MiB of tool traffic, little text): the snapshot refuses it, the live link serves text only', async () => {
  const chunk = (seed: number) => Array.from({ length: 4096 }, (_, i) => `${((seed * 7919 + i * 104729) >>> 0).toString(16)}`).join(' ');
  const payload = (seed: number) => chunk(seed).repeat(Math.ceil(850_000 / chunk(seed).length)).slice(0, 850_000);
  const rows: Array<Record<string, unknown>> = [claudeRows.user('please run the whole build and summarise')];
  for (let step = 0; step < 12; step += 1) {
    rows.push(claudeRows.assistant([claudeRows.toolUse(`toolu_heavy_${step}`, { command: `make target-${step}`, note: payload(step).slice(0, 1_000) })]));
    rows.push(claudeRows.toolResult(`toolu_heavy_${step}`, `HEAVY-RESULT-${step} ${payload(step)}`));
    if (step % 4 === 3) rows.push(claudeRows.assistant([claudeRows.text(`progress after step ${step}`)]));
  }
  rows.push(claudeRows.user('sub agent prompt', { isSidechain: true, agentId: 'h1' }));
  rows.push(claudeRows.toolResult('toolu_heavy_side', `SIDE-RESULT ${payload(99)}`, { isSidechain: true, agentId: 'h1' }));
  rows.push(claudeRows.assistant([claudeRows.text('the build is green')]));
  const { sessionId, file } = sessionOf(rows);
  const { statSync } = await import('node:fs');
  assert.ok(statSync(file).size > 10 * 1024 * 1024, 'the fixture really is above 10 MiB');
  assert.equal((await stack.preview(member, sessionId)).status, 413, 'precondition: the old path refused it');

  advanceClock(61_000);
  const live = await stack.createLive(member, sessionId);
  assert.equal(live.status, 201, live.text);
  const started = Date.now();
  const page = await stack.view(live.id!, live.token!, 'messages');
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.ok(Date.now() - started < 8_000, 'inside the 10 s guest deadline');
  assert.deepEqual(page.json.messages.map((m: { parts: Array<{ text: string }> }) => m.parts[0].text),
    ['please run the whole build and summarise', 'progress after step 3', 'progress after step 7', 'progress after step 11', 'the build is green']);
  assert.ok(Buffer.byteLength(page.text) < 16 * 1024, 'only text travels, not tool payloads');
  for (const forbidden of ['HEAVY-RESULT', 'SIDE-RESULT', 'make target', 'toolu_heavy', 'sub agent prompt']) {
    assert.ok(!page.text.includes(forbidden), forbidden);
  }
  const again = await stack.view(live.id!, live.token!, `messages?after=${page.json.messages.at(-1).c}`);
  assert.deepEqual([again.status, again.json.messages.length], [200, 0]);
});

test('attachment escapes through the real routes: traversal, symlinks, special files and oversize never get a ref or bytes', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'share-live-esc-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'share-live-out-')));
  const projectPath = path.join(root, 'project');
  const inbox = path.join(projectPath, '.nassaj-uploads', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  stack.projectsDb.createProjectPath(projectPath, null, null);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'OUTSIDE-FILE-CONTENT');
  fs.writeFileSync(path.join(inbox, 'ok.txt'), 'plain inbox note');
  fs.writeFileSync(path.join(inbox, 'big.txt'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(inbox, 'leaf-link.txt'));
  fs.symlinkSync(outside, path.join(inbox, 'dir-link'));
  fs.mkdirSync(path.join(inbox, 'folder.txt'));
  execFileSync('mkfifo', [path.join(inbox, 'pipe.txt')]);
  try {
    const names = ['ok.txt', 'big.txt', 'leaf-link.txt', 'dir-link/private.txt', 'folder.txt', 'pipe.txt',
      '../../../../outside.txt', `${outside}/private.txt`, '..%2f..%2fprivate.txt'];
    const prompt = ['review these', '', '[Files provided at the following paths:]',
      ...names.map((name, index) => `${index + 1}. ${name.startsWith('/') || name.startsWith('..') ? name : `.nassaj-uploads/inbox/${name}`}`)].join('\n');
    const session = stack.seedSession(member, [claudeRows.user(prompt), claudeRows.assistant([claudeRows.text('done')])], { projectPath });
    const live = await stack.createLive(member, session.sessionId);
    const page = await stack.view(live.id!, live.token!, 'messages');
    assert.equal(page.status, 200, page.text);
    const parts = page.json.messages[0].parts as Array<{ t: string; ref?: string; name?: string }>;
    const refs = parts.filter((part) => part.ref);
    assert.deepEqual(refs.map((part) => part.name), ['ok.txt'], 'only the plain inbox file mints a ref');
    for (const forbidden of [outside, root, 'OUTSIDE-FILE-CONTENT', 'private.txt', 'leaf-link', 'dir-link', 'pipe.txt']) {
      assert.ok(!page.text.includes(forbidden), `messages leak ${forbidden}`);
    }
    const served = await stack.view(live.id!, live.token!, `attachments/${refs[0].ref}`);
    assert.equal(served.status, 200);
    assert.equal(served.text, 'plain inbox note');

    // After a ref was minted, swapping the file for a symlink or a different target must not follow it.
    fs.rmSync(path.join(inbox, 'ok.txt'));
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(inbox, 'ok.txt'));
    const swapped = await stack.view(live.id!, live.token!, `attachments/${refs[0].ref}`);
    assert.deepEqual([swapped.status, swapped.json.error.code], [404, 'ATTACHMENT_GONE']);
    assert.ok(!swapped.text.includes('OUTSIDE-FILE-CONTENT'));
    // Refs are not paths: traversal spellings in the ref position are refused uniformly.
    for (const ref of ['..%2f..%2f..%2fetc%2fpasswd', encodeURIComponent(path.join(outside, 'private.txt')), '.', '%00']) {
      const refused = await stack.view(live.id!, live.token!, `attachments/${ref}`);
      assert.ok([400, 404].includes(refused.status), `${ref}: ${refused.status}`);
      assert.ok(!refused.text.includes('OUTSIDE-FILE-CONTENT'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('D7: an unauthenticated flood, from one address and from many, never blocks a valid viewer', async () => {
  advanceClock(11 * 60_000);
  const session = sessionOf();
  const live = await stack.createLive(member, session.sessionId);
  const bad = 'F'.repeat(43);
  const flood: Array<Promise<{ status: number }>> = [];
  for (let index = 0; index < 300; index += 1) {
    const ip = index % 3 === 0 ? '203.0.113.200' : `198.51.100.${(index % 200) + 20}`;
    flood.push(stack.view(live.id!, bad, index % 2 ? 'messages' : 'meta', { ip }));
  }
  // The viewer shares an address with the flooder and also comes from a quiet one, while the flood is in flight.
  const viewers = await Promise.all([
    stack.view(live.id!, live.token!, 'messages', { ip: '203.0.113.200' }),
    stack.view(live.id!, live.token!, 'meta', { ip: '203.0.113.200' }),
    stack.view(live.id!, live.token!, 'messages', { ip: '192.0.2.77' }),
  ]);
  const flooded = await Promise.all(flood);
  assert.deepEqual(viewers.map((v) => v.status), [200, 200, 200]);
  assert.ok(flooded.every((r) => r.status === 404 || r.status === 429), 'the flood only ever sees 404 or 429');
  assert.ok(flooded.some((r) => r.status === 429), 'the abusive address was limited');
  for (const ip of ['203.0.113.200', '192.0.2.77']) {
    assert.equal((await stack.view(live.id!, live.token!, 'messages', { ip })).status, 200, `${ip} still served after the flood`);
  }
  // Failed verification never took the share's concurrency or request budget.
  const parallel = await Promise.all(Array.from({ length: 4 }, (_, i) => stack.view(live.id!, live.token!, 'meta', { ip: `192.0.2.${100 + i}` })));
  assert.deepEqual(parallel.map((r) => r.status), [200, 200, 200, 200]);
});

test('D1 point 6: guest requests hold no writer lease; only the batched view counter writes, in the background', async () => {
  const session = sessionOf();
  const live = await stack.createLive(member, session.sessionId);
  const before = stack.writerCalls.count;
  for (const endpoint of ['meta', 'messages', 'messages?before=AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA']) {
    await stack.view(live.id!, live.token!, endpoint);
  }
  await stack.view(live.id!, 'W'.repeat(43), 'meta');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(stack.writerCalls.count - before <= 1, 'four requests cost at most one batched counter flush, never a lease each');
});
