import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addressBlockCategory,
  addressKey,
  hostInterfaceAddresses,
  legacyConnectorAddressForbidden,
  type AddressPolicy,
} from './address-policy.js';

const BOTH: AddressPolicy[] = ['public', 'private_allowed'];
const OWN = new Set(['v4:93.184.216.40', 'v6:2a01:4f8:0:0:0:0:0:99']);

/** D7 address matrix rows blocked under BOTH policies, with their category. */
const ALWAYS_BLOCKED: Array<[string, string]> = [
  ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'], ['::1', 'loopback'],
  ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'unspecified'], ['::', 'unspecified'],
  ['169.254.1.1', 'link_local'], ['fe80::1', 'link_local'], ['febf::1', 'link_local'],
  ['169.254.169.254', 'metadata'], ['fd00:ec2::254', 'metadata'], ['100.100.100.200', 'metadata'],
  ['168.63.129.16', 'metadata'],
  ['224.0.0.1', 'multicast'], ['239.255.255.255', 'multicast'], ['ff02::1', 'multicast'],
  ['255.255.255.255', 'reserved'], ['240.0.0.1', 'reserved'],
  ['192.0.0.8', 'special'], ['192.0.2.1', 'special'], ['198.51.100.7', 'special'], ['203.0.113.9', 'special'],
  ['198.18.0.1', 'special'], ['198.19.255.255', 'special'], ['192.88.99.1', 'special'],
  ['2001:db8::1', 'special'], ['100::1', 'special'], ['3fff::1', 'special'],
  ['2001:10::1', 'teredo'], ['2001:20::1', 'teredo'], ['2001::1', 'teredo'], ['2001:0:4136:e378::1', 'teredo'],
  ['2001:1ff::1', 'teredo'],
  ['2002::1', '6to4'], ['2002:5db8:d822::1', '6to4'],
  ['64:ff9b::5db8:d822', 'nat64'], ['64:ff9b::a00:1', 'nat64'], ['64:ff9b:1::1', 'nat64'],
  ['::8.8.8.8', 'ipv4_compatible'], ['::10.0.0.1', 'ipv4_compatible'],
  ['100.100.100.100', 'tailnet_resolver'], ['fd7a:115c:a1e0::53', 'tailnet_resolver'],
  ['fec0::1', 'non_global'], ['4000::1', 'non_global'],
  ['93.184.216.40', 'own_interface'], ['2a01:4f8::99', 'own_interface'], ['::ffff:93.184.216.40', 'own_interface'],
  ['not-an-ip', 'invalid'], ['1.2.3', 'invalid'], ['1:2:3', 'invalid'], ['', 'invalid'],
];

/** Blocked under `public`, allowed under `private_allowed`. */
const PRIVATE_ONLY: Array<[string, string]> = [
  ['10.0.0.1', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'],
  ['100.64.0.1', 'cgnat'], ['100.127.255.254', 'cgnat'], ['100.101.102.103', 'cgnat'],
  ['fc00::1', 'ula'], ['fd7a:115c:a1e0::1', 'ula'], ['fd7a:115c:a1e0:ab12::1', 'ula'],
  ['::ffff:10.0.0.1', 'private'], ['::ffff:100.64.0.1', 'cgnat'],
];

const ALLOWED_EVERYWHERE = [
  '93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450::1',
  '::ffff:93.184.216.34', '2001:200::1',
];

test('D7: special ranges are blocked under both policies with their category', () => {
  for (const policy of BOTH) {
    for (const [address, category] of ALWAYS_BLOCKED) {
      assert.equal(addressBlockCategory(address, policy, OWN), category, `${policy} ${address}`);
    }
  }
});

test('D7: RFC1918, CGNAT and ULA are blocked under public only', () => {
  for (const [address, category] of PRIVATE_ONLY) {
    assert.equal(addressBlockCategory(address, 'public', OWN), category, address);
    assert.equal(addressBlockCategory(address, 'private_allowed', OWN), null, address);
  }
});

test('D7: global unicast is allowed under both policies', () => {
  for (const policy of BOTH) {
    for (const address of ALLOWED_EVERYWHERE) {
      assert.equal(addressBlockCategory(address, policy, OWN), null, `${policy} ${address}`);
    }
  }
});

test('IPv4-mapped forms are evaluated as the embedded IPv4, zone ids are ignored', () => {
  assert.equal(addressBlockCategory('::ffff:127.0.0.1', 'private_allowed'), 'loopback');
  assert.equal(addressBlockCategory('::ffff:7f00:1', 'public'), 'loopback');
  assert.equal(addressBlockCategory('::ffff:169.254.169.254', 'private_allowed'), 'metadata');
  assert.equal(addressBlockCategory('fe80::1%eth0', 'public'), 'link_local');
  assert.equal(addressBlockCategory(42 as unknown as string, 'public'), 'invalid');
});

test('addressKey canonicalizes v4, v6 and mapped forms', () => {
  assert.equal(addressKey('10.0.0.1'), 'v4:10.0.0.1');
  assert.equal(addressKey('::ffff:10.0.0.1'), 'v4:10.0.0.1');
  assert.equal(addressKey('2A01:4F8::99'), 'v6:2a01:4f8:0:0:0:0:0:99');
  assert.equal(addressKey('fe80::1%lo'), 'v6:fe80:0:0:0:0:0:0:1');
  assert.equal(addressKey('nope'), null);
});

test('hostInterfaceAddresses enumerates every interface address at call time', () => {
  const own = hostInterfaceAddresses(() => ({
    lo: [{ address: '127.0.0.1' }, { address: '::1' }],
    tailscale0: [{ address: '100.105.15.56' }, { address: 'fd7a:115c:a1e0::1234' }],
    bogus: undefined,
  }) as never);
  assert.equal(addressBlockCategory('100.105.15.56', 'private_allowed', own), 'own_interface');
  assert.equal(addressBlockCategory('fd7a:115c:a1e0::1234', 'private_allowed', own), 'own_interface');
  assert.equal(addressBlockCategory('100.105.15.57', 'private_allowed', own), null);
  assert.ok(hostInterfaceAddresses().size > 0, 'the real host has at least a loopback interface');
});

/** Deterministic xorshift so failures reproduce. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

test('superset: every address the legacy connector table blocked is blocked under public', () => {
  // Exhaustive over every /16 with edge and middle host values.
  for (let a = 0; a < 256; a += 1) {
    for (let b = 0; b < 256; b += 1) {
      for (const [c, d] of [[0, 0], [0, 1], [2, 7], [99, 1], [100, 9], [113, 5], [255, 255]]) {
        const address = `${a}.${b}.${c}.${d}`;
        if (legacyConnectorAddressForbidden(address)) {
          assert.notEqual(addressBlockCategory(address, 'public'), null, address);
        }
      }
    }
  }
  const next = rng(0x5eed);
  const word = () => Math.floor(next() * 0x10000).toString(16);
  const prefixes = ['0:0:0:0:0:0', '0:0:0:0:0:ffff', '64:ff9b:0:0:0:0', '64:ff9b:1', '2001:0', '2001:db8', '2002',
    '3fff:0', 'fc00', 'fe80', 'ff02', '100:0:0:0', '2606:4700', ''];
  for (let i = 0; i < 20_000; i += 1) {
    const prefix = prefixes[i % prefixes.length];
    const head = prefix === '' ? [] : prefix.split(':');
    const tail = Array.from({ length: 8 - head.length }, word);
    const address = [...head, ...tail].join(':');
    if (legacyConnectorAddressForbidden(address)) {
      assert.notEqual(addressBlockCategory(address, 'public'), null, address);
    }
  }
});

test('superset: the legacy connector suite address list is blocked under public too', () => {
  for (const address of [
    '10.0.0.1', '127.0.0.1', '169.254.2.3', '192.88.99.1', '224.0.0.1',
    '::1', '::10.0.0.1', '::ffff:127.0.0.1',
    '64:ff9b::a00:1', '64:ff9b:1:a00:0:100::',
    '100::1', '2001::1', '2001:2::1', '2001:db8::1', '2002:a00:1::1',
    '3fff::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1',
  ]) {
    assert.equal(legacyConnectorAddressForbidden(address), true, address);
    assert.notEqual(addressBlockCategory(address, 'public'), null, address);
  }
  assert.equal(legacyConnectorAddressForbidden('not-ip'), true);
  assert.equal(legacyConnectorAddressForbidden('1:2:3'), true);
});
