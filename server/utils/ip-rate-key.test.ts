/** ADR-205 D7: rate-limit bucket keys; IPv6 rotation inside one /64 shares one bucket. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ipRateKey } from './ip-rate-key.js';

test('IPv4 stays as is; IPv4-mapped IPv6 collapses to IPv4', () => {
  assert.equal(ipRateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipRateKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipRateKey('::FFFF:198.51.100.1'), '198.51.100.1');
});

test('IPv6 collapses to its /64 in canonical lower-case hextets, whatever the notation', () => {
  const key = '2001:db8:aa:bb::/64';
  for (const address of ['2001:db8:aa:bb::1', '2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff', '2001:DB8:AA:BB:1:2:3:4',
    '2001:db8:aa:bb::1%eth0', ' 2001:db8:aa:bb:0:0:0:9 ']) {
    assert.equal(ipRateKey(address), key, address);
  }
  assert.notEqual(ipRateKey('2001:db8:aa:bc::1'), key, 'a neighbouring /64 is another bucket');
  assert.equal(ipRateKey('::1'), '0:0:0:0::/64');
  assert.equal(ipRateKey('fe80::'), 'fe80:0:0:0::/64');
  assert.equal(ipRateKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64', 'embedded IPv4 in a non-mapped prefix');
});

test('missing or unparsable input is one "unknown" bucket', () => {
  for (const value of [null, undefined, '', 'not-an-ip', '1.2.3', '2001:db8::1::2', '999.1.1.1']) {
    assert.equal(ipRateKey(value as string | null | undefined), 'unknown', String(value));
  }
});
