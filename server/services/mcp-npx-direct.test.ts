/**
 * T-1297: the npx→direct collapse must be aggressive where it can prove the
 * package is there and completely inert everywhere else. The failure that
 * matters is not "missed an optimisation" — it is rewriting a launcher into
 * something that does not start, which reads to the member as a dead connector.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  collapseNpxLaunchers,
  connectorServerRoots,
  parseNpxInvocation,
  resolveDirectNpxLaunch,
} from './mcp-npx-direct.js';

/** A store holding one fake package with a real bin file on disk. */
function makeStore(bin: unknown, binRelPath = 'dist/index.js'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-npx-'));
  const pkgDir = path.join(root, 'node_modules', '@scope', 'thing');
  fs.mkdirSync(path.join(pkgDir, path.dirname(binRelPath)), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, binRelPath), '#!/usr/bin/env node\n');
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@scope/thing', bin }),
  );
  return root;
}

const stores: string[] = [];
function store(bin: unknown): NodeJS.ProcessEnv {
  const root = makeStore(bin);
  stores.push(root);
  return { NASSAJ_CONNECTOR_SERVERS_DIR: root };
}

after(() => {
  for (const root of stores) fs.rmSync(root, { recursive: true, force: true });
});

describe('parseNpxInvocation', () => {
  it('reads the package and the arguments meant for the server', () => {
    assert.deepEqual(parseNpxInvocation(['-y', '@scope/thing', 'serve', '--port', '3']), {
      packageName: '@scope/thing',
      serverArgs: ['serve', '--port', '3'],
    });
  });

  it('strips a pinned version but keeps the scope', () => {
    assert.equal(parseNpxInvocation(['-y', '@scope/thing@1.2.3'])?.packageName, '@scope/thing');
    assert.equal(parseNpxInvocation(['-y', 'thing@latest'])?.packageName, 'thing');
  });

  it('bails on flags that change WHICH package runs', () => {
    // `-p pkg -c cmd` runs something this module cannot name; guessing would
    // rewrite the launcher into a different program entirely.
    assert.equal(parseNpxInvocation(['-p', '@scope/thing', 'other']), null);
    assert.equal(parseNpxInvocation(['--package=@scope/thing', 'other']), null);
  });

  it('bails on paths, URLs and an empty argument list', () => {
    assert.equal(parseNpxInvocation(['./local-server.js']), null);
    assert.equal(parseNpxInvocation(['https://example.test/x.tgz']), null);
    assert.equal(parseNpxInvocation([]), null);
  });
});

describe('resolveDirectNpxLaunch', () => {
  it('rewrites to this node plus the resolved bin, keeping server arguments', () => {
    const env = store({ thing: 'dist/index.js' });
    const out = resolveDirectNpxLaunch({ command: 'npx', args: ['-y', '@scope/thing', 'go'] }, env);
    assert.equal(out?.command, process.execPath);
    assert.equal(
      out?.args[0],
      path.join(env.NASSAJ_CONNECTOR_SERVERS_DIR!, 'node_modules/@scope/thing/dist/index.js'),
    );
    assert.deepEqual(out?.args.slice(1), ['go']);
  });

  it('accepts a string bin and a sole named bin', () => {
    assert.ok(resolveDirectNpxLaunch({ command: 'npx', args: ['-y', '@scope/thing'] }, store('dist/index.js')));
    assert.ok(resolveDirectNpxLaunch({ command: 'npx', args: ['-y', '@scope/thing'] }, store({ whatever: 'dist/index.js' })));
  });

  it('declines when several bins exist and none matches the package name', () => {
    const env = store({ a: 'dist/index.js', b: 'dist/index.js' });
    assert.equal(resolveDirectNpxLaunch({ command: 'npx', args: ['-y', '@scope/thing'] }, env), null);
  });

  it('declines when the declared bin file is missing', () => {
    const env = store({ thing: 'dist/nowhere.js' });
    assert.equal(resolveDirectNpxLaunch({ command: 'npx', args: ['-y', '@scope/thing'] }, env), null);
  });

  it('declines for a package that is not installed — the npx form must survive', () => {
    const env = store({ thing: 'dist/index.js' });
    assert.equal(resolveDirectNpxLaunch({ command: 'npx', args: ['-y', '@other/absent'] }, env), null);
  });

  it('ignores launchers that are not npx', () => {
    const env = store({ thing: 'dist/index.js' });
    assert.equal(resolveDirectNpxLaunch({ command: 'node', args: ['-y', '@scope/thing'] }, env), null);
    assert.equal(resolveDirectNpxLaunch({ command: 'uvx', args: ['@scope/thing'] }, env), null);
  });
});

describe('collapseNpxLaunchers', () => {
  it('rewrites the launcher and carries env through untouched', () => {
    const env = store({ thing: 'dist/index.js' });
    const out = collapseNpxLaunchers(
      {
        mail: { type: 'stdio', command: 'npx', args: ['-y', '@scope/thing'], env: { TOKEN: 's3cret' } },
      },
      env,
    );
    const entry = out.mail as Record<string, unknown>;
    assert.equal(entry.command, process.execPath);
    assert.equal(entry.type, 'stdio');
    assert.deepEqual(entry.env, { TOKEN: 's3cret' });
  });

  it('passes through http entries, unresolvable ones, and malformed values', () => {
    const env = store({ thing: 'dist/index.js' });
    const input = {
      remote: { type: 'http', url: 'https://example.test' },
      absent: { type: 'stdio', command: 'npx', args: ['-y', '@other/absent'] },
      broken: null,
    };
    assert.deepEqual(collapseNpxLaunchers(input, env), input);
  });

  it('does not mutate the map it was given', () => {
    const env = store({ thing: 'dist/index.js' });
    const input = { mail: { command: 'npx', args: ['-y', '@scope/thing'] } };
    collapseNpxLaunchers(input, env);
    assert.equal(input.mail.command, 'npx');
  });
});

describe('connectorServerRoots', () => {
  it('puts the configured store first and never points inside nassaj-dev data', () => {
    const roots = connectorServerRoots({ NASSAJ_CONNECTOR_SERVERS_DIR: '/srv/store', HOME: '/home/x' });
    assert.equal(roots[0], '/srv/store');
    // The provider cage hides ~/.local/share/nassaj-dev (it holds the live
    // db.sqlite); a server installed there would vanish the day it is raised.
    const protectedDataRoot = path.resolve('/home/x/.local/share/nassaj-dev');
    assert.ok(!roots.some((root) => {
      const relative = path.relative(protectedDataRoot, path.resolve(root));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }));
  });

  it('resolves the app-root dependency fallback in BOTH source and dist-server layouts (B-1118)', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/x' };
    // Source layout: this module at <app>/server/services.
    const fromSource = connectorServerRoots(env, '/app/server/services');
    // Compiled layout: this module at <app>/dist-server/server/services.
    const fromDist = connectorServerRoots(env, '/app/dist-server/server/services');
    // The application-dependency fallback is the LAST root. It must be the real
    // repo root <app> in both layouts — never <app>/dist-server, whose
    // node_modules does not exist — so a connector shipped as a dependency
    // resolves in production, not only under tsx.
    assert.equal(fromSource[fromSource.length - 1], path.resolve('/app'));
    assert.equal(fromDist[fromDist.length - 1], path.resolve('/app'));
    assert.notEqual(fromDist[fromDist.length - 1], path.resolve('/app/dist-server'));
  });
});
