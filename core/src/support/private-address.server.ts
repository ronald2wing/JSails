/**
 * The address classifier behind `guardedFetch`. An address is private when it
 * is unspecified, loopback, link-local, private (RFC 1918), carrier-grade NAT,
 * unique local, multicast, documentation, or reserved, in IPv4 or IPv6. An
 * IPv6 address that carries an IPv4 one (IPv4-mapped, IPv4-translated,
 * IPv4-compatible, NAT64, 6to4) is judged by the IPv4 address it carries, so
 * `::ffff:10.0.0.1` is as private as `10.0.0.1`.
 *
 * It classifies IP literals only; resolving a name and pinning the connection
 * to the address that was checked is `guardedFetch`'s job.
 */

import { BlockList, isIP } from 'node:net';

const IPV4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network", including the unspecified address
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata endpoints
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including the broadcast address
];

const IPV6_BLOCKED: readonly (readonly [string, number])[] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo: the IPv4 address it tunnels to is obfuscated
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated, still routed by some stacks)
  ['ff00::', 8], // multicast
];

const blocked = new BlockList();
for (const [network, prefix] of IPV4_BLOCKED) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of IPV6_BLOCKED) blocked.addSubnet(network, prefix, 'ipv6');

/**
 * Whether `address` (an IP literal, without URL brackets) is one an outbound
 * request must not reach. Anything that is not a valid IP literal counts as private,
 * so a malformed resolver answer fails closed.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  // A zone index only exists on link-local and other scoped addresses.
  if (family !== 6 || address.includes('%')) return true;
  // `BlockList` also matches an IPv4-mapped address against the IPv4 rules.
  if (blocked.check(address, 'ipv6')) return true;
  const embedded = embeddedIpv4(address);
  return embedded !== undefined && blocked.check(embedded, 'ipv4');
}

/**
 * The IPv4 address an IPv6 address carries: IPv4-mapped (`::ffff:0:0/96`),
 * IPv4-translated (`::ffff:0:0:0/96`), IPv4-compatible (`::/96`), NAT64
 * (`64:ff9b::/96`), or 6to4 (`2002::/16`).
 */
function embeddedIpv4(address: string): string | undefined {
  const words = ipv6Words(address);
  if (words === undefined) return undefined;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  const prefixIsZero = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0;
  if (prefixIsZero && w4 === 0 && (w5 === 0 || w5 === 0xffff)) return ipv4From(w6, w7);
  if (prefixIsZero && w4 === 0xffff && w5 === 0) return ipv4From(w6, w7);
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return ipv4From(w6, w7);
  }
  if (w0 === 0x2002) return ipv4From(w1, w2);
  return undefined;
}

/** The eight 16-bit words of a valid IPv6 literal (as `isIP` accepts it). */
function ipv6Words(address: string): number[] | undefined {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [b0, b1, b2, b3] = dotted.slice(1).map(Number);
    const high = (((b0 ?? 0) << 8) | (b1 ?? 0)).toString(16);
    const low = (((b2 ?? 0) << 8) | (b3 ?? 0)).toString(16);
    text = `${text.slice(0, dotted.index)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === '' ? [] : part.split(':').map((word) => parseInt(word, 16));
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const words = [...head, ...new Array<number>(halves.length === 1 ? 0 : missing).fill(0), ...tail];
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function ipv4From(high: number | undefined, low: number | undefined): string {
  const h = high ?? 0;
  const l = low ?? 0;
  return `${h >> 8}.${h & 0xff}.${l >> 8}.${l & 0xff}`;
}

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/**
 * Whether `address` (an IP literal, without URL brackets) is a loopback
 * address: `127.0.0.0/8`, `::1`, or an IPv6 form carrying a `127.0.0.0/8`
 * address. Anything that is not a valid IP literal is not loopback.
 */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return loopback.check(address, 'ipv4');
  if (family !== 6 || address.includes('%')) return false;
  if (loopback.check(address, 'ipv6')) return true;
  const embedded = embeddedIpv4(address);
  return embedded !== undefined && loopback.check(embedded, 'ipv4');
}
