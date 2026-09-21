import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildQwenSettings,
  materializeQwenSettings,
  QWEN_PROVIDER_ID,
  QWEN_SELECTED_AUTH_TYPE,
  QWEN_SETTINGS_FILENAME,
} from './qwen-settings-material.js';

const TOKEN_PLAN_RUNTIME = {
  baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
};

const CODING_PLAN_RUNTIME = {
  baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  envKey: 'BAILIAN_CODING_PLAN_API_KEY',
};

const TOKEN_PLAN_MODELS = [{ value: 'qwen3.7-plus', label: 'Qwen3.7 Plus' }, { value: 'glm-5.2', label: 'GLM-5.2' }];

function tempQwenHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'qwen-settings-'));
  const home = path.join(root, '.qwen');
  mkdirSync(home, { recursive: true });
  return home;
}

function readSettings(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, QWEN_SETTINGS_FILENAME), 'utf8'));
}

test('writes the measured-minimal registry: auth type selected, models bound to the env key', () => {
  const home = tempQwenHome();
  try {
    assert.equal(materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS), true);

    const settings = readSettings(home);
    assert.equal(settings.$version, 4);
    assert.deepEqual((settings.security as { auth: { selectedType: string } }).auth.selectedType, QWEN_SELECTED_AUTH_TYPE);

    const providers = settings.modelProviders as Record<string, Array<Record<string, unknown>>>;
    assert.deepEqual(providers[QWEN_PROVIDER_ID], [
      { id: 'qwen3.7-plus', baseUrl: TOKEN_PLAN_RUNTIME.baseUrl, envKey: TOKEN_PLAN_RUNTIME.envKey },
      { id: 'glm-5.2', baseUrl: TOKEN_PLAN_RUNTIME.baseUrl, envKey: TOKEN_PLAN_RUNTIME.envKey },
    ]);

    // Nothing beyond the measured contract is invented: no `name`, no
    // `generationConfig`, no `model` block (B-235 — no fabricated values).
    assert.deepEqual(Object.keys(providers[QWEN_PROVIDER_ID]![0]!).sort(), ['baseUrl', 'envKey', 'id']);
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('persists the envKey NAME and never the credential value', () => {
  const home = tempQwenHome();
  try {
    assert.equal(materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS), true);

    const settings = readSettings(home);
    assert.equal(settings.env, undefined, 'the settings file must carry no env block');

    const raw = readFileSync(path.join(home, QWEN_SETTINGS_FILENAME), 'utf8');
    assert.equal(raw.includes('sk-sp-'), false);
    assert.match(raw, /BAILIAN_TOKEN_PLAN_API_KEY/, 'the variable NAME is the whole point of the indirection');
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('reaps a credential an earlier pass or a member left in env, keeping their other settings', () => {
  const home = tempQwenHome();
  try {
    writeFileSync(path.join(home, QWEN_SETTINGS_FILENAME), JSON.stringify({
      ui: { autoModeAcknowledged: true },
      permissions: { allow: ['Bash(run)'] },
      env: {
        BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-leaked-by-an-older-pass',
        OPENAI_API_KEY: 'operator-key-that-must-not-survive',
        HTTPS_PROXY: 'http://member-proxy:3128',
      },
    }));

    assert.equal(materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS), true);

    const settings = readSettings(home);
    const raw = readFileSync(path.join(home, QWEN_SETTINGS_FILENAME), 'utf8');
    assert.equal(raw.includes('sk-sp-leaked-by-an-older-pass'), false);
    assert.equal(raw.includes('operator-key-that-must-not-survive'), false);

    // The member's own unrelated preferences survive — this file is theirs.
    assert.deepEqual(settings.ui, { autoModeAcknowledged: true });
    assert.deepEqual(settings.permissions, { allow: ['Bash(run)'] });
    assert.deepEqual((settings.env as Record<string, string>), { HTTPS_PROXY: 'http://member-proxy:3128' });
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('follows the member plan: a Coding Plan credential binds the Coding Plan endpoint', () => {
  const home = tempQwenHome();
  try {
    assert.equal(materializeQwenSettings(home, CODING_PLAN_RUNTIME, [{ value: 'qwen3-coder-plus' }]), true);

    const providers = readSettings(home).modelProviders as Record<string, Array<Record<string, string>>>;
    assert.equal(providers[QWEN_PROVIDER_ID]![0]!.baseUrl, CODING_PLAN_RUNTIME.baseUrl);
    assert.equal(providers[QWEN_PROVIDER_ID]![0]!.envKey, CODING_PLAN_RUNTIME.envKey);
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('is idempotent: a correct registry is left byte-identical and untouched', () => {
  const home = tempQwenHome();
  try {
    materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS);
    const target = path.join(home, QWEN_SETTINGS_FILENAME);
    const before = readFileSync(target, 'utf8');
    const { mtimeMs } = statSync(target);

    assert.equal(materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS), true);

    assert.equal(readFileSync(target, 'utf8'), before);
    assert.equal(statSync(target).mtimeMs, mtimeMs, 'a spawn must not rewrite the file every turn');
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('rewrites a drifted registry so a plan change takes effect', () => {
  const home = tempQwenHome();
  try {
    materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS);
    assert.equal(materializeQwenSettings(home, CODING_PLAN_RUNTIME, [{ value: 'qwen3-coder-plus' }]), true);

    const providers = readSettings(home).modelProviders as Record<string, Array<Record<string, string>>>;
    assert.equal(providers[QWEN_PROVIDER_ID]!.length, 1);
    assert.equal(providers[QWEN_PROVIDER_ID]![0]!.envKey, CODING_PLAN_RUNTIME.envKey);
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('replaces a hostile symlink instead of writing through it to the operator file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'qwen-settings-link-'));
  try {
    const operatorHome = path.join(root, 'operator', '.qwen');
    mkdirSync(operatorHome, { recursive: true });
    const operatorSettings = path.join(operatorHome, QWEN_SETTINGS_FILENAME);
    const operatorContents = JSON.stringify({ env: { BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-operator-subscription' } });
    writeFileSync(operatorSettings, operatorContents);

    const memberHome = path.join(root, 'member', '.qwen');
    mkdirSync(memberHome, { recursive: true });
    symlinkSync(operatorSettings, path.join(memberHome, QWEN_SETTINGS_FILENAME));

    assert.equal(materializeQwenSettings(memberHome, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS), true);

    // The operator's file is byte-identical — the member's registry is a real file.
    assert.equal(readFileSync(operatorSettings, 'utf8'), operatorContents);
    assert.equal(lstatSync(path.join(memberHome, QWEN_SETTINGS_FILENAME)).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(memberHome, QWEN_SETTINGS_FILENAME), 'utf8').includes('sk-sp-operator-subscription'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('is owner-only readable and writable, so the CLI can keep its own preferences', () => {
  const home = tempQwenHome();
  try {
    materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS);
    assert.equal(statSync(path.join(home, QWEN_SETTINGS_FILENAME)).mode & 0o777, 0o600);
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('refuses to write anything when the inputs cannot describe a working registry', () => {
  const home = tempQwenHome();
  try {
    assert.equal(materializeQwenSettings('', TOKEN_PLAN_RUNTIME, TOKEN_PLAN_MODELS), false);
    assert.equal(materializeQwenSettings(home, { baseUrl: '', envKey: 'X' }, TOKEN_PLAN_MODELS), false);
    assert.equal(materializeQwenSettings(home, TOKEN_PLAN_RUNTIME, []), false);

    // A registry with no models is worse than none: it reproduces the silent
    // "engine visible but unusable" failure ADR-101 warns about.
    const settingsPath = path.join(home, QWEN_SETTINGS_FILENAME);
    assert.equal(lstatSync(settingsPath, { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(path.dirname(home), { recursive: true, force: true });
  }
});

test('buildQwenSettings is pure and starts from nothing when the member has no file', () => {
  const built = buildQwenSettings({}, TOKEN_PLAN_RUNTIME, [{ value: 'qwen3.7-plus' }]);
  assert.deepEqual(built, {
    $version: 4,
    security: { auth: { selectedType: 'openai' } },
    modelProviders: {
      openai: [{
        id: 'qwen3.7-plus',
        baseUrl: TOKEN_PLAN_RUNTIME.baseUrl,
        envKey: TOKEN_PLAN_RUNTIME.envKey,
      }],
    },
  });
});
