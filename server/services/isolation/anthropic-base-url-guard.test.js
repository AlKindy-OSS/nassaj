import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAnthropicBaseUrlAllowed,
  assertSettingsRoutingAllowed,
  isAnthropicHostAllowed,
} from './anthropic-base-url-guard.js';

// --- assertAnthropicBaseUrlAllowed: fail-closed contract ---

test('(a) ANTHROPIC_BASE_URL unset -> allowed (no throw, default Anthropic path preserved)', () => {
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({}));
  // Explicitly empty / whitespace must also be treated as unset.
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: '' }));
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: '   ' }));
});

test('(b) api.anthropic.com -> allowed', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })
  );
  // Apex and other subdomains are allowed too.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://anthropic.com/v1' })
  );
});

test('(c) a competitor host (api.moonshot.cn) -> throws with actionable, named error', () => {
  const env = { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic' };
  assert.throws(
    () => assertAnthropicBaseUrlAllowed(env),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_BASE_URL_NOT_ALLOWED');
      // Names the offending host and points to the documented remedy.
      assert.match(err.message, /api\.moonshot\.cn/);
      assert.match(err.message, /NASSAJ_ALLOWED_ANTHROPIC_HOSTS/);
      return true;
    }
  );
});

test('(d) a host added via NASSAJ_ALLOWED_ANTHROPIC_HOSTS -> allowed', () => {
  const env = {
    ANTHROPIC_BASE_URL: 'https://claude-gateway.corp.example.com',
    NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'claude-gateway.corp.example.com',
  };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed(env));
});

test('allowlist entry as a parent domain also covers its subdomains', () => {
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.proxy.example.com:8443/v1',
    NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'proxy.example.com',
  };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed(env));
});

test('allowlist accepts a full URL entry (reduced to its host)', () => {
  const env = {
    ANTHROPIC_BASE_URL: 'https://gw.example.org',
    NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'https://gw.example.org:443',
  };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed(env));
});

test('comma-separated allowlist matches any listed host', () => {
  const env = {
    ANTHROPIC_BASE_URL: 'https://second.example.net',
    NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'first.example.com, second.example.net , third.example.org',
  };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed(env));
});

// --- spoofing / anchoring: the iron rule must not be bypassable by lookalikes ---

test('lookalike apex (evil-anthropic.com) is NOT treated as Anthropic', () => {
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://api.evil-anthropic.com' }),
    /ANTHROPIC_BASE_URL/
  );
});

test('suffix-spoof subdomain (anthropic.com.attacker.dev) is rejected', () => {
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://anthropic.com.attacker.dev' }),
    /attacker\.dev/
  );
});

test('an unparseable ANTHROPIC_BASE_URL fails closed (throws)', () => {
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'not a url' }),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_BASE_URL_NOT_ALLOWED');
      return true;
    }
  );
});

// --- managed-cloud endpoints: gated on the explicit mode flag ---

test('Bedrock host allowed only when CLAUDE_CODE_USE_BEDROCK is enabled', () => {
  const url = 'https://bedrock-runtime.us-east-1.amazonaws.com';
  // Without the flag: rejected.
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: url }));
  // With the flag: allowed.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: url, CLAUDE_CODE_USE_BEDROCK: '1' })
  );
});

test('Vertex host allowed only when CLAUDE_CODE_USE_VERTEX is enabled', () => {
  const url = 'https://us-central1-aiplatform.googleapis.com';
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: url }));
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: url, CLAUDE_CODE_USE_VERTEX: 'true' })
  );
});

// --- sibling routing vars (Bedrock/Vertex base URL) + unknown routing vars ---

test('ANTHROPIC_BEDROCK_BASE_URL: amazonaws host allowed only with the Bedrock flag', () => {
  const url = 'https://bedrock-runtime.us-east-1.amazonaws.com';
  // No flag -> rejected even though the host is an AWS host.
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BEDROCK_BASE_URL: url }),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_BASE_URL_NOT_ALLOWED');
      assert.match(err.message, /ANTHROPIC_BEDROCK_BASE_URL/);
      return true;
    }
  );
  // With the flag -> allowed.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_BEDROCK_BASE_URL: url, CLAUDE_CODE_USE_BEDROCK: '1' })
  );
});

test('ANTHROPIC_BEDROCK_BASE_URL: a non-AWS host is rejected even with the Bedrock flag', () => {
  assert.throws(
    () =>
      assertAnthropicBaseUrlAllowed({
        ANTHROPIC_BEDROCK_BASE_URL: 'https://api.moonshot.cn',
        CLAUDE_CODE_USE_BEDROCK: '1',
      }),
    /ANTHROPIC_BEDROCK_BASE_URL/
  );
});

test('ANTHROPIC_VERTEX_BASE_URL: googleapis host allowed only with the Vertex flag', () => {
  const url = 'https://us-central1-aiplatform.googleapis.com';
  assert.throws(() => assertAnthropicBaseUrlAllowed({ ANTHROPIC_VERTEX_BASE_URL: url }));
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_VERTEX_BASE_URL: url, CLAUDE_CODE_USE_VERTEX: 'true' })
  );
});

test('ANTHROPIC_VERTEX_BASE_URL: a googleapis host with CLAUDE_CODE_USE_VERTEX=1 -> allowed', () => {
  // Explicit "1" spelling of the flag (the doc-named truthy form) is honored.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({
      ANTHROPIC_VERTEX_BASE_URL: 'https://us-central1-aiplatform.googleapis.com',
      CLAUDE_CODE_USE_VERTEX: '1',
    })
  );
});

// --- G1: ANTHROPIC_FOUNDRY_BASE_URL is guarded like the generic base URL ---

test('ANTHROPIC_FOUNDRY_BASE_URL: a competitor host (api.moonshot.cn) -> throws naming the host', () => {
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_FOUNDRY_BASE_URL: 'https://api.moonshot.cn' }),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_BASE_URL_NOT_ALLOWED');
      assert.match(err.message, /ANTHROPIC_FOUNDRY_BASE_URL/);
      assert.match(err.message, /api\.moonshot\.cn/);
      return true;
    }
  );
});

test('ANTHROPIC_FOUNDRY_BASE_URL: an Anthropic host -> allowed', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_FOUNDRY_BASE_URL: 'https://api.anthropic.com' })
  );
});

test('ANTHROPIC_FOUNDRY_BASE_URL: no Foundry/Azure exemption — an azure.com host is rejected (no sanctioned pattern)', () => {
  // There is no CLAUDE_CODE_USE_FOUNDRY flag and no sanctioned Foundry apex, so a
  // managed-cloud-looking host that is NOT Anthropic / operator-allowlisted is
  // refused — fail-closed, exactly like the generic base URL.
  assert.throws(
    () =>
      assertAnthropicBaseUrlAllowed({
        ANTHROPIC_FOUNDRY_BASE_URL: 'https://my-resource.cognitiveservices.azure.com',
      }),
    /ANTHROPIC_FOUNDRY_BASE_URL/
  );
});

test('ANTHROPIC_FOUNDRY_BASE_URL: a host added via NASSAJ_ALLOWED_ANTHROPIC_HOSTS -> allowed', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://foundry-gw.corp.example.com',
      NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'foundry-gw.corp.example.com',
    })
  );
});

// --- G1: each competitor case + all-four-unset, across all four routing vars ---

test('each of the 4 routing vars set to https://api.moonshot.cn -> throws naming the host', () => {
  for (const name of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_BASE_URL',
  ]) {
    assert.throws(
      () => assertAnthropicBaseUrlAllowed({ [name]: 'https://api.moonshot.cn' }),
      (err) => {
        assert.equal(err.code, 'ANTHROPIC_BASE_URL_NOT_ALLOWED', `${name}: code`);
        assert.match(err.message, new RegExp(name), `${name}: names the var`);
        assert.match(err.message, /api\.moonshot\.cn/, `${name}: names the host`);
        return true;
      },
      `${name} pointed at api.moonshot.cn must throw`
    );
  }
});

test('all four routing vars unset -> allowed (default Anthropic path never regresses)', () => {
  // The live default path: none of the four set. Must be a no-op.
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed({}));
  // Explicitly-present-but-empty values are treated as unset too.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_BEDROCK_BASE_URL: '',
      ANTHROPIC_VERTEX_BASE_URL: '   ',
      ANTHROPIC_FOUNDRY_BASE_URL: '',
    })
  );
});

test('an UNKNOWN routing var (ANTHROPIC_PROXY_BASE_URL) is rejected outright', () => {
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_PROXY_BASE_URL: 'https://api.anthropic.com' }),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_BASE_URL_NOT_ALLOWED');
      assert.match(err.message, /ANTHROPIC_PROXY_BASE_URL/);
      assert.match(err.message, /unrecognized/i);
      return true;
    }
  );
});

test('a non-routing ANTHROPIC_* var (e.g. ANTHROPIC_API_KEY) is NOT treated as a routing var', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_API_KEY: 'sk-ant-xxx', ANTHROPIC_AUTH_TOKEN: 'tok' })
  );
});

// --- trailing-dot FQDN normalization ---

test('a trailing-dot Anthropic FQDN (anthropic.com.) is accepted', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com./v1' })
  );
});

// --- assertSettingsRoutingAllowed: one parsed settings object (any tier) ---
// The file set (managed / user / project / local) is read by claude-spawn-env-guard.js
// and covered in claude-settings-routing.acceptance.test.ts (B-1764).

const LABEL = 'project settings /p/.claude/settings.json';

test('settings env with a competitor ANTHROPIC_BASE_URL is rejected (closes the bypass)', () => {
  assert.throws(
    () => assertSettingsRoutingAllowed({ env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic' } }, {}, LABEL),
    (err) => {
      assert.equal(err.code, 'ANTHROPIC_BASE_URL_NOT_ALLOWED');
      assert.match(err.message, /api\.moonshot\.cn/);
      assert.match(err.message, /project settings/);
      return true;
    }
  );
});

test('settings env with an Anthropic ANTHROPIC_BASE_URL is allowed', () => {
  assert.doesNotThrow(() =>
    assertSettingsRoutingAllowed({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, {}, LABEL)
  );
});

test('settings Bedrock base URL honored when the flag is in the spawn env', () => {
  const settings = { env: { ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com' } };
  // Flag in spawn env enables the cloud declared in the settings file.
  assert.doesNotThrow(() => assertSettingsRoutingAllowed(settings, { CLAUDE_CODE_USE_BEDROCK: '1' }, LABEL));
  // Without the flag anywhere: rejected.
  assert.throws(() => assertSettingsRoutingAllowed(settings, {}, LABEL));
});

test('settings env with an unknown routing var is rejected', () => {
  assert.throws(
    () => assertSettingsRoutingAllowed({ env: { CLAUDE_GATEWAY_BASE_URL: 'https://api.anthropic.com' } }, {}, LABEL),
    /CLAUDE_GATEWAY_BASE_URL/
  );
});

test('a non-object settings env block fails closed (throws)', () => {
  for (const env of [['ANTHROPIC_BASE_URL=http://x'], 'ANTHROPIC_BASE_URL=http://x', 7]) {
    assert.throws(
      () => assertSettingsRoutingAllowed({ env }, {}, LABEL),
      (err) => err.code === 'ANTHROPIC_BASE_URL_NOT_ALLOWED'
    );
  }
});

test('settings without an env block (or a null one) are no-ops', () => {
  assert.doesNotThrow(() => assertSettingsRoutingAllowed({ theme: 'dark' }, {}, LABEL));
  assert.doesNotThrow(() => assertSettingsRoutingAllowed({ env: null }, {}, LABEL));
});

// --- isAnthropicHostAllowed: pure-function spot checks ---

test('isAnthropicHostAllowed: empty host is never allowed', () => {
  assert.equal(isAnthropicHostAllowed('', {}), false);
  assert.equal(isAnthropicHostAllowed(null, {}), false);
});

test('isAnthropicHostAllowed: api.anthropic.com is allowed with empty env', () => {
  assert.equal(isAnthropicHostAllowed('api.anthropic.com', {}), true);
});
