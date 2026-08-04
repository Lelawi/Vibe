import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateAddress } from './urlProbe.js';

test('blockiert lokale und private IPv4-Adressen', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test('laesst oeffentliche Adressen zu', () => {
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
});
