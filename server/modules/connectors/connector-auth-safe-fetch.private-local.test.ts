/**
 * ADR-227 / T-2098 stage 3a — resolvePrivateLocalModelAddress: the Claude body may
 * reach a local model server on a PRIVATE address only (loopback, RFC1918, tailnet
 * 100.64.0.0/10, IPv6 ULA/loopback), checked after DNS resolution, even over https.
 * Pure unit test: the resolver is injected, no packet leaves the host.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolvePrivateLocalModelAddress } = await import('./connector-auth-safe-fetch.js');

type Answer = { address: string; family: 4 | 6 };
const resolverFor = (...answers: Answer[]) => async () => answers;
const v4 = (address: string): Answer => ({ address, family: 4 });
const v6 = (address: string): Answer => ({ address, family: 6 });
const forbidden = (error: Error & { code?: string }) => {
  assert.match(String(error.code ?? error.message), /local_model_(address|url)_forbidden/u);
  return true;
};

describe('resolvePrivateLocalModelAddress', () => {
  it('accepts loopback, RFC1918, tailnet and ULA answers', async () => {
    for (const answer of [v4('127.0.0.1'), v4('10.1.2.3'), v4('172.16.0.9'), v4('192.168.8.137'),
      v4('100.101.102.103'), v6('::1'), v6('fd7a:115c:a1e0::1')]) {
      const target = await resolvePrivateLocalModelAddress('http://box.example:8080/v1', {
        resolver: resolverFor(answer), routeInterface: async () => 'tailscale0',
      });
      assert.equal(target.address, answer.address);
      assert.equal(target.url.port, '8080');
    }
  });

  it('refuses a public answer even over https, where the connector rule would accept it', async () => {
    await assert.rejects(
      resolvePrivateLocalModelAddress('https://gpu.example.com/v1', { resolver: resolverFor(v4('8.8.8.8')) }),
      forbidden,
    );
    await assert.rejects(
      resolvePrivateLocalModelAddress('https://gpu.example.com/v1', { resolver: resolverFor(v6('2606:4700::1111')) }),
      forbidden,
    );
  });

  it('refuses when ANY answer is public (split-horizon or rebinding bait)', async () => {
    await assert.rejects(
      resolvePrivateLocalModelAddress('http://box.example:8080/v1', {
        resolver: resolverFor(v4('192.168.1.5'), v4('203.0.113.7')),
      }),
      forbidden,
    );
  });

  it('refuses link-local and metadata answers and the existing URL rules still hold', async () => {
    await assert.rejects(
      resolvePrivateLocalModelAddress('http://box.example:8080/v1', { resolver: resolverFor(v4('169.254.169.254')) }),
      forbidden,
    );
    await assert.rejects(
      resolvePrivateLocalModelAddress('http://box.example:8080/v1', { resolver: resolverFor(v6('fe80::1')) }),
      forbidden,
    );
    await assert.rejects(resolvePrivateLocalModelAddress('http://127.0.0.1:80/v1', { resolver: resolverFor(v4('127.0.0.1')) }), forbidden);
    await assert.rejects(resolvePrivateLocalModelAddress('https://8.8.8.8:8443/v1', { resolver: resolverFor(v4('8.8.8.8')) }), forbidden);
  });

  it('accepts 100.64.0.0/10 only when the route to it leaves through a tailscale interface', async () => {
    const seen: string[] = [];
    const via = (dev: string | null) => async (address: string) => { seen.push(address); return dev; };
    const target = await resolvePrivateLocalModelAddress('http://box.example:8080/v1', {
      resolver: resolverFor(v4('100.101.102.103')), routeInterface: via('tailscale0'),
    });
    assert.equal(target.address, '100.101.102.103');
    assert.deepEqual(seen, ['100.101.102.103']);
    for (const dev of ['eth0', 'ens18', 'wg0', null]) {
      await assert.rejects(
        resolvePrivateLocalModelAddress('http://box.example:8080/v1', {
          resolver: resolverFor(v4('100.101.102.103')), routeInterface: via(dev),
        }),
        forbidden,
        `CGNAT via ${dev} is a carrier network, not a tailnet`,
      );
    }
    await assert.rejects(
      resolvePrivateLocalModelAddress('http://box.example:8080/v1', {
        resolver: resolverFor(v4('100.101.102.103')), routeInterface: async () => { throw new Error('ip missing'); },
      }),
      forbidden,
      'an unknown route fails closed',
    );
  });

  it('never asks for the route of an RFC1918 or loopback answer', async () => {
    const routeInterface = async () => { throw new Error('must not be called'); };
    await resolvePrivateLocalModelAddress('http://box.example:8080/v1', { resolver: resolverFor(v4('10.1.2.3')), routeInterface });
  });
});
