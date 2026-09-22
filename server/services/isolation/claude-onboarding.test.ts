/**
 * claude-onboarding.test.ts — per-user Claude connection-status check
 * (B-MU-ONBOARD). Verifies getClaudeConnectionStatus reports connected=true
 * only when the user's OWN isolated dir holds a valid credential artifact, and
 * never leaks the token value.
 *
 * HOME is sandboxed before importing the module so userConfigDir resolves under
 * tmp, never the operator's real ~/.nassaj-users. (os.homedir() honors $HOME.)
 *
 * Runner: Node built-in test runner (node:test + node:assert) via tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-onboarding-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CONFIG_DIR;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;

assert.equal(
  os.homedir(),
  sandboxHome,
  'os.homedir() must honor the sandboxed $HOME so the check reads tmp, not real home'
);

const { getClaudeConnectionStatus, resolveClaudeStatusDir } = await import('./claude-onboarding.service.js');
const { userConfigDir } = await import('./provision-user-dirs.js');

/** Creates a user's .claude dir and returns its path. */
function makeClaudeDir(userId: number): string {
  const dir = userConfigDir(userId, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

after(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('getClaudeConnectionStatus', () => {
  it('reports not connected when the user dir does not exist', async () => {
    const status = await getClaudeConnectionStatus(1001);
    // B-1260: the shape now carries incompleteLink alongside connected.
    assert.deepEqual(status, { connected: false, incompleteLink: false, provider: 'claude' });
  });

  it('reports not connected for an empty .claude dir', async () => {
    makeClaudeDir(1002);
    const status = await getClaudeConnectionStatus(1002);
    assert.equal(status.connected, false);
    assert.equal(status.provider, 'claude');
  });

  it('reports connected for a full non-expired OAuth credentials.json', async () => {
    const dir = makeClaudeDir(1003);
    // B-1260: a FULL link carries a refresh token; a bare access token is now a
    // partial link (see the dedicated B-1260 cases below), not "connected".
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-secret-xyz',
          refreshToken: 'rt-secret',
          expiresAt: Date.now() + 3_600_000,
          refreshTokenExpiresAt: Date.now() + 13 * 86_400_000,
        },
      })
    );
    const status = await getClaudeConnectionStatus(1003);
    assert.equal(status.connected, true);
    assert.equal(status.incompleteLink, false);
    // The token value must never appear in the response.
    assert.equal(JSON.stringify(status).includes('sk-secret-xyz'), false);
  });

  it('reports not connected for an expired OAuth token', async () => {
    const dir = makeClaudeDir(1004);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-old', expiresAt: Date.now() - 1000 },
      })
    );
    assert.equal((await getClaudeConnectionStatus(1004)).connected, false);
  });

  it('reports connected when settings.json declares an Anthropic API key', async () => {
    const dir = makeClaudeDir(1005);
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-123' } })
    );
    assert.equal((await getClaudeConnectionStatus(1005)).connected, true);
  });

  it('B-1260: settings CLAUDE_CODE_OAUTH_TOKEN alone is an INCOMPLETE link, not connected', async () => {
    // B-1075 stored the inference-only setup-token here and called it connected.
    // B-1260: that token cannot read usage/profile, so it is a partial link — the
    // card shows "incomplete, re-link" rather than a false "connected".
    const dir = makeClaudeDir(1013);
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-123' } })
    );
    const status = await getClaudeConnectionStatus(1013);
    assert.equal(status.connected, false);
    assert.equal(status.incompleteLink, true);
  });

  it('B-1260: an access token with NO refresh token is an incomplete link, not connected', async () => {
    // The exact shape reported on a fleet node: accessToken + scopes present, but no
    // refreshToken and no expiresAt — previously read as "connected" though it
    // could not renew and did not work.
    const dir = makeClaudeDir(1014);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-fixture',
          scopes: ['file_upload', 'inference', 'mcp_servers', 'profile', 'sessions:claude_code'],
          subscriptionType: 'max',
        },
      })
    );
    const status = await getClaudeConnectionStatus(1014);
    assert.equal(status.connected, false);
    assert.equal(status.incompleteLink, true);
  });

  it('B-1260: the REAL measured full-OAuth scope array + refresh → connected', async () => {
    // qa-critic live measurement (two fleet nodes): the exact scopes a
    // working full sign-in carries, alongside a refresh token.
    const dir = makeClaudeDir(1016);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-fixture',
          refreshToken: 'rt-fixture',
          expiresAt: Date.now() + 3_600_000,
          refreshTokenExpiresAt: Date.now() + 13 * 86_400_000,
          scopes: [
            'user:file_upload',
            'user:inference',
            'user:mcp_servers',
            'user:plugins',
            'user:profile',
            'user:sessions:claude_code',
          ],
        },
      })
    );
    const status = await getClaudeConnectionStatus(1016);
    assert.equal(status.connected, true);
    assert.equal(status.incompleteLink, false);
  });

  it('B-1260: inference-only scopes (no profile) are an incomplete link', async () => {
    const dir = makeClaudeDir(1015);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-fixture',
          refreshToken: 'rt-fixture',
          expiresAt: Date.now() + 3_600_000,
          scopes: ['inference'],
        },
      })
    );
    const status = await getClaudeConnectionStatus(1015);
    assert.equal(status.connected, false);
    assert.equal(status.incompleteLink, true);
  });

  it('reports not connected when settings.json env is empty', async () => {
    const dir = makeClaudeDir(1006);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: {} }));
    assert.equal((await getClaudeConnectionStatus(1006)).connected, false);
  });

  it('reports not connected for a malformed credentials.json (no throw)', async () => {
    const dir = makeClaudeDir(1007);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{ not valid json');
    assert.equal((await getClaudeConnectionStatus(1007)).connected, false);
  });

  it('ignores a blank accessToken', async () => {
    const dir = makeClaudeDir(1008);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '   ' } })
    );
    assert.equal((await getClaudeConnectionStatus(1008)).connected, false);
  });

  /*
   * B-586 — this leg is OR'd with the provider status in the account card, so
   * it has to judge the same clock. `expiresAt` is the access token (~8h, the
   * CLI rotates it silently); `refreshTokenExpiresAt` is when the link itself
   * dies. Judging the first alone called a healthy member disconnected.
   */
  function writeOauth(userId: number, oauth: Record<string, unknown>): void {
    const dir = makeClaudeDir(userId);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fixture', ...oauth } })
    );
  }

  it('stays connected when an expired access token still has a refresh token', async () => {
    writeOauth(1009, {
      expiresAt: Date.now() - 1000,
      refreshToken: 'rt-fixture',
      refreshTokenExpiresAt: Date.now() + 13 * 86_400_000,
    });
    assert.equal((await getClaudeConnectionStatus(1009)).connected, true);
  });

  it('reports not connected once both clocks have run out', async () => {
    writeOauth(1010, {
      expiresAt: Date.now() - 1000,
      refreshToken: 'rt-fixture',
      refreshTokenExpiresAt: Date.now() - 1000,
    });
    assert.equal((await getClaudeConnectionStatus(1010)).connected, false);
  });

  it('reads a zero expiresAt as dead rather than as "never expires"', async () => {
    writeOauth(1011, { expiresAt: 0 });
    assert.equal((await getClaudeConnectionStatus(1011)).connected, false);
  });

  it('stays connected while the access token holds, even past the link stamp', async () => {
    // الحالةُ التي ناقضت البطاقةُ نفسها فيها: شارةٌ تقول «متصل» — لأن الأصل كفّ
    // عن القتل على الميقات — ودعوةُ ربطٍ تحتها تقول «اربط اشتراكك»، لأن هذه
    // الساق بقيت على القاعدة القديمة. القاعدةُ واحدة أو تكذب البطاقة.
    writeOauth(1012, {
      expiresAt: Date.now() + 3 * 3_600_000,
      refreshToken: 'rt-fixture',
      refreshTokenExpiresAt: Date.now() - 60_000,
    });
    assert.equal((await getClaudeConnectionStatus(1012)).connected, true);
  });

  it('agrees with the provider status leg on the same credential', async () => {
    // الساقان تُجمعان بـ`OR` في بطاقة الحساب، فافتراقُهما يُنتج تناقضاً مرئياً
    // لا خطأً صامتاً. هذا الحارس يمرّ الحالات الحدّية على الاثنتين معاً.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['past link stamp, access alive', {
        expiresAt: Date.now() + 3 * 3_600_000,
        refreshToken: 'rt', refreshTokenExpiresAt: Date.now() - 60_000,
      }],
      ['expired access, live refresh', {
        expiresAt: Date.now() - 60_000,
        refreshToken: 'rt', refreshTokenExpiresAt: Date.now() + 13 * 86_400_000,
      }],
      ['both clocks out', {
        expiresAt: Date.now() - 60_000,
        refreshToken: 'rt', refreshTokenExpiresAt: Date.now() - 60_000,
      }],
      ['no refresh token, expired access', { expiresAt: Date.now() - 60_000 }],
    ];

    // اختبارُ تطابقٍ بين طبقتين يستوردهما معاً بحكم تعريفه — والبديلُ أن يعيش
    // في وحدة providers فيستورد هذه الطبقة عبر الحدّ المقابل، وهو نفس العبور.
    // eslint-disable-next-line boundaries/dependencies
    const { ClaudeProviderAuth } = await import('@/modules/providers/list/claude/claude-auth.provider.js');
    const auth = new ClaudeProviderAuth();
    const originalCliPath = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = process.execPath; // `node --version` exits 0

    try {
      let userId = 1100;
      for (const [label, oauth] of cases) {
        userId += 1;
        const dir = makeClaudeDir(userId);
        fs.writeFileSync(
          path.join(dir, '.credentials.json'),
          JSON.stringify({ claudeAiOauth: { accessToken: 'sk-fixture', ...oauth } }),
        );

        const leg1 = (await auth.getStatus(userId)).authenticated;
        const leg2 = (await getClaudeConnectionStatus(userId)).connected;
        assert.equal(leg2, leg1, `الساقان تختلفان على «${label}»`);
      }
    } finally {
      if (originalCliPath === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = originalCliPath;
    }
  });
});

describe('B-1087: shared policy reads the operator dir, not the isolated one', () => {
  const operatorDir = path.join(sandboxHome, '.claude');

  it('resolves the isolated dir under the isolated policy and the operator dir under shared', () => {
    assert.equal(resolveClaudeStatusDir(2001, true), userConfigDir(2001, '.claude'));
    assert.equal(resolveClaudeStatusDir(2001, false), operatorDir);
  });

  it('reports connected under shared when only the operator dir holds a live OAuth link', async () => {
    fs.mkdirSync(operatorDir, { recursive: true });
    fs.writeFileSync(
      path.join(operatorDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-operator', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } })
    );
    makeClaudeDir(2002);
    assert.equal((await getClaudeConnectionStatus(2002, { isolated: false })).connected, true);
    assert.equal((await getClaudeConnectionStatus(2002, { isolated: true })).connected, false);
  });
});
