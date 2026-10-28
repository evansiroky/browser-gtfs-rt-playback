import { BlockList, isIP } from 'node:net';

const internalRanges = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network, unspecified
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  internalRanges.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
] as const) {
  internalRanges.addSubnet(network, prefix, 'ipv6');
}

/**
 * Whether a URL hostname names an internal destination: `localhost`, a `.localhost` or
 * `.internal` name (such as `metadata.google.internal`), or a literal loopback, link-local,
 * private-range or unspecified IP address (IPv4-mapped IPv6 included). Names that resolve to such
 * addresses are not detected; this guards against redirects that name them outright.
 */
export function isInternalHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'internal') return true;
  if (host.endsWith('.internal')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  if (mapped) return internalRanges.check(mapped, 'ipv4');
  const version = isIP(host);
  if (version === 4) return internalRanges.check(host, 'ipv4');
  if (version === 6) {
    // The URL parser writes IPv4-mapped addresses in hex (`::ffff:7f00:1`).
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hexMapped?.[1] && hexMapped[2]) {
      const value = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16);
      const ipv4 = [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
      return internalRanges.check(ipv4, 'ipv4');
    }
    return internalRanges.check(host, 'ipv6');
  }
  return false;
}
