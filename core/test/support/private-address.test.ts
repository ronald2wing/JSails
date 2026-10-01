/** Tests for `isPrivateAddress` and `isLoopbackAddress`, the classifiers behind `guardedFetch`. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLoopbackAddress, isPrivateAddress } from '../../src/support/private-address.server.js';

describe('isPrivateAddress', () => {
  it('refuses every private, loopback, link-local, and reserved IPv4 range', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '127.8.9.10',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it('accepts public IPv4 addresses, including the edges of private ranges', () => {
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.215.14',
      '100.63.255.255',
      '100.128.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.169.0.1',
    ]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it('refuses private IPv6 ranges and IPv6 addresses that carry a private IPv4', () => {
    for (const address of [
      '::',
      '::1',
      'fe80::1',
      'fe80::1%eth0',
      'fc00::1',
      'fd12:3456::1',
      'fec0::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:0:7f00:1',
      '::ffff:0:127.0.0.1',
      '::ffff:0:a9fe:a9fe',
      '::10.0.0.1',
      '64:ff9b::a00:1',
      '64:ff9b::192.168.0.1',
      '64:ff9b:1::1',
      '2002:a00:1::1',
      '2002:7f00:1::',
      '2001::1',
      '2001:db8::1',
    ]) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it('accepts public IPv6 addresses and IPv6 forms of public IPv4 addresses', () => {
    for (const address of [
      '2606:4700:4700::1111',
      '2a00:1450:4001:80b::200e',
      '::ffff:8.8.8.8',
      '::ffff:0:808:808',
      '64:ff9b::808:808',
      '2002:808:808::1',
    ]) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it('fails closed on anything that is not an IP literal', () => {
    for (const address of ['', 'localhost', 'example.com', '1.2.3', '[::1]']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });
});

describe('isLoopbackAddress', () => {
  it('accepts loopback addresses and IPv6 forms that carry one', () => {
    for (const address of [
      '127.0.0.1',
      '127.8.9.10',
      '::1',
      '::ffff:127.0.0.1',
      '0:0:0:0:0:0:0:1',
    ]) {
      assert.equal(isLoopbackAddress(address), true, address);
    }
  });

  it('refuses every other address and anything that is not an IP literal', () => {
    for (const address of ['10.0.0.1', '8.8.8.8', 'fe80::1', '::', 'localhost', '[::1]', '']) {
      assert.equal(isLoopbackAddress(address), false, address);
    }
  });
});
