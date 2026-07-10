/** DNS/IP validation and connection pinning for Connect HTTP requests. */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, buildConnector, type Dispatcher } from 'undici';

export interface ResolvedAddress {
  address: string;
  family: number;
}

type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

let resolver: Resolver = async hostname =>
  dnsLookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>;

/** Test-only resolver injection; production callers never need this. */
export function setNetworkResolverForTests(next?: Resolver): void {
  if (!process.env.VITEST) {
    throw new Error('Network resolver overrides are test-only.');
  }
  resolver =
    next ??
    (async hostname =>
      dnsLookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>);
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) {
    return null;
  }
  const parts = address.split('.').map(Number);
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4In(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function parseIpv6(address: string): bigint | null {
  let input = address.toLowerCase();
  const zone = input.indexOf('%');
  if (zone >= 0) {
    input = input.slice(0, zone);
  }
  if (input.startsWith('[') && input.endsWith(']')) {
    input = input.slice(1, -1);
  }
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const v4 = ipv4Number(input.slice(lastColon + 1));
    if (v4 === null) {
      return null;
    }
    input = `${input.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) {
    return null;
  }
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function ipv6In(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

function isExplicitPrivateAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    return [
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xac100000, 12],
      [0xc0a80000, 16],
    ].some(([base, prefix]) => ipv4In(v4, base, prefix));
  }
  const v6 = parseIpv6(address);
  if (v6 === null) {
    return false;
  }
  const mapped = mappedIpv4(v6);
  if (mapped !== null) {
    const dotted = `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
    return isExplicitPrivateAddress(dotted);
  }
  return v6 === 1n || ipv6In(v6, BigInt('0xfc000000000000000000000000000000'), 7);
}

const V4_DENY: Array<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

const V6_DENY: Array<[bigint, number]> = [
  [0n, 128],
  [1n, 128],
  [BigInt('0xfc000000000000000000000000000000'), 7],
  [BigInt('0xfe800000000000000000000000000000'), 10],
  [BigInt('0xff000000000000000000000000000000'), 8],
  [BigInt('0x20010db8000000000000000000000000'), 32],
];

function mappedIpv4(value: bigint): number | null {
  if (value >> 32n !== 0xffffn) {
    return null;
  }
  return Number(value & 0xffffffffn) >>> 0;
}

/** True for non-routable, local, documentation, multicast, or reserved IPs. */
export function isForbiddenAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    return V4_DENY.some(([base, prefix]) => ipv4In(v4, base, prefix));
  }
  const v6 = parseIpv6(address);
  if (v6 === null) {
    return true;
  }
  const mapped = mappedIpv4(v6);
  if (mapped !== null) {
    return V4_DENY.some(([base, prefix]) => ipv4In(mapped, base, prefix));
  }
  return V6_DENY.some(([base, prefix]) => ipv6In(v6, base, prefix));
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google',
  'instance-data.ec2.internal',
]);
const METADATA_IPS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '169.254.170.23',
  '100.100.100.200',
  'fd00:ec2::23',
  'fd00:ec2::254',
]);

function isMetadataAddress(address: string): boolean {
  const normalized = hostnameWithoutBrackets(address).toLowerCase();
  if (METADATA_IPS.has(normalized)) {
    return true;
  }
  const v4 = ipv4Number(normalized);
  if (v4 === 0xa9fea9fe || v4 === 0xa9feaa02 || v4 === 0xa9feaa17 || v4 === 0x646464c8) {
    return true;
  }
  const v6 = parseIpv6(normalized);
  if (v6 === null) {
    return false;
  }
  const mapped = mappedIpv4(v6);
  if (
    mapped === 0xa9fea9fe ||
    mapped === 0xa9feaa02 ||
    mapped === 0xa9feaa17 ||
    mapped === 0x646464c8
  ) {
    return true;
  }
  return (
    v6 === BigInt('0xfd000000000000000000000000000023') ||
    v6 === BigInt('0xfd000000000000000000000000000254')
  );
}

export interface PinnedDestination {
  url: URL;
  addresses: ResolvedAddress[];
  dispatcher: Dispatcher;
  close(): Promise<void>;
}

/** Validate a URL, resolve it once, and return an Agent pinned to that answer. */
export async function pinHttpDestination(
  rawUrl: string,
  allowPrivateNetwork: boolean
): Promise<PinnedDestination> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported URL scheme ${url.protocol}; only http and https are permitted.`);
  }
  if (url.username || url.password) {
    throw new Error('URLs containing user-info credentials are not permitted.');
  }

  const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.includes('%')) {
    throw new Error('Malformed or zone-scoped hostname.');
  }
  if (METADATA_HOSTS.has(hostname)) {
    throw new Error('Cloud metadata destinations are never permitted.');
  }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    if (!allowPrivateNetwork) {
      throw new Error(`Private hostname '${hostname}' requires an explicit control-plane grant.`);
    }
  }

  let addresses: ResolvedAddress[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    addresses = await resolver(hostname);
  }
  if (addresses.length === 0) {
    throw new Error(`DNS returned no addresses for '${hostname}'.`);
  }

  for (const answer of addresses) {
    const normalized = hostnameWithoutBrackets(answer.address).toLowerCase();
    if (isMetadataAddress(normalized)) {
      throw new Error('Cloud metadata addresses are never permitted.');
    }
    if (isForbiddenAddress(normalized)) {
      if (!allowPrivateNetwork || !isExplicitPrivateAddress(normalized)) {
        throw new Error(`Destination '${hostname}' resolved to a private or reserved address.`);
      }
    }
  }

  // Every answer was validated. Pin one address into the socket connector so
  // the request cannot perform a second, attacker-controlled DNS lookup.
  const pinned = addresses[0].address;
  const connect = buildConnector({});
  const agent = new Agent({
    connect(options, callback) {
      connect(
        {
          ...options,
          hostname: pinned,
          host: pinned,
          servername: hostname,
        },
        callback
      );
    },
    maxRedirections: 0,
  });

  return {
    url,
    addresses,
    dispatcher: agent,
    close: async () => agent.close(),
  };
}
