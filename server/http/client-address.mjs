// Who a visitor is for the per-address rate limits. The server listens on loopback behind a reverse
// proxy, so the socket address is the proxy's: the real visitor is known only from a header that the
// operator names (METRICTV_TRUSTED_IP_HEADER) because the proxy always overwrites it.
import net from 'node:net';
import { logEvent } from '../log.mjs';
import { singleHeaderValue } from './static-files.mjs';

const IPV6_GROUP_COUNT = 8;
// ceiling: a limit counts one /64, so a client that holds a larger block (some providers hand out a
// /56 or a /48) can still rotate through its /64s, upgrade: count a shorter prefix if one does
const NETWORK_GROUP_COUNT = 4;
const IPV4_MAPPED_MARKER = 0xffff;
// Added by nearly every proxy. Seeing one when the visitor's address did not come from the trusted
// header means every visitor is being counted as the proxy.
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip'];

/** The eight 16-bit groups of an IPv6 address that already passed net.isIPv6. */
function ipv6Groups(address) {
  const withoutZone = address.split('%')[0];
  const lastColon = withoutZone.lastIndexOf(':');
  const tail = withoutZone.slice(lastColon + 1);
  let text = withoutZone;
  if (tail.includes('.')) {
    // An IPv4 tail such as ::ffff:203.0.113.5 stands for its last two groups.
    const [first, second, third, fourth] = tail.split('.').map(Number);
    const toGroup = (high, low) => ((high << 8) | low).toString(16);
    text = `${withoutZone.slice(0, lastColon + 1)}${toGroup(first, second)}:${toGroup(third, fourth)}`;
  }
  const [head, rest] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const restGroups = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = rest === undefined ? 0 : IPV6_GROUP_COUNT - headGroups.length - restGroups.length;
  return [...headGroups, ...new Array(missing).fill('0'), ...restGroups].map((group) =>
    parseInt(group, 16),
  );
}

/**
 * The network a visitor is counted under: an IPv4 address as it is, an IPv6 address by its /64,
 * because one customer holds a whole /64 and could otherwise use a new address for every request.
 * The result is itself a valid address, so counting it again changes nothing. Whatever is not an
 * address is returned unchanged.
 */
export function networkOf(address) {
  if (!net.isIPv6(address)) return address;
  const groups = ipv6Groups(address);
  const isIpv4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === IPV4_MAPPED_MARKER;
  if (isIpv4Mapped) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  const network = groups.slice(0, NETWORK_GROUP_COUNT).map((group) => group.toString(16));
  return `${network.join(':')}::`;
}

/**
 * @param {object} options
 * @param {string} options.trustedIpHeader  Lowercase header name, or '' when none is trusted.
 * @param {(event: string, fields: object) => void} [options.log]
 * @returns {(request) => string} the network the request's visitor is counted under
 */
export function createClientAddress({ trustedIpHeader, log = logEvent }) {
  let hasWarned = false;

  function warnOnceAboutProxy(request) {
    const seen = PROXY_HEADERS.find((name) => request.headers[name] !== undefined);
    if (hasWarned || seen === undefined) return;
    hasWarned = true;
    // Header names only: the values are addresses of visitors.
    log('proxy_header_not_trusted', {
      seen,
      trusted: trustedIpHeader === '' ? null : trustedIpHeader,
    });
  }

  return function clientAddress(request) {
    if (trustedIpHeader !== '') {
      const forwarded = singleHeaderValue(request.rawHeaders, trustedIpHeader);
      if (forwarded !== null && net.isIP(forwarded) !== 0) return networkOf(forwarded);
    }
    warnOnceAboutProxy(request);
    return networkOf(request.socket.remoteAddress ?? '');
  };
}
