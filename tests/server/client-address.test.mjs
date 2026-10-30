// Who a visitor is for the per-address rate limits: the network they are counted under, where the
// address comes from, and the log line for a proxy whose header is not trusted. Data is SYNTHETIC.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createClientAddress, networkOf } from '../../server/http/client-address.mjs';

// ---- the network a visitor is counted under -----------------------------------------------------

const NETWORKS = [
  ['an IPv4 address is its own network', '203.0.113.5', '203.0.113.5'],
  [
    'an IPv6 address counts by its /64',
    '2001:db8:abcd:12:aaaa:bbbb:cccc:dddd',
    '2001:db8:abcd:12::',
  ],
  ['compression and capitals do not change the network', '2001:DB8::1', '2001:db8:0:0::'],
  [
    'the full form of the same address',
    '2001:0DB8:0000:0000:0000:0000:0000:0001',
    '2001:db8:0:0::',
  ],
  ['leading zeros in a group', '2001:0db8:0000:0001:0000:0000:0000:0001', '2001:db8:0:1::'],
  ['the IPv6 loopback', '::1', '0:0:0:0::'],
  ['the unspecified address', '::', '0:0:0:0::'],
  ['an IPv4-mapped address is the IPv4 one', '::ffff:203.0.113.5', '203.0.113.5'],
  ['an IPv4-mapped address written in hex', '::FFFF:cb00:7105', '203.0.113.5'],
  ['an address with an IPv4 tail', '64:ff9b::203.0.113.5', '64:ff9b:0:0::'],
  ['a zone id is dropped', 'fe80::1%en0', 'fe80:0:0:0::'],
];

for (const [title, address, expected] of NETWORKS) {
  test(`network: ${title}`, () => {
    const network = networkOf(address);
    assert.equal(network, expected);
    assert.notEqual(net.isIP(network), 0, 'what is counted is itself a valid address');
    assert.equal(networkOf(network), network, 'counting twice changes nothing');
  });
}

test('network: hosts of one /64 share a network and other /64s do not', () => {
  const hosts = ['2001:db8:1:1::1', '2001:db8:1:1::2', '2001:db8:1:1:ffff:ffff:ffff:ffff'];
  assert.equal(new Set(hosts.map(networkOf)).size, 1);
  assert.notEqual(networkOf('2001:db8:1:2::1'), networkOf('2001:db8:1:1::1'));
  assert.notEqual(networkOf('2001:db8:2:1::1'), networkOf('2001:db8:1:1::1'));
});

test('network: whatever is not an address is left alone', () => {
  assert.equal(networkOf(''), '');
  assert.equal(networkOf('not an address'), 'not an address');
});

// ---- where the address comes from ---------------------------------------------------------------

/** The parts of a request that createClientAddress reads. `headers` are [name, value] in order. */
function requestFrom(socketAddress, headers = []) {
  const parsed = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    parsed[key] = key in parsed ? `${parsed[key]}, ${value}` : value;
  }
  return { rawHeaders: headers.flat(), headers: parsed, socket: { remoteAddress: socketAddress } };
}

function withLog(trustedIpHeader) {
  const logged = [];
  const clientAddress = createClientAddress({
    trustedIpHeader,
    log: (event, fields) => logged.push({ event, fields }),
  });
  return { clientAddress, logged };
}

test('without a trusted header the address is the socket address, whatever the headers say', () => {
  const { clientAddress } = withLog('');
  const forged = requestFrom('198.51.100.7', [
    ['X-Forwarded-For', '203.0.113.99'],
    ['X-Real-IP', '203.0.113.98'],
  ]);
  assert.equal(clientAddress(forged), '198.51.100.7');
});

test('a trusted header names the visitor, and an IPv6 visitor counts by /64', () => {
  const { clientAddress } = withLog('x-real-ip');
  assert.equal(
    clientAddress(requestFrom('127.0.0.1', [['X-Real-IP', '203.0.113.5']])),
    '203.0.113.5',
  );
  assert.equal(
    clientAddress(requestFrom('127.0.0.1', [['X-Real-IP', '2001:db8:abcd:12:1:2:3:4']])),
    '2001:db8:abcd:12::',
  );
});

test('a missing, repeated, comma-joined or malformed trusted header falls back to the socket', () => {
  const { clientAddress } = withLog('x-real-ip');
  const fallbacks = [
    requestFrom('127.0.0.1'),
    requestFrom('127.0.0.1', [
      ['X-Real-IP', '203.0.113.5'],
      ['X-Real-IP', '203.0.113.6'],
    ]),
    requestFrom('127.0.0.1', [['X-Real-IP', '203.0.113.5, 203.0.113.6']]),
    requestFrom('127.0.0.1', [['X-Real-IP', 'not an address']]),
  ];
  for (const request of fallbacks) assert.equal(clientAddress(request), '127.0.0.1');
});

test('a dual-stack socket address counts as the IPv4 address it carries', () => {
  const { clientAddress } = withLog('');
  assert.equal(clientAddress(requestFrom('::ffff:198.51.100.7')), '198.51.100.7');
});

test('an unknown socket address stays empty', () => {
  const { clientAddress } = withLog('');
  assert.equal(clientAddress(requestFrom(undefined)), '');
});

// ---- a proxy whose header is not trusted --------------------------------------------------------

test('a proxy header while none is trusted is logged once, without its value', () => {
  const { clientAddress, logged } = withLog('');
  const request = requestFrom('127.0.0.1', [['X-Forwarded-For', '203.0.113.5']]);
  assert.equal(clientAddress(request), '127.0.0.1');
  clientAddress(request);
  assert.deepEqual(logged, [
    { event: 'proxy_header_not_trusted', fields: { seen: 'x-forwarded-for', trusted: null } },
  ]);
});

test('a trusted header that the proxy does not send is logged once, naming both headers', () => {
  const { clientAddress, logged } = withLog('x-real-ip');
  const request = requestFrom('127.0.0.1', [['X-Forwarded-For', '203.0.113.5']]);
  clientAddress(request);
  clientAddress(request);
  assert.deepEqual(logged, [
    {
      event: 'proxy_header_not_trusted',
      fields: { seen: 'x-forwarded-for', trusted: 'x-real-ip' },
    },
  ]);
});

test('nothing is logged when the trusted header is used or when no proxy is in front', () => {
  const { clientAddress, logged } = withLog('x-real-ip');
  clientAddress(
    requestFrom('127.0.0.1', [
      ['X-Real-IP', '203.0.113.5'],
      ['X-Forwarded-For', '203.0.113.5'],
    ]),
  );
  clientAddress(requestFrom('127.0.0.1'));
  const direct = withLog('');
  direct.clientAddress(requestFrom('198.51.100.7'));
  assert.deepEqual([...logged, ...direct.logged], []);
});
