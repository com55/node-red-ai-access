/** Address validation and DNS-pinned requests for the settings Public URL Check. */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import { canonicalizeIp, validateSettingsPublicBaseUrl } from './access-path.js';

type AddressClass = 'public' | 'loopback' | 'blocked';

function isPrivateV4(a: number, b: number): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isLinkLocalV4(a: number, b: number): boolean {
  return a === 169 && b === 254;
}

function isSpecialUseV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224 ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function classifyIpv4(address: string): AddressClass {
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  if (a === 127) return 'loopback';
  const blocked =
    isPrivateV4(a, b) ||
    isLinkLocalV4(a, b) ||
    isSpecialUseV4(a, b, c) ||
    address === '168.63.129.16';
  return blocked ? 'blocked' : 'public';
}

function classifyIpv6(address: string): AddressClass {
  if (address === '::1') return 'loopback';
  // Only global unicast is eligible. This excludes ULA, link-local, unspecified,
  // multicast, NAT64 and other special-purpose address space.
  const [firstWord, secondWord] = address.split(':');
  const first = parseInt(firstWord ?? '', 16);
  const second = parseInt(secondWord ?? '0', 16);
  const blocked =
    !Number.isFinite(first) ||
    first === 0 ||
    first < 0x2000 ||
    first > 0x3fff ||
    (first === 0x2001 && second <= 0x1ff) ||
    address.startsWith('2001:db8:') ||
    address.startsWith('2002:');
  return blocked ? 'blocked' : 'public';
}

export function classifyPublicUrlAddress(host: string): AddressClass {
  const address = canonicalizeIp(host);
  if (!address) return 'blocked';
  return isIP(address) === 4 ? classifyIpv4(address) : classifyIpv6(address);
}

export function isMetadataHostname(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return [
    'metadata',
    'metadata.google.internal',
    'metadata.google.com',
    'metadata.goog',
    'instance-data',
    'instance-data.ec2.internal',
    'metadata.azure.internal',
    'metadata.aws.internal',
  ].some(blocked => name === blocked || name.endsWith(`.${blocked}`));
}

export interface PublicUrlCheckTarget {
  origin: string;
  address: string;
  family: 4 | 6;
}

/** Saving remains permissive; only Check resolves and enforces network boundaries. */
export async function preparePublicUrlCheck(
  value: unknown,
  localPort: number,
  signal: AbortSignal
): Promise<PublicUrlCheckTarget> {
  const origin = validateSettingsPublicBaseUrl(value);
  if (!origin) throw new Error('publicBaseUrl is required for Check');
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isMetadataHostname(host)) throw new Error('Public URL Check cannot target metadata hosts');
  const literal = canonicalizeIp(host);
  const local =
    host.toLowerCase().replace(/\.$/, '') === 'localhost' ||
    (literal !== undefined && classifyPublicUrlAddress(literal) === 'loopback');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (local && port !== localPort) {
    throw new Error(
      "Public URL Check may only target this Node-RED instance's port for loopback URLs"
    );
  }
  const validateAddress = (address: string): void => {
    const kind = classifyPublicUrlAddress(address);
    if (kind === 'blocked' || (kind === 'loopback' && !local) || (local && kind !== 'loopback')) {
      throw new Error('Public URL Check cannot target private or non-public addresses');
    }
  };
  if (literal) validateAddress(literal);
  const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    dns.lookup(host, { all: true }, (error, results) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(results);
    });
  });
  signal.throwIfAborted();
  if (!addresses.length) throw new Error('Public URL Check hostname has no addresses');
  for (const result of addresses) validateAddress(result.address);
  const firstAddress = addresses[0]?.address;
  if (!firstAddress) throw new Error('Public URL Check hostname has no addresses');
  const address = canonicalizeIp(firstAddress);
  if (!address) throw new Error('Public URL Check returned an invalid address');
  return { origin, address, family: isIP(address) as 4 | 6 };
}

/** Native requests never follow redirects (equivalent to redirect: 'manual'). */
export function requestPublicUrlCheck(
  target: PublicUrlCheckTarget,
  path: string,
  signal: AbortSignal
): Promise<number> {
  const url = new URL(target.origin + path);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        headers: { Host: url.host },
        ...(isIP(hostname) ? {} : { servername: hostname }),
        // Return only the vetted address; never perform another DNS resolution.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
      response => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      }
    );
    req.on('error', reject);
    req.end();
  });
}
